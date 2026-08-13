/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type * as ort from 'onnxruntime-node';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { BpeTokenizer, TokenizerJson } from './bpeTokenizer';
import { WordPieceTokenizer } from './wordPieceTokenizer';
import { DEFAULT_LOCAL_EMBEDDING_MODEL, LocalEmbeddingModel } from './model';

const DEFAULT_BATCH_SIZE = 16;

export interface ModelManagerState {
	readonly status: 'not-downloaded' | 'downloading' | 'ready' | 'error';
	readonly modelId: string;
	readonly downloadedBytes: number;
	readonly totalBytes: number | undefined;
	readonly lastError: string | undefined;
}

/**
 * Downloads, verifies and hosts the local ONNX embedding model.
 *
 * - Model files are cached under `<globalStorageUri>/models/<id>/` and reused
 *   across restarts (keyed by `model.id`, which is also the `EmbeddingType.id`).
 * - Each artifact is SHA-256 verified before it is used; a mismatch is a hard
 *   error (fail closed).
 * - `InferenceSession` is created lazily on first `embed` call.
 * - `embed` batches, truncates to `model.maxTokens`, mean-pools the hidden
 *   states and L2-normalizes, so it works across ONNX exports that emit
 *   `last_hidden_state` as well as ones that pre-pool.
 */
export class ModelManager extends Disposable {
	private readonly _modelDir: string;
	private readonly _modelPath: string;
	private readonly _tokenizerPath: string;

	private _session: ort.InferenceSession | undefined;
	private _tokenizer: { encode(text: string): number[]; vocabSize(): number; unkId(): number } | undefined;
	private _downloadedBytes = 0;
	private _totalBytes: number | undefined;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		private readonly _model: LocalEmbeddingModel = DEFAULT_LOCAL_EMBEDDING_MODEL,
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._modelDir = path.join(this._context.globalStorageUri.fsPath, 'models', this._model.id);
		this._modelPath = path.join(this._modelDir, 'model.onnx');
		this._tokenizerPath = path.join(this._modelDir, 'tokenizer.json');
	}

	get id(): string {
		return this._model.id;
	}

	get dimensions(): number {
		return this._model.dimensions;
	}

	getState(): ModelManagerState {
		if (this._session) {
			return { status: 'ready', modelId: this._model.id, downloadedBytes: this._downloadedBytes, totalBytes: this._totalBytes, lastError: undefined };
		}
		const modelExists = fs.existsSync(this._modelPath) && fs.existsSync(this._tokenizerPath);
		if (modelExists) {
			return { status: 'ready', modelId: this._model.id, downloadedBytes: this._downloadedBytes, totalBytes: this._totalBytes, lastError: undefined };
		}
		return { status: this._downloadedBytes > 0 ? 'downloading' : 'not-downloaded', modelId: this._model.id, downloadedBytes: this._downloadedBytes, totalBytes: this._totalBytes, lastError: undefined };
	}

	async ensureReady(token: CancellationToken): Promise<void> {
		await this._ensureDownloaded(token);
		await this._load(token);
	}

	/**
	 * Computes embeddings for the given texts. Returns one normalized vector
	 * per input. Throws if the model could not be loaded.
	 */
	async embed(texts: readonly string[], token: CancellationToken): Promise<Float32Array[]> {
		if (texts.length === 0) {
			return [];
		}
		await this.ensureReady(token);
		const session = this._session!;
		const tokenizer = this._tokenizer!;

		const encoded = texts.map(text => tokenizer.encode(text).slice(0, this._model.maxTokens));
		const maxLen = Math.min(this._model.maxTokens, Math.max(1, ...encoded.map(ids => ids.length)));

		const results: Float32Array[] = [];
		for (let offset = 0; offset < texts.length; offset += DEFAULT_BATCH_SIZE) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			const batch = encoded.slice(offset, offset + DEFAULT_BATCH_SIZE);

			const inputIds = new BigInt64Array(batch.length * maxLen);
			const attentionMask = new BigInt64Array(batch.length * maxLen);
			for (let i = 0; i < batch.length; i++) {
				const ids = batch[i];
				for (let j = 0; j < ids.length; j++) {
					inputIds[i * maxLen + j] = BigInt(ids[j]);
					attentionMask[i * maxLen + j] = 1n;
				}
			}
			// Single-sequence models (bge-small-en-v1.5) still require a
			// `token_type_ids` input; all-zero for a single sequence.
			const tokenTypeIds = new BigInt64Array(batch.length * maxLen);

			const { Tensor } = await import('onnxruntime-node');
			const feeds: Record<string, ort.Tensor> = {
				input_ids: new Tensor('int64', inputIds, [batch.length, maxLen]),
				attention_mask: new Tensor('int64', attentionMask, [batch.length, maxLen]),
				token_type_ids: new Tensor('int64', tokenTypeIds, [batch.length, maxLen]),
			};
			const outputs = await session.run(feeds);
			const vectors = this._extractVectors(outputs, batch.length, maxLen);
			results.push(...vectors);
		}
		return results;
	}

	async clearCache(): Promise<void> {
		this._session?.release();
		this._session = undefined;
		this._tokenizer = undefined;
		if (fs.existsSync(this._modelDir)) {
			await fs.promises.rm(this._modelDir, { recursive: true, force: true });
		}
		this._onDidChangeState.fire();
	}

	override dispose(): void {
		try {
			this._session?.release();
		} catch {
			// ignore
		}
		this._session = undefined;
		super.dispose();
	}

	private async _ensureDownloaded(token: CancellationToken): Promise<void> {
		if (fs.existsSync(this._modelPath) && fs.existsSync(this._tokenizerPath)) {
			return;
		}
		await fs.promises.mkdir(this._modelDir, { recursive: true });
		await Promise.all([
			this._download(this._model.modelUrl, this._modelPath, this._model.modelSha256, token),
			this._download(this._model.tokenizerUrl, this._tokenizerPath, this._model.tokenizerSha256, token),
		]);
		this._onDidChangeState.fire();
	}

	private async _download(url: string, destPath: string, expectedSha256: string, token: CancellationToken): Promise<void> {
		if (fs.existsSync(destPath)) {
			// Existing cached file: verify (fail closed on mismatch).
			const actual = await this._sha256OfFile(destPath);
			if (expectedSha256 && actual !== expectedSha256) {
				await fs.promises.rm(destPath, { force: true });
				throw new Error(`Local model cache verification failed for ${destPath}`);
			}
			return;
		}

		this._logService.info(`ModelManager: downloading ${url}`);
		const response = await this._fetcherService.fetch(url, { method: 'GET', callSite: 'nika-local-model' });
		if (!response.ok) {
			throw new Error(`ModelManager: download failed with HTTP ${response.status} for ${url}`);
		}
		const contentLength = response.headers.get('content-length');
		this._totalBytes = contentLength ? Number(contentLength) : undefined;
		this._downloadedBytes = 0;

		const tmpPath = `${destPath}.tmp`;
		const hash = crypto.createHash('sha256');
		const handle = await fs.promises.open(tmpPath, 'w');
		try {
			for await (const chunk of response.body) {
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
				hash.update(chunk);
				this._downloadedBytes += chunk.length;
				await handle.write(chunk);
			}
		} finally {
			await handle.close();
		}

		const actual = hash.digest('hex');
		if (expectedSha256 && actual !== expectedSha256) {
			await fs.promises.rm(tmpPath, { force: true });
			throw new Error(`ModelManager: SHA-256 mismatch for ${url} (expected ${expectedSha256}, got ${actual})`);
		}
		await fs.promises.rename(tmpPath, destPath);
		this._logService.info(`ModelManager: downloaded ${destPath}`);
	}

	private async _load(token: CancellationToken): Promise<void> {
		if (this._session && this._tokenizer) {
			return;
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		const tokenizerJson = JSON.parse(await fs.promises.readFile(this._tokenizerPath, 'utf8')) as TokenizerJson;
		// bge-small-en-v1.5 ships a WordPiece tokenizer; other BERT-family
		// models may ship BPE. Dispatch on the model type from tokenizer.json.
		this._tokenizer = tokenizerJson.model?.type === 'WordPiece'
			? new WordPieceTokenizer(tokenizerJson)
			: new BpeTokenizer(tokenizerJson);
		this._logService.info(`ModelManager: loaded tokenizer with vocab size ${this._tokenizer.vocabSize()}`);

		const { InferenceSession } = await import('onnxruntime-node');
		this._session = await InferenceSession.create(this._modelPath);
		this._onDidChangeState.fire();
	}

	private _extractVectors(outputs: Record<string, ort.Tensor>, batchSize: number, maxLen: number): Float32Array[] {
		// Prefer a pooled output name; fall back to last_hidden_state + mean pool.
		const pooledName = Object.keys(outputs).find(name => name === 'sentence_embedding' || name === 'dense_vecs' || name === 'embeddings');
		if (pooledName) {
			const data = outputs[pooledName].data as Float32Array;
			const dims = outputs[pooledName].dims;
			const hidden = dims[dims.length - 1];
			return this._toRows(data, batchSize, hidden);
		}

		const hidden = outputs.last_hidden_state ?? outputs[Object.keys(outputs)[0]];
		if (!hidden) {
			throw new Error('ModelManager: model produced no usable output');
		}
		const data = hidden.data as Float32Array;
		const dims = hidden.dims;
		// dims: [batch, seq, hidden]
		const seqLen = dims[dims.length - 2];
		const hiddenSize = dims[dims.length - 1];

		const vectors: Float32Array[] = [];
		for (let i = 0; i < batchSize; i++) {
			const vector = new Float32Array(hiddenSize);
			// Mean pooling over the (padded) sequence with the attention mask.
			let count = 0;
			for (let s = 0; s < seqLen; s++) {
				const within = s < maxLen;
				if (!within) {
					continue;
				}
				const rowOffset = (i * seqLen + s) * hiddenSize;
				for (let h = 0; h < hiddenSize; h++) {
					vector[h] += data[rowOffset + h];
				}
				count++;
			}
			if (count > 0) {
				for (let h = 0; h < hiddenSize; h++) {
					vector[h] /= count;
				}
			}
			vectors.push(normalize(vector));
		}
		return vectors;
	}

	private _toRows(data: Float32Array, rows: number, cols: number): Float32Array[] {
		const out: Float32Array[] = [];
		for (let i = 0; i < rows; i++) {
			out.push(normalize(data.subarray(i * cols, (i + 1) * cols)));
		}
		return out;
	}

	private async _sha256OfFile(filePath: string): Promise<string> {
		const hash = crypto.createHash('sha256');
		const data = await fs.promises.readFile(filePath);
		hash.update(data);
		return hash.digest('hex');
	}
}

function normalize(vector: Float32Array): Float32Array {
	let norm = 0;
	for (let i = 0; i < vector.length; i++) {
		norm += vector[i] * vector[i];
	}
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let i = 0; i < vector.length; i++) {
			vector[i] /= norm;
		}
	}
	return vector;
}
