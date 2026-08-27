/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isHighSurrogate, isLowSurrogate } from '../vs/base/common/strings';

/**
 * Slices `value` between UTF-16 offsets `start` (inclusive) and `end`
 * (exclusive) without splitting a surrogate pair. When a boundary falls
 * between the two code units of an astral character (e.g. an emoji), the
 * boundary is nudged so the result never contains a lone surrogate.
 *
 * This matters for anything that will later be `JSON.stringify`-ed: a lone
 * surrogate serializes as a `\uDXXX` escape, which strict JSON parsers (e.g.
 * DeepSeek's serde_json) reject with "unexpected end of hex escape".
 */
export function safeSlice(value: string, start: number, end: number): string {
	start = Math.max(0, Math.min(start, value.length));
	end = Math.max(start, Math.min(end, value.length));

	// Don't begin in the middle of a surrogate pair: skip the orphaned low surrogate.
	if (start > 0 && start < value.length && isLowSurrogate(value.charCodeAt(start)) && isHighSurrogate(value.charCodeAt(start - 1))) {
		start++;
	}
	// Don't end in the middle of a surrogate pair: drop the orphaned high surrogate.
	if (end > start && end < value.length && isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) {
		end--;
	}

	return value.slice(start, end);
}
