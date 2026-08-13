/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'vitest';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { Range } from '../../../../util/vs/editor/common/core/range';
import { EmbeddingType } from '../../../embeddings/common/embeddingsComputer';
import { LocalVectorStore } from './localVectorStore';

const EMBEDDING_TYPE = EmbeddingType.nikaLocalBgeSmallEnV15;

function makeChunk(start: number, end: number, embedding: number[]): { range: Range; hash: string; embedding: Float32Array } {
	return {
		range: new Range(start, 1, end, 1),
		hash: `hash-${start}`,
		embedding: new Float32Array(embedding),
	};
}

suite('LocalVectorStore', function () {
	test('upsert + getFile round-trips chunks', async function () {
		const store = new LocalVectorStore(':memory:', EMBEDDING_TYPE);
		try {
			const uri = URI.parse('file:///workspace/src/foo.ts');
			await store.upsertFile('src/foo.ts', uri, [
				makeChunk(1, 5, [1, 0, 0, 0]),
				makeChunk(6, 10, [0, 1, 0, 0]),
			]);

			const records = await store.getFile(uri);
			assert.ok(records);
			assert.strictEqual(records!.length, 2);
			assert.strictEqual(records![0].relPath, 'src/foo.ts');
			assert.strictEqual(records![0].hash, 'hash-1');
			assert.deepStrictEqual(Array.from(records![0].embedding), [1, 0, 0, 0]);
			assert.strictEqual(records![1].range.endLineNumber, 10);
		} finally {
			store.dispose();
		}
	});

	test('upsertFile replaces existing chunks for the same file', async function () {
		const store = new LocalVectorStore(':memory:', EMBEDDING_TYPE);
		try {
			const uri = URI.parse('file:///workspace/src/foo.ts');
			await store.upsertFile('src/foo.ts', uri, [makeChunk(1, 5, [1, 0, 0, 0])]);
			await store.upsertFile('src/foo.ts', uri, [makeChunk(1, 5, [1, 0, 0, 0]), makeChunk(7, 9, [0, 1, 0, 0])]);

			const records = await store.getFile(uri);
			assert.strictEqual(records!.length, 2);
		} finally {
			store.dispose();
		}
	});

	test('search ranks by cosine similarity', async function () {
		const store = new LocalVectorStore(':memory:', EMBEDDING_TYPE);
		try {
			const uri = URI.parse('file:///workspace/src/foo.ts');
			await store.upsertFile('src/foo.ts', uri, [
				makeChunk(1, 5, [1, 0, 0, 0]),
				makeChunk(6, 10, [0, 1, 0, 0]),
				makeChunk(11, 15, [0, 0, 1, 0]),
			]);

			const hits = await store.search(new Float32Array([0, 1, 0, 0]), 2, CancellationToken.None);
			assert.strictEqual(hits.length, 2);
			assert.strictEqual(hits[0].record.hash, 'hash-6');
			assert.ok(hits[0].score > hits[1].score);
		} finally {
			store.dispose();
		}
	});

	test('removeFile deletes only the target file', async function () {
		const store = new LocalVectorStore(':memory:', EMBEDDING_TYPE);
		try {
			const a = URI.parse('file:///workspace/src/a.ts');
			const b = URI.parse('file:///workspace/src/b.ts');
			await store.upsertFile('src/a.ts', a, [makeChunk(1, 2, [1, 0, 0, 0])]);
			await store.upsertFile('src/b.ts', b, [makeChunk(1, 2, [0, 1, 0, 0])]);

			await store.removeFile(a);
			assert.strictEqual(await store.getFile(a), undefined);
			assert.ok(await store.getFile(b));
		} finally {
			store.dispose();
		}
	});

	test('getFileHashes returns the latest hash per file', async function () {
		const store = new LocalVectorStore(':memory:', EMBEDDING_TYPE);
		try {
			const uri = URI.parse('file:///workspace/src/foo.ts');
			await store.upsertFile('src/foo.ts', uri, [makeChunk(1, 5, [1, 0, 0, 0])]);
			const hashes = await store.getFileHashes();
			assert.strictEqual(hashes.get(uri.toString()), 'hash-1');
		} finally {
			store.dispose();
		}
	});

	test('getStats counts files and chunks', async function () {
		const store = new LocalVectorStore(':memory:', EMBEDDING_TYPE);
		try {
			const a = URI.parse('file:///workspace/src/a.ts');
			const b = URI.parse('file:///workspace/src/b.ts');
			await store.upsertFile('src/a.ts', a, [makeChunk(1, 2, [1, 0, 0, 0]), makeChunk(3, 4, [0, 1, 0, 0])]);
			await store.upsertFile('src/b.ts', b, [makeChunk(1, 2, [0, 0, 1, 0])]);

			const stats = await store.getStats();
			assert.deepStrictEqual(stats, { files: 2, chunks: 3 });
		} finally {
			store.dispose();
		}
	});

	test('clear wipes chunks and meta', async function () {
		const store = new LocalVectorStore(':memory:', EMBEDDING_TYPE);
		try {
			store.setMeta('index_version', '1');
			const uri = URI.parse('file:///workspace/src/foo.ts');
			await store.upsertFile('src/foo.ts', uri, [makeChunk(1, 2, [1, 0, 0, 0])]);

			await store.clear();
			assert.strictEqual((await store.getStats()).chunks, 0);
			assert.strictEqual(store.getMeta('index_version'), undefined);
		} finally {
			store.dispose();
		}
	});

	test('meta read/write round-trips', function () {
		const store = new LocalVectorStore(':memory:', EMBEDDING_TYPE);
		try {
			assert.strictEqual(store.getMeta('index_version'), '1');
			store.setMeta('index_version', '2');
			assert.strictEqual(store.getMeta('index_version'), '2');
		} finally {
			store.dispose();
		}
	});
});
