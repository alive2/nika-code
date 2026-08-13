/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { coalesce } from '../../../../util/vs/base/common/arrays';
import { Limiter, raceCancellationError } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../../util/vs/base/common/errors';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { Schemas } from '../../../../util/vs/base/common/network';
import { basename } from '../../../../util/vs/base/common/resources';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { INaiveChunkingService } from '../../../chunking/node/naiveChunkerService';
import { FileChunkAndScore } from '../../../chunking/common/chunk';
import { LOCAL_EMBEDDING_TYPE, LocalEmbeddingsComputer } from '../../../embeddings/local/localEmbeddingsComputer';
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from '../../../embeddings/local/model';
import { ModelManager } from '../../../embeddings/local/modelManager';
import { IVSCodeExtensionContext } from '../../../extContext/common/extensionContext';
import { ILogService } from '../../../log/common/logService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { TokenizationEndpoint } from '../../../tokenizer/node/tokenizer';
import { TokenizerType } from '../../../../util/common/tokenizer';
import { IWorkspaceService } from '../../../workspace/common/workspaceService';
import { IIndexingScheme, IndexingSchemeId, IndexingState, IndexingStatus } from '../../common/indexingScheme';
import { StrategySearchResult } from '../../common/workspaceChunkSearch';
import { IWorkspaceFileIndex } from '../workspaceFileIndex';
import { LocalChunkRecord, LocalVectorStore } from './localVectorStore';

const GIT_HASH_BATCH_SIZE = 500;
const EMBED_CONCURRENCY = 8;
const MAX_LOCAL_CHUNK_TOKENS = 128;
const MAX_INDEXABLE_FILE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB (matches WorkspaceFileIndex)

/**
 * `local` indexing scheme: fully offline, ONNX embeddings + node:sqlite ANN.
 *
 * Incremental via git blob hashes (git hash-object), which is the same change
 * detection Cursor's Merkle tree gives us — with zero new hashing infra.
 */
export class LocalChunkSearch extends Disposable implements IIndexingScheme {
	declare readonly _serviceBrand: undefined;

	readonly id: IndexingSchemeId = 'local';

	private readonly _modelManager: ModelManager;
	private readonly _embeddingsComputer: LocalEmbeddingsComputer;
	private readonly _vectorStore: LocalVectorStore;
	private readonly _chunkingEndpoint: TokenizationEndpoint = { tokenizer: TokenizerType.O200K };

	private _status: IndexingStatus = 'idle';
	private _filesIndexed = 0;
	private _totalFiles = 0;
	private _lastError: string | undefined;
	private _statusMessage: string | undefined;
	private _buildPromise: Promise<void> | undefined;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkspaceFileIndex private readonly _workspaceFileIndex: IWorkspaceFileIndex,
		@ILogService private readonly _logService: ILogService,
		@INaiveChunkingService private readonly _naiveChunkingService: INaiveChunkingService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();
		this._modelManager = this._register(this._instantiationService.createInstance(ModelManager, DEFAULT_LOCAL_EMBEDDING_MODEL));
		this._embeddingsComputer = new LocalEmbeddingsComputer(this._modelManager);
		this._vectorStore = this._register(new LocalVectorStore(this._dbPath(), LOCAL_EMBEDDING_TYPE));
		this._register(this._vectorStore.onDidChange(() => this._fireStateChange()));
	}

	async getState(): Promise<IndexingState> {
		const stats = await this._vectorStore.getStats();
		// A completed build persists in the SQLite store across sessions, but
		// `_status` is in-memory and resets to 'idle' on reload. When the scheme
		// is idle but an index already exists on disk, report `synced` so the UI
		// doesn't claim the index is off when it is actually built.
		const status = this._status === 'idle' && stats.files > 0 ? 'synced' : this._status;
		return {
			status,
			indexedFileCount: status === 'indexing' || status === 'building' ? this._filesIndexed : stats.files,
			totalFileCount: status === 'indexing' || status === 'building' ? this._totalFiles : stats.files,
			lastError: this._lastError,
			message: this._statusMessage,
		};
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async build(onProgress: (message: string) => void, token: CancellationToken): Promise<void> {
		if (this._buildPromise) {
			return this._buildPromise;
		}
		this._buildPromise = this._doBuild(onProgress, token).finally(() => {
			this._buildPromise = undefined;
		});
		return this._buildPromise;
	}

	async search(queryText: string, topK: number, token: CancellationToken): Promise<StrategySearchResult> {
		const searchStart = Date.now();
		const queryEmbedding = (await this._modelManager.embed([queryText], token)).at(0);
		if (!queryEmbedding) {
			return { chunks: [] };
		}
		const hits = await this._vectorStore.search(queryEmbedding, topK, token);
		const chunks = coalesce(await Promise.all(hits.map(async hit => {
			const text = await this._readChunkText(hit.record);
			if (!text) {
				return undefined;
			}
			const fileChunk = {
				text,
				rawText: text,
				file: hit.record.uri,
				range: hit.record.range,
				isFullFile: false,
			};
			const entry: FileChunkAndScore = {
				chunk: fileChunk,
				distance: { embeddingType: LOCAL_EMBEDDING_TYPE, value: hit.score },
			};
			return entry;
		})));
		this._telemetryService.sendTelemetryEvent('nika.indexing.search', { github: true, microsoft: true }, undefined, {
			hits: chunks.length,
			durationMs: Date.now() - searchStart,
		});
		return { chunks };
	}

	async clear(): Promise<void> {
		await this._vectorStore.clear();
		this._status = 'idle';
		this._lastError = undefined;
		this._statusMessage = undefined;
		this._fireStateChange();
	}

	async clearModelCache(): Promise<void> {
		await this._modelManager.clearCache();
		this._statusMessage = undefined;
		this._fireStateChange();
	}

	private async _doBuild(onProgress: (message: string) => void, token: CancellationToken): Promise<void> {
		this._status = 'building';
		this._lastError = undefined;
		this._statusMessage = undefined;
		this._fireStateChange();
		const buildStart = Date.now();

		try {
			// 1. Learn the workspace file set up front so the status card can
			//    show "0 / N" while the (potentially large) model download runs,
			//    instead of a frozen "0 / 0".
			await raceCancellationError(this._workspaceFileIndex.initialize(), token);
			const files = Array.from(this._workspaceFileIndex.values());
			this._totalFiles = files.length;
			this._filesIndexed = 0;
			this._fireStateChange();

			// 2. Ensure the embedding model is downloaded and ready. The status
			//    message tells the user what phase the build is in.
			const modelState = this._modelManager.getState();
			if (modelState.status === 'not-downloaded') {
				this._statusMessage = 'Downloading embedding model...';
				onProgress('Downloading embedding model...');
			} else if (modelState.status === 'downloading') {
				this._statusMessage = 'Finishing embedding model download...';
				onProgress('Finishing embedding model download...');
			}
			this._fireStateChange();
			await raceCancellationError(this._modelManager.ensureReady(token), token);
			this._statusMessage = 'Embedding workspace files...';
			onProgress('Indexing workspace files...');
			this._fireStateChange();

			const storedHashes = await this._vectorStore.getFileHashes();
			const gitHashes = await this._computeGitHashes(files.map(file => file.uri), token);

			const workspaceRoot = this._workspaceRoot();
			const limiter = new Limiter<boolean | undefined>(EMBED_CONCURRENCY);

			const tasks: Array<Promise<boolean | undefined>> = [];
			for (const file of files) {
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
				const uri = file.uri;
				if (uri.scheme !== Schemas.file) {
					continue;
				}
				const hash = gitHashes.get(uri.toString());
				if (hash === undefined) {
					continue;
				}
				if (storedHashes.get(uri.toString()) === hash) {
					this._filesIndexed++;
					continue;
				}
				tasks.push(limiter.queue(() => this._reindexFile(file.uri, hash, workspaceRoot, token)));
			}

			const results = await Promise.all(tasks);
			this._filesIndexed = results.filter(Boolean).length + files.length - tasks.length;

			// Remove files that are no longer in the workspace index.
			const currentUris = new Set(files.map(file => file.uri.toString()));
			for (const uri of storedHashes.keys()) {
				if (!currentUris.has(uri)) {
					await this._vectorStore.removeFile(URI.parse(uri));
				}
			}

			this._status = 'synced';
			this._statusMessage = undefined;
			this._logService.info(`LocalChunkSearch: build complete, ${this._filesIndexed}/${this._totalFiles} files indexed`);
			this._telemetryService.sendTelemetryEvent('nika.indexing.build', { github: true, microsoft: true }, { success: 'true' }, {
				files: this._filesIndexed,
				total: this._totalFiles,
				durationMs: Date.now() - buildStart,
			});
		} catch (error) {
			this._status = 'error';
			this._lastError = error instanceof Error ? error.message : String(error);
			this._statusMessage = undefined;
			this._logService.error(error, 'LocalChunkSearch: build failed');
			this._telemetryService.sendTelemetryEvent('nika.indexing.build', { github: true, microsoft: true }, { success: 'false' }, {
				files: this._filesIndexed,
				total: this._totalFiles,
				durationMs: Date.now() - buildStart,
			});
			throw error;
		} finally {
			this._fireStateChange();
		}
	}

	private async _reindexFile(uri: URI, hash: string, workspaceRoot: URI | undefined, token: CancellationToken): Promise<boolean | undefined> {
		try {
			const text = await this._workspaceFileIndex.tryRead(uri);
			if (text === undefined || text.length > MAX_INDEXABLE_FILE_BYTES) {
				return undefined;
			}
			const chunks = await this._naiveChunkingService.chunkFile(
				this._chunkingEndpoint,
				uri,
				text,
				{ maxTokenLength: MAX_LOCAL_CHUNK_TOKENS },
				token,
			);
			if (chunks.length === 0) {
				return undefined;
			}
			const embeddings = await this._embeddingsComputer.computeEmbeddings(
				LOCAL_EMBEDDING_TYPE,
				chunks.map(chunk => chunk.text),
				{ inputType: 'document' },
				undefined,
				token,
			);
			if (embeddings.values.length !== chunks.length) {
				this._logService.warn(`LocalChunkSearch: embedding count mismatch for ${uri.toString()}`);
				return undefined;
			}
			const relPath = workspaceRoot ? (path.relative(workspaceRoot.fsPath, uri.fsPath) || basename(uri)) : basename(uri);
			await this._vectorStore.upsertFile(relPath, uri, chunks.map((chunk, index) => ({
				range: chunk.range,
				hash,
				embedding: new Float32Array(embeddings.values[index].value),
			})));
			this._filesIndexed++;
			if (this._filesIndexed % 25 === 0) {
				this._fireStateChange();
			}
			return true;
		} catch (error) {
			if (token.isCancellationRequested) {
				throw error;
			}
			this._logService.warn(`LocalChunkSearch: failed to index ${uri.toString()}: ${String(error)}`);
			return undefined;
		}
	}

	private async _computeGitHashes(uris: readonly URI[], token: CancellationToken): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		const gitRoot = this._workspaceRoot();
		if (!gitRoot) {
			return result;
		}
		for (let i = 0; i < uris.length; i += GIT_HASH_BATCH_SIZE) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			const batch = uris.slice(i, i + GIT_HASH_BATCH_SIZE);
			const hashes = await this._gitHashBatch(batch);
			for (let j = 0; j < batch.length; j++) {
				const hash = hashes[j];
				if (hash) {
					result.set(batch[j].toString(), hash);
				}
			}
		}
		return result;
	}

	private async _gitHashBatch(uris: readonly URI[]): Promise<Array<string | undefined>> {
		const gitRoot = this._workspaceRoot();
		if (!gitRoot) {
			return uris.map(() => undefined);
		}
		try {
			// git hash-object --stdin-paths reads paths (one per line) from
			// stdin and prints the blob hash for each, in order. NOTE: the
			// `input` option does NOT work with async `execFile` (it is only
			// honored by execFileSync/spawnSync) — using it would leave the
			// child waiting on stdin forever. We must spawn with a piped stdin
			// and write/end it ourselves.
			const paths = uris.map(uri => uri.fsPath).join('\n') + '\n';
			const hashes: Array<string | undefined> = await new Promise((resolve, reject) => {
				const child = spawn('git', ['hash-object', '--stdin-paths'], {
					cwd: gitRoot.fsPath,
				});
				let stdout = '';
				let stderr = '';
				child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
				child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
				child.on('error', reject);
				child.on('close', code => {
					if (code !== 0) {
						reject(new Error(`git hash-object exited with ${code}: ${stderr.trim()}`));
						return;
					}
					const lines = stdout.split(/\r?\n/).filter(line => line.length > 0);
					const result: Array<string | undefined> = [];
					for (let i = 0; i < uris.length; i++) {
						result.push(lines[i]?.trim() || undefined);
					}
					resolve(result);
				});
				child.stdin.write(paths);
				child.stdin.end();
			});
			return hashes;
		} catch (error) {
			// Not a git repo (or git unavailable): fall back to content SHA-256.
			this._logService.trace(`LocalChunkSearch: git hash-object unavailable, falling back to SHA-256: ${String(error)}`);
			return Promise.all(uris.map(async uri => {
				try {
					const data = await fs.promises.readFile(uri.fsPath);
					return crypto.createHash('sha256').update(data).digest('hex');
				} catch {
					return undefined;
				}
			}));
		}
	}

	private async _readChunkText(record: LocalChunkRecord): Promise<string | undefined> {
		const text = await this._workspaceFileIndex.tryRead(record.uri);
		if (text === undefined) {
			return undefined;
		}
		const lines = text.split(/\r?\n/);
		const start = record.range.startLineNumber - 1;
		const end = Math.min(record.range.endLineNumber, lines.length);
		if (start < 0 || start >= end) {
			return undefined;
		}
		return lines.slice(start, end).join('\n');
	}

	private _workspaceRoot(): URI | undefined {
		return this._workspaceService.getWorkspaceFolders()[0];
	}

	private _dbPath(): string {
		const hash = crypto.createHash('sha256').update(this._workspaceHashSeed()).digest('hex').slice(0, 16);
		return path.join(this._context.storageUri?.fsPath ?? this._context.globalStorageUri.fsPath, 'indexing', hash, 'index.sqlite');
	}

	private _workspaceHashSeed(): string {
		return this._workspaceRoot()?.fsPath ?? this._context.globalStorageUri.fsPath;
	}

	private _fireStateChange(): void {
		this._onDidChangeState.fire();
	}
}
