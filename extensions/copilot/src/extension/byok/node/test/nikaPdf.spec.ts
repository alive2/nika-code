/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { detectPdfPageRange, extractPdfText, extractPdfTextLegacy, extractPdfTextWithPdfjs, hasPdfMagicBytes, isPdfMime, toPlainUint8Array } from '../nikaPdf';

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

	it('normalizes Node Buffers so pdfjs does not reject them', () => {
		// pdfjs-dist 3.x throws on `val instanceof Buffer` in Node; the LM API
		// hands PDF bytes to Nika as Buffer-backed Uint8Arrays in the extension
		// host, so this must round-trip to a plain Uint8Array.
		const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
		expect(Buffer.isBuffer(buffer)).toBe(true);
		const plain = toPlainUint8Array(buffer);
		expect(Buffer.isBuffer(plain)).toBe(false);
		expect(plain).toBeInstanceOf(Uint8Array);
		expect(Array.from(plain)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
	});

	it('extracts a real PDF through pdfjs even when the bytes arrive as a Node Buffer', async () => {
		const pdf = makeSimplePdf('Hello Nika World');
		const buffer = Buffer.from(pdf);
		const result = await extractPdfTextWithPdfjs(buffer);
		expect(result.extractor).toBe('pdfjs');
		expect(result.text).toContain('Hello Nika World');
		expect(result.totalPages).toBe(1);
	});

	it('extracts a real PDF through the public API when the bytes arrive as a Node Buffer', async () => {
		const pdf = makeSimplePdf('Hello Nika World');
		const result = await extractPdfText(Buffer.from(pdf), { maxPages: 5 });
		expect(result.extractor).toBe('pdfjs');
		expect(result.text).toContain('Hello Nika World');
		expect(result.totalPages).toBe(1);
		expect(result.truncated).toBe(false);
	});
});

/**
 * Builds a minimal but valid single-page PDF containing `text`. Uses only ASCII
 * so the content stream is predictable across extractors.
 */
function makeSimplePdf(text: string): Uint8Array {
	const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const stream = Buffer.from(content, 'latin1').toString('latin1');
	const objects = [
		'%PDF-1.4\n',
		'1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
		'2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
		'3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n',
		`4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`,
		'5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
		'trailer << /Root 1 0 R /Size 6 >>\n%%EOF',
	];
	return Buffer.from(objects.join(''), 'latin1');
}
