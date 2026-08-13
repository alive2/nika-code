/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'vitest';
import { TokenizerJson } from './bpeTokenizer';
import { WordPieceTokenizer } from './wordPieceTokenizer';

function makeTokenizer(): TokenizerJson {
	return {
		model: {
			type: 'WordPiece',
			vocab: {
				'[UNK]': 100,
				'[PAD]': 0,
				'[CLS]': 101,
				'[SEP]': 102,
				'hello': 1001,
				'world': 1002,
				'##ing': 1003,
				'un': 1004,
				'##known': 1005,
				'low': 1006,
				'##er': 1007,
			},
			unk_token: '[UNK]',
			continuing_subword_prefix: '##',
			max_input_chars_per_word: 100,
		},
		added_tokens: [
			{ id: 0, content: '[PAD]', special: true },
			{ id: 100, content: '[UNK]', special: true },
			{ id: 101, content: '[CLS]', special: true },
			{ id: 102, content: '[SEP]', special: true },
		],
	};
}

suite('WordPieceTokenizer', function () {
	test('vocabSize and unkId', function () {
		const t = new WordPieceTokenizer(makeTokenizer());
		assert.strictEqual(t.vocabSize(), 11);
		assert.strictEqual(t.unkId(), 100);
	});

	test('encodes whole words from the vocab', function () {
		const t = new WordPieceTokenizer(makeTokenizer());
		assert.deepStrictEqual(t.encode('hello world'), [1001, 1002]);
	});

	test('splits unknown words with the ## continuation prefix', function () {
		const t = new WordPieceTokenizer(makeTokenizer());
		// 'unknown' -> 'un' + '##known'
		assert.deepStrictEqual(t.encode('unknown'), [1004, 1005]);
		// 'lower' -> 'low' + '##er'
		assert.deepStrictEqual(t.encode('lower'), [1006, 1007]);
	});

	test('whole words take precedence over subword splitting', function () {
		const t = new WordPieceTokenizer(makeTokenizer());
		assert.deepStrictEqual(t.encode('un'), [1004]);
	});

	test('unrecognizable words fall back to [UNK]', function () {
		const t = new WordPieceTokenizer(makeTokenizer());
		assert.deepStrictEqual(t.encode('qqzz'), [100]);
	});

	test('special tokens are matched case-sensitively before lowercasing', function () {
		const t = new WordPieceTokenizer(makeTokenizer());
		assert.deepStrictEqual(t.encode('[CLS] hello [SEP]'), [101, 1001, 102]);
	});

	test('is case insensitive for normal words', function () {
		const t = new WordPieceTokenizer(makeTokenizer());
		assert.deepStrictEqual(t.encode('HELLO'), [1001]);
	});

	test('words longer than max_input_chars_per_word map to [UNK]', function () {
		const json: TokenizerJson = { ...makeTokenizer(), model: { ...makeTokenizer().model!, max_input_chars_per_word: 3 } };
		const t = new WordPieceTokenizer(json);
		// 'helloing' is not in the vocab and exceeds the char limit, so it
		// cannot be split -> [UNK]. Whole-vocab hits still bypass the limit.
		assert.deepStrictEqual(t.encode('helloing'), [100]);
		assert.deepStrictEqual(t.encode('hello'), [1001]);
	});

	test('throws when tokenizer.json has no vocab', function () {
		assert.throws(() => new WordPieceTokenizer({ model: { type: 'WordPiece' } }));
	});
});
