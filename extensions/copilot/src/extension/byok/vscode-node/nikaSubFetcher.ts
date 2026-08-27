/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Response as FetcherResponse } from '../../../platform/networking/common/fetcherService';
import { codexFetch, CodexFetchInit } from './nikaCodexFetcher';

/** How long to wait before retrying a device-auth start after HTTP 403. */
const RETRY_DELAY_MS = 3000;

/**
 * Fetches a device-auth start, retrying once after a short delay when the
 * endpoint answers HTTP 403. The ChatGPT (`auth.openai.com`) and Claude
 * (`claude.ai`) device endpoints sit behind Cloudflare bot rules that
 * intermittently answer 403 for otherwise valid requests (rate limiting /
 * temporary flags), so a single retry lets the flow recover without user
 * interaction. Any other status (or a second 403) is returned as-is so the
 * caller can surface a descriptive error.
 */
export async function fetchDeviceStartWithRetry(url: string, options: CodexFetchInit, userAgent: string): Promise<FetcherResponse> {
	const first = await codexFetch(url, options, userAgent);
	if (first.status !== 403) {
		return first;
	}
	await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
	return codexFetch(url, options, userAgent);
}

/**
 * Normalizes a device-flow error from a poll response. Providers report the
 * flow state either as a plain error string (`authorization_pending`,
 * `slow_down`, …) or — as OpenAI's `deviceauth/token` endpoint does — as an
 * object with a `code` field (`{ code: 'deviceauth_authorization_pending' }`).
 * Returns the error code string, or '' when the payload has no recognizable
 * code.
 */
export function normalizeDeviceErrorCode(raw: unknown): string {
	if (typeof raw === 'string') {
		return raw;
	}
	if (raw && typeof raw === 'object') {
		const code = (raw as { code?: unknown }).code;
		if (typeof code === 'string') {
			return code;
		}
	}
	return '';
}

/**
 * Best-effort error message from a non-OK response. Includes the status text
 * and diagnostic response headers (server / cf-ray / cf-mitigated) so a
 * Cloudflare or proxy block is identifiable, then falls back to the response
 * body when readable. Guards every access defensively: spec fakes and edge
 * blocks may lack headers, a status text (HTTP/2 has none), or a readable
 * body (compressed or empty).
 */
export async function readSubErrorDetail(response: FetcherResponse): Promise<string> {
	const bits: string[] = [];
	if (typeof (response as { statusText?: unknown }).statusText === 'string' && (response as { statusText: string }).statusText) {
		bits.push((response as { statusText: string }).statusText);
	}
	const headers = (response as { headers?: { get?(name: string): string | null } }).headers;
	if (headers?.get) {
		for (const name of ['server', 'cf-ray', 'cf-mitigated', 'content-type', 'retry-after']) {
			const value = headers.get(name);
			if (value) {
				bits.push(`${name}=${value}`);
			}
		}
	}
	try {
		const text = await response.text();
		if (text) {
			bits.push(text.slice(0, 200));
		}
	} catch {
		// Body unreadable — the header bits above still explain the block.
	}
	return bits.length > 0 ? `${bits.join(' · ')} (HTTP ${response.status})` : `HTTP ${response.status}`;
}
