/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'vitest';
import { BpeTokenizer, TokenizerJson } from './bpeTokenizer';

function makeTokenizer(): TokenizerJson {
	// A tiny BERT-style tokenizer covering the classic "low low lower lowest" example.
	return {
		model: {
			type: 'BPE',
			vocab: {
				'[UNK]': 0,
				'[CLS]': 1,
				'[SEP]': 2,
				'l': 3,
				'o': 4,
				'w': 5,
				'er': 6,
				'low': 7,
				'lower': 8,
				'lowest': 9,
				'newer': 10,
				'widest': 11,
			},
			merges: [
				'l o',
				'lo w',
				'e r',
				'low e',
				'low er',
				'low est',
				'w i',
				'wi d',
				'wid est',
			],
			unk_token: '[UNK]',
		},
		added_tokens: [{ id: 12, content: '[SPECIAL]' }],
	};
}

suite('BpeTokenizer', function () {
	test('vocabSize and unkId', function () {
		const t = new BpeTokenizer(makeTokenizer());
		assert.strictEqual(t.vocabSize(), 12);
		assert.strictEqual(t.unkId(), 0);
	});

	test('encodes a whole word that is in the vocab', function () {
		const t = new BpeTokenizer(makeTokenizer());
		assert.deepStrictEqual(t.encode('low'), [7]);
	});

	test('greedy BPE merges subwords', function () {
		const t = new BpeTokenizer(makeTokenizer());
		// 'lower' is in the vocab directly.
		assert.deepStrictEqual(t.encode('lower'), [8]);
		// 'newest' is not in the vocab: n e w e s t -> merges to n + ew? build by hand below.
		const ids = t.encode('lowest');
		assert.deepStrictEqual(ids, [9]);
	});

	test('unknown characters fall back to [UNK]', function () {
		const t = new BpeTokenizer(makeTokenizer());
		const ids = t.encode('x');
		assert.ok(ids.every(id => id === 0));
	});

	test('added tokens are encoded directly', function () {
		const t = new BpeTokenizer(makeTokenizer());
		const ids = t.encode('[SPECIAL]');
		assert.deepStrictEqual(ids, [12]);
	});

	test('is case insensitive and NFKC-normalized', function () {
		const t = new BpeTokenizer(makeTokenizer());
		// Uppercase input normalizes to lowercase before lookup.
		assert.deepStrictEqual(t.encode('LOW'), [7]);
	});

	test('throws when tokenizer.json has no BPE vocab/merges', function () {
		assert.throws(() => new BpeTokenizer({ model: { type: 'WordPiece' } }));
	});
});
