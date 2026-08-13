/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal HuggingFace BPE tokenizer that reads the standard `tokenizer.json`
 * format produced by `tokenizers` for BERT-style models (e.g. MiniLM,
 * all-MiniLM). No runtime dependency: it is a straight port of the HF BPE
 * encode algorithm (normalize → pre-tokenize → greedy merge → vocab lookup).
 *
 * This intentionally does NOT implement the full `tokenizers` feature set —
 * only what the bundled embedding models need. Extend as the model set grows.
 */

export interface TokenizerJson {
	readonly model?: {
		readonly type?: string;
		readonly vocab?: Record<string, number>;
		readonly merges?: string[];
		readonly unk_token?: string;
		readonly continuing_subword_prefix?: string;
		readonly end_of_word_suffix?: string;
		readonly max_input_chars_per_word?: number;
	};
	readonly added_tokens?: Array<{ readonly id: number; readonly content: string; readonly special?: boolean }>;
	readonly normalizer?: unknown;
	readonly pre_tokenizer?: unknown;
	readonly post_processor?: unknown;
}

export interface AddedTokenPart {
	readonly text: string;
	readonly added: boolean;
}

/**
 * Splits normalized text into added-token matches and plain segments,
 * greedily preferring the longest added-token match at each position.
 * Added (special) tokens are matched case-sensitively on the raw text, because
 * they can contain characters (like `[CLS]`) that the pre-tokenizer would
 * otherwise split apart and because they must not be lowercased.
 */
export function splitAddedTokens(text: string, addedTokens: ReadonlyMap<string, number>): AddedTokenPart[] {
	const result: AddedTokenPart[] = [];
	const added = Array.from(addedTokens.keys()).sort((a, b) => b.length - a.length);
	let rest = text;
	while (rest.length > 0) {
		let matched = false;
		for (const content of added) {
			if (rest.startsWith(content)) {
				result.push({ text: content, added: true });
				rest = rest.slice(content.length);
				matched = true;
				break;
			}
		}
		if (matched) {
			continue;
		}
		const last = result[result.length - 1];
		if (last && !last.added) {
			result[result.length - 1] = { text: last.text + rest[0], added: false };
		} else {
			result.push({ text: rest[0], added: false });
		}
		rest = rest.slice(1);
	}
	return result;
}

export class BpeTokenizer {
	private readonly _vocab = new Map<string, number>();
	private readonly _merges = new Map<string, number>();
	private readonly _addedTokens = new Map<string, number>();
	private readonly _unkToken: string;
	private readonly _unkId: number;

	constructor(json: TokenizerJson) {
		const vocab = json.model?.vocab;
		const merges = json.model?.merges;
		if (!vocab || !merges) {
			throw new Error('BpeTokenizer: tokenizer.json has no BPE vocab/merges');
		}
		for (const [token, id] of Object.entries(vocab)) {
			this._vocab.set(token, id);
		}
		// Merges are ordered from highest to lowest priority in tokenizer.json;
		// assign rank 0..n so lower rank == higher priority.
		for (let i = 0; i < merges.length; i++) {
			this._merges.set(merges[i], i);
		}
		this._unkToken = json.model?.unk_token ?? '[UNK]';
		this._unkId = this._vocab.get(this._unkToken) ?? 0;
		for (const added of json.added_tokens ?? []) {
			this._addedTokens.set(added.content, added.id);
		}
	}

	/**
	 * Encodes text into token ids. BERT-style: NFKC normalize + lowercase,
	 * then split into word / punctuation tokens, then greedy BPE merge.
	 *
	 * Added (special) tokens are matched on the raw normalized text before
	 * pre-tokenization, because they can contain characters (like `[CLS]`)
	 * that the pre-tokenizer would otherwise split apart.
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
		for (const token of preTokens) {
			if (this._vocab.has(token)) {
				ids.push(this._vocab.get(token)!);
				continue;
			}
			ids.push(...this._bpe(token));
		}
		return ids;
	}

	vocabSize(): number {
		return this._vocab.size;
	}

	unkId(): number {
		return this._unkId;
	}

	private _bpe(word: string): number[] {
		// Split into characters, preserving multi-byte sequences.
		const symbols: string[] = Array.from(word);
		if (symbols.length === 1 && this._vocab.has(symbols[0])) {
			return [this._vocab.get(symbols[0])!];
		}

		// Repeatedly merge the lowest-rank adjacent pair.
		while (symbols.length > 1) {
			let bestRank = Infinity;
			let bestIndex = -1;
			for (let i = 0; i < symbols.length - 1; i++) {
				const rank = this._merges.get(`${symbols[i]} ${symbols[i + 1]}`);
				if (rank !== undefined && rank < bestRank) {
					bestRank = rank;
					bestIndex = i;
				}
			}
			if (bestIndex === -1) {
				break;
			}
			const merged = symbols[bestIndex] + symbols[bestIndex + 1];
			symbols.splice(bestIndex, 2, merged);
		}

		const result: number[] = [];
		for (const symbol of symbols) {
			const id = this._vocab.get(symbol);
			result.push(id ?? this._unkId);
		}
		return result;
	}
}
