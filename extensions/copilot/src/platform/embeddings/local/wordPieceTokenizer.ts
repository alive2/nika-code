/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal HuggingFace WordPiece tokenizer for BERT-style models (e.g. the
 * bundled `bge-small-en-v1.5`, whose `tokenizer.json` is a `WordPiece` model).
 *
 * Straight port of the HF WordPiece encode algorithm: NFKC normalize +
 * lowercase → pre-tokenize into words/punctuation → greedy longest-prefix
 * sub-word splitting with the `##` continuation prefix → vocab lookup.
 */

import { splitAddedTokens, TokenizerJson } from './bpeTokenizer';

export class WordPieceTokenizer {
	private readonly _vocab = new Map<string, number>();
	private readonly _addedTokens = new Map<string, number>();
	private readonly _unkToken: string;
	private readonly _unkId: number;
	private readonly _continuePrefix: string;
	private readonly _maxInputCharsPerWord: number;

	constructor(json: TokenizerJson) {
		const vocab = json.model?.vocab;
		if (!vocab) {
			throw new Error('WordPieceTokenizer: tokenizer.json has no vocab');
		}
		for (const [token, id] of Object.entries(vocab)) {
			this._vocab.set(token, id);
		}
		this._unkToken = json.model?.unk_token ?? '[UNK]';
		this._unkId = this._vocab.get(this._unkToken) ?? 0;
		this._continuePrefix = json.model?.continuing_subword_prefix ?? '##';
		this._maxInputCharsPerWord = json.model?.max_input_chars_per_word ?? 100;
		for (const added of json.added_tokens ?? []) {
			this._addedTokens.set(added.content, added.id);
		}
	}

	/**
	 * Encodes text into token ids. Added (special) tokens are matched
	 * case-sensitively before pre-tokenization; everything else is lowercased.
	 */
	encode(text: string): number[] {
		const nfkc = text.normalize('NFKC');
		const ids: number[] = [];
		if (!this._addedTokens.size) {
			return this._encodeSegment(nfkc.toLowerCase());
		}
		for (const part of splitAddedTokens(nfkc, this._addedTokens)) {
			if (part.added) {
				ids.push(this._addedTokens.get(part.text)!);
			} else {
				ids.push(...this._encodeSegment(part.text.toLowerCase()));
			}
		}
		return ids;
	}

	private _encodeSegment(text: string): number[] {
		const preTokens = text.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}\s]/gu) ?? [];
		const ids: number[] = [];
		for (const word of preTokens) {
			if (this._vocab.has(word)) {
				ids.push(this._vocab.get(word)!);
				continue;
			}
			ids.push(...this._wordPiece(word));
		}
		return ids;
	}

	vocabSize(): number {
		return this._vocab.size;
	}

	unkId(): number {
		return this._unkId;
	}

	private _wordPiece(word: string): number[] {
		const chars = Array.from(word);
		if (chars.length > this._maxInputCharsPerWord) {
			return [this._unkId];
		}

		const subTokens: number[] = [];
		let start = 0;
		while (start < chars.length) {
			let end = chars.length;
			let curSubstr: string | undefined;
			while (start < end) {
				let substr = chars.slice(start, end).join('');
				if (start > 0) {
					substr = this._continuePrefix + substr;
				}
				if (this._vocab.has(substr)) {
					curSubstr = substr;
					break;
				}
				end--;
			}
			if (curSubstr === undefined) {
				return [this._unkId];
			}
			subTokens.push(this._vocab.get(curSubstr)!);
			start = end;
		}
		return subTokens;
	}
}
