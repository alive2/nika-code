/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { safeSlice } from '../stringUtils';

function hasLoneSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code >= 0xD800 && code <= 0xDBFF) {
			// high surrogate must be followed by its low half
			if (!(i + 1 < s.length && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF)) {
				return true;
			}
		} else if (code >= 0xDC00 && code <= 0xDFFF) {
			// low surrogate must be preceded by its high half
			if (!(i > 0 && s.charCodeAt(i - 1) >= 0xD800 && s.charCodeAt(i - 1) <= 0xDBFF)) {
				return true;
			}
		}
	}
	return false;
}

describe('safeSlice', () => {

	it('behaves like String.slice for strings without astral characters', () => {
		expect(safeSlice('hello world', 0, 5)).toBe('hello');
		expect(safeSlice('hello world', 6, 11)).toBe('world');
		expect(safeSlice('hello world', 0, 11)).toBe('hello world');
	});

	it('does not split a surrogate pair at the end boundary', () => {
		const text = 'a😀b'; // 😀 = U+1F600 = \uD83D\uDE00
		const cut = safeSlice(text, 0, 2); // raw slice would leave a lone \uD83D
		expect(cut).toBe('a');
		expect(hasLoneSurrogate(cut)).toBe(false);
		// the pair is preserved when the boundary falls past it
		expect(safeSlice(text, 0, 3)).toBe('a😀');
	});

	it('does not split a surrogate pair at the start boundary', () => {
		const text = 'a😀b';
		const cut = safeSlice(text, 2, 4); // raw slice would start with a lone \uDE00
		expect(cut).toBe('b');
		expect(hasLoneSurrogate(cut)).toBe(false);
	});

	it('never returns a string containing lone surrogates', () => {
		const text = 'x\uD83D\uDE00y\uD83D\uDE00z';
		for (let start = 0; start <= text.length; start++) {
			for (let end = start; end <= text.length; end++) {
				const cut = safeSlice(text, start, end);
				expect(hasLoneSurrogate(cut)).toBe(false);
			}
		}
	});

	it('clamps out-of-range boundaries', () => {
		expect(safeSlice('abc', -5, 2)).toBe('ab');
		expect(safeSlice('abc', 1, 99)).toBe('bc');
		expect(safeSlice('abc', 4, 99)).toBe('');
	});

	it('returns empty string when slicing an empty or fully-elided pair', () => {
		expect(safeSlice('', 0, 0)).toBe('');
		expect(safeSlice('😀', 0, 1)).toBe('');
		expect(safeSlice('😀', 1, 2)).toBe('');
	});
});
