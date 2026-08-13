/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import sql from 'node:sqlite';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { Range } from '../../../../util/vs/editor/common/core/range';
import { packEmbedding } from '../../../embeddings/common/embeddingsStorage';
import { EmbeddingType } from '../../../embeddings/common/embeddingsComputer';

export interface LocalChunkRecord {
	readonly uri: URI;
	readonly relPath: string;
	readonly range: Range;
	readonly hash: string;
	readonly embedding: Float32Array;
}

export interface LocalStoreStats {
	readonly files: number;
	readonly chunks: number;
}

export interface LocalHit {
	readonly record: LocalChunkRecord;
	readonly score: number;
}

export const INDEX_VERSION = '1';

/**
 * Local ANN store for the `local` indexing scheme, backed by `node:sqlite`
 * (already used by `workspaceChunkAndEmbeddingCache.ts` — no new native dep).
 *
 * Embeddings are stored as f32 LE BLOBs. Search is an exact cosine scan over
 * the `embedding` column — fine for tens of thousands of chunks. The upgrade
 * path to an IVFFlat/ANN index is documented in `docs/INDEXING-DESIGN.md` and
 * would replace only the `search` implementation (the schema stays).
 */
export class LocalVectorStore extends Disposable {
	private readonly _db: sql.DatabaseSync;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		dbPath: string,
		private readonly _embeddingType: EmbeddingType,
	) {
		super();
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this._db = new sql.DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true });
		this._db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS chunks(
				path TEXT NOT NULL,
				rel_path TEXT NOT NULL,
				start INT NOT NULL,
				"end" INT NOT NULL,
				hash TEXT NOT NULL,
				embedding BLOB NOT NULL,
				model TEXT NOT NULL,
				PRIMARY KEY(path, start, "end")
			);
			CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
		`);
		this._migrate();
	}

	getMeta(key: string): string | undefined {
		const row = this._db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
		return row?.value;
	}

	setMeta(key: string, value: string): void {
		this._db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
	}

	async upsertFile(relPath: string, uri: URI, chunks: ReadonlyArray<{ range: Range; hash: string; embedding: Float32Array }>): Promise<void> {
		const uriString = uri.toString();
		this._db.exec('BEGIN');
		try {
			this._db.prepare('DELETE FROM chunks WHERE path = ?').run(uriString);
			const insert = this._db.prepare('INSERT INTO chunks(path, rel_path, start, "end", hash, embedding, model) VALUES (?, ?, ?, ?, ?, ?, ?)');
			for (const chunk of chunks) {
				insert.run(
					uriString,
					relPath,
					chunk.range.startLineNumber,
					chunk.range.endLineNumber,
					chunk.hash,
					Buffer.from(packEmbedding({ type: this._embeddingType, value: Array.from(chunk.embedding) }).buffer),
					this._embeddingType.id,
				);
			}
			this._db.exec('COMMIT');
		} catch (error) {
			this._db.exec('ROLLBACK');
			throw error;
		}
		this._onDidChange.fire();
	}

	async removeFile(uri: URI): Promise<void> {
		this._db.prepare('DELETE FROM chunks WHERE path = ?').run(uri.toString());
		this._onDidChange.fire();
	}

	async getFile(uri: URI): Promise<LocalChunkRecord[] | undefined> {
		const rows = this._db.prepare('SELECT path, rel_path, start, "end", hash, embedding FROM chunks WHERE path = ? ORDER BY start').all(uri.toString()) as Array<{
			path: string; rel_path: string; start: number; end: number; hash: string; embedding: Uint8Array;
		}>;
		if (!rows.length) {
			return undefined;
		}
		return rows.map(row => this._toRecord(row));
	}

	async getFileHashes(): Promise<Map<string, string>> {
		const rows = this._db.prepare('SELECT path, hash FROM chunks').all() as Array<{ path: string; hash: string }>;
		const map = new Map<string, string>();
		for (const row of rows) {
			const existing = map.get(row.path);
			if (!existing || existing.length < row.hash.length) {
				map.set(row.path, row.hash);
			}
		}
		return map;
	}

	async search(queryEmbedding: Float32Array, topK: number, token: CancellationToken): Promise<LocalHit[]> {
		const rows = this._db.prepare('SELECT path, rel_path, start, "end", hash, embedding FROM chunks').all() as Array<{
			path: string; rel_path: string; start: number; end: number; hash: string; embedding: Uint8Array;
		}>;

		// Exact cosine scan. Vectors are L2-normalized at embed time, so
		// cosine == dot product. Track a running top-K to bound memory.
		const heap: Array<{ score: number; row: typeof rows[number] }> = [];
		for (let i = 0; i < rows.length; i++) {
			if (token.isCancellationRequested) {
				return heap.map(entry => ({ record: this._toRecord(entry.row), score: entry.score }));
			}
			const embedding = new Float32Array(rows[i].embedding.buffer, rows[i].embedding.byteOffset, rows[i].embedding.byteLength / 4);
			let score = 0;
			const len = Math.min(embedding.length, queryEmbedding.length);
			for (let j = 0; j < len; j++) {
				score += embedding[j] * queryEmbedding[j];
			}
			if (heap.length < topK) {
				heap.push({ score, row: rows[i] });
				heap.sort((a, b) => b.score - a.score);
			} else if (score > heap[heap.length - 1].score) {
				heap[heap.length - 1] = { score, row: rows[i] };
				heap.sort((a, b) => b.score - a.score);
			}
		}
		return heap.map(entry => ({ record: this._toRecord(entry.row), score: entry.score }));
	}

	async getStats(): Promise<LocalStoreStats> {
		const files = this._db.prepare('SELECT COUNT(DISTINCT path) AS c FROM chunks').get() as { c: number };
		const chunks = this._db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number };
		return { files: files.c, chunks: chunks.c };
	}

	async clear(): Promise<void> {
		this._db.exec('DELETE FROM chunks; DELETE FROM meta;');
		this._onDidChange.fire();
	}

	override dispose(): void {
		try {
			this._db.close();
		} catch {
			// ignore
		}
		super.dispose();
	}

	private _migrate(): void {
		const version = this.getMeta('index_version');
		if (version !== INDEX_VERSION) {
			this.setMeta('index_version', INDEX_VERSION);
		}
	}

	private _toRecord(row: { path: string; rel_path: string; start: number; end: number; hash: string; embedding: Uint8Array }): LocalChunkRecord {
		const embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
		return {
			uri: URI.parse(row.path),
			relPath: row.rel_path,
			range: new Range(row.start, 1, row.end, 1),
			hash: row.hash,
			embedding,
		};
	}
}
