/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { detectPdfPageRange, extractPdfText, extractPdfTextLegacy, hasPdfMagicBytes, isPdfMime } from '../nikaPdf';

describe('Nika PDF extraction', () => {
	it('detects PDF MIME types and magic bytes', () => {
		expect(isPdfMime('application/pdf')).toBe(true);
		expect(isPdfMime('APPLICATION/PDF')).toBe(true);
		expect(isPdfMime('text/plain')).toBe(false);
		expect(hasPdfMagicBytes(new TextEncoder().encode('%PDF-1.7'))).toBe(true);
		expect(hasPdfMagicBytes(new TextEncoder().encode('nope'))).toBe(false);
	});

	it.each([
		['pages 10-20', { start: 10, end: 20 }],
		['page 3', { start: 3, end: 3 }],
		['pages 5 to 12', { start: 5, end: 12 }],
		['עמודים 10 עד 20', { start: 10, end: 20 }],
		['עמוד 7', { start: 7, end: 7 }],
	])('detects the requested range in %s', (prompt, expected) => {
		expect(detectPdfPageRange(prompt)).toEqual(expected);
	});

	it('extracts simple text streams with the dependency-light fallback', async () => {
		const data = new TextEncoder().encode('%PDF-1.4\nstream\n(Hello\\nNika) Tj\nendstream\n%%EOF');
		expect(extractPdfTextLegacy(data)).toBe('Hello\nNika');
		const result = await extractPdfText(data);
		expect(result.text).toContain('Hello');
		expect(result.extractor).toBe('legacy');
	});
});
