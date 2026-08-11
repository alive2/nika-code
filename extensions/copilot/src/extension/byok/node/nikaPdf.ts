/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as zlib from 'zlib';

export interface PdfPageRange { readonly start: number; readonly end: number }
export interface PdfExtractOptions { readonly pageRange?: PdfPageRange; readonly maxPages?: number }
export interface PdfExtractResult {
	readonly text: string;
	readonly totalPages: number;
	readonly pagesIncluded: number;
	readonly truncated: boolean;
	readonly extractor: 'pdfjs' | 'legacy' | 'none';
}
interface PdfJsTextItem { str: string }
interface PdfJsTextContent { items: PdfJsTextItem[] }
interface PdfJsPage { getTextContent(): Promise<PdfJsTextContent> }
interface PdfJsDocument { numPages: number; getPage(pageNumber: number): Promise<PdfJsPage>; destroy(): void }
interface PdfJsApi {
	getDocument(params: { data: Uint8Array; isEvalSupported: boolean; disableFontFace: boolean; useSystemFonts: boolean; verbosity: number }): { promise: Promise<PdfJsDocument> };
}

let pdfjsApi: PdfJsApi | undefined;
let pdfjsUnavailable = false;

export function isPdfMime(mimeType: string): boolean {
	const normalized = (mimeType || '').toLowerCase();
	return normalized === 'application/pdf' || normalized.endsWith('/pdf');
}

export function hasPdfMagicBytes(data: Uint8Array): boolean {
	return data.length >= 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
}

/** Detects `pages 10-20`, `pages 10 to 20`, `עמודים 10 עד 20`, and single pages. */
export function detectPdfPageRange(text: string): PdfPageRange | undefined {
	if (!text) {
		return undefined;
	}
	const english = /page[s]?\s*:?\s*(\d+)(?:\s*[-–—]\s*(\d+)|\s+(?:to|until)\s+(\d+)|\s+עד\s+(\d+))?/i.exec(text);
	const hebrew = /עמוד(?:ים)?\s*:?\s*(\d+)(?:\s*[-–—]\s*(\d+)|\s+עד\s+(\d+))?/.exec(text);
	const match = english ?? hebrew;
	if (!match) {
		return undefined;
	}
	const start = Number.parseInt(match[1], 10);
	if (!Number.isFinite(start) || start < 1) {
		return undefined;
	}
	const rawEnd = match[2] ?? match[3] ?? match[4];
	const end = rawEnd ? Number.parseInt(rawEnd, 10) : start;
	return Number.isFinite(end) && end >= start ? { start, end } : { start, end: start };
}

function loadPdfJs(): PdfJsApi | undefined {
	if (!pdfjsApi && !pdfjsUnavailable) {
		try {
			pdfjsApi = require('pdfjs-dist/legacy/build/pdf.js') as PdfJsApi;
			try {
				const worker = require('pdfjs-dist/legacy/build/pdf.worker.js') as { WorkerMessageHandler?: unknown };
				(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
			} catch {
				// The main-thread worker is optional for text-only extraction.
			}
		} catch {
			pdfjsUnavailable = true;
		}
	}
	return pdfjsApi;
}

export async function extractPdfTextWithPdfjs(data: Uint8Array, options: PdfExtractOptions = {}): Promise<PdfExtractResult> {
	const empty: PdfExtractResult = { text: '', totalPages: 0, pagesIncluded: 0, truncated: false, extractor: 'none' };
	const api = loadPdfJs();
	if (!api) {
		return empty;
	}
	let document: PdfJsDocument | undefined;
	try {
		document = await api.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: true, verbosity: 0 }).promise;
		const totalPages = document.numPages;
		let start = 1;
		let end = totalPages;
		if (options.pageRange) {
			start = Math.max(1, options.pageRange.start);
			end = Math.min(totalPages, options.pageRange.end);
		} else if (options.maxPages && options.maxPages > 0) {
			end = Math.min(totalPages, options.maxPages);
		}
		if (start > end) {
			return { ...empty, totalPages };
		}
		const pages: string[] = [];
		for (let pageNumber = start; pageNumber <= end; pageNumber++) {
			const page = await document.getPage(pageNumber);
			const text = await page.getTextContent();
			pages.push(text.items.map(item => item.str).join(' '));
		}
		const pagesIncluded = end - start + 1;
		return {
			text: pages.join('\n').trim(),
			totalPages,
			pagesIncluded,
			truncated: pagesIncluded < totalPages,
			extractor: 'pdfjs',
		};
	} catch {
		return empty;
	} finally {
		try { document?.destroy(); } catch { /* best effort */ }
	}
}

export function extractPdfTextLegacy(data: Uint8Array): string {
	try {
		const source = Buffer.from(data).toString('latin1');
		const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
		const chunks: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = streams.exec(source)) !== null) {
			const raw = Buffer.from(match[1], 'latin1');
			let decoded: Buffer;
			try { decoded = zlib.inflateSync(raw); } catch { decoded = raw; }
			const text = extractTextOperators(decoded.toString('latin1'));
			if (text) { chunks.push(text); }
		}
		return chunks.join('\n').trim();
	} catch {
		return '';
	}
}

export async function extractPdfText(data: Uint8Array, options: PdfExtractOptions = {}): Promise<PdfExtractResult> {
	const primary = await extractPdfTextWithPdfjs(data, options);
	if (primary.text) {
		return primary;
	}
	const legacy = extractPdfTextLegacy(data);
	return legacy
		? { text: legacy, totalPages: primary.totalPages, pagesIncluded: primary.pagesIncluded, truncated: primary.truncated, extractor: 'legacy' }
		: primary;
}

function extractTextOperators(decoded: string): string {
	const output: string[] = [];
	const single = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g;
	let match: RegExpExecArray | null;
	while ((match = single.exec(decoded)) !== null) {
		output.push(decodePdfString(match[1]));
	}
	const array = /\[([\s\S]*?)\]\s*TJ/g;
	while ((match = array.exec(decoded)) !== null) {
		const strings = /\(((?:\\.|[^\\()])*)\)/g;
		let item: RegExpExecArray | null;
		while ((item = strings.exec(match[1])) !== null) {
			output.push(decodePdfString(item[1]));
		}
	}
	return output.join('');
}

function decodePdfString(raw: string): string {
	return raw.replace(/\\([nrtbf()\\])|\\\d{1,3}|\\/g, (escape, character: string | undefined) => {
		if (character) {
			return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[character] ?? character;
		}
		return /^\\\d{1,3}$/.test(escape) ? String.fromCharCode(Number.parseInt(escape.slice(1), 8)) : '';
	});
}
