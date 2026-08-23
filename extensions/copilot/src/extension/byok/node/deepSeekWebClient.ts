/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { DeepSeekWebPowChallenge, DeepSeekWebPowSolver } from './deepSeekWebPow';

/**
 * A client for DeepSeek's unofficial web chat API (chat.deepseek.com),
 * ported from the alive2/deepseek-chat-api Python client (`dsk/api.py`).
 *
 * The API is not OpenAI-compatible: requests go to `/api/v0/*`, require a
 * browser-ish `authorization` token (the webapp's `userToken`), a solved
 * proof-of-work challenge in `x-ds-pow-response`, and stream back a
 * JSON-patch-like SSE format instead of OpenAI `choices`.
 */

export const DEEP_SEEK_WEB_BASE_URL = 'https://chat.deepseek.com/api/v0';

/** How long a fetched `x-hif-leim` value stays usable before it is refetched. */
const HIF_LEIM_TTL_MS = 600_000;

/** How long an uploaded file may take to become ready before failing. */
const UPLOAD_READY_TIMEOUT_MS = 20_000;

/** A single text delta from the completion stream. */
export interface DeepSeekWebChunk {
	readonly content: string;
	readonly type: 'content' | 'finish' | 'error';
	readonly finishReason?: 'stop' | 'error';
}

/**
 * Parses a single SSE line from the DeepSeek web stream. Port of the
 * reference client's `_parse_chunk`.
 *
 * The stream uses a JSON-patch-like format (not OpenAI `choices`):
 * - `event: ready / update_file / update_session / close` — metadata, skipped
 * - `data: {"v":{"response":{"fragments":[...]}}}` — initial response snapshot
 * - `data: {"p":"response/fragments/-1/content","o":"APPEND","v":" image"}` —
 *   explicit append patch to the content path
 * - `data: {"v":" is"}` — bare value, continues the previous path/op
 * - `data: {"p":"response/status","o":"SET","v":"FINISHED"}` — stream finished
 * - `data: {"p":...,"o":"BATCH","v":[...]}` — batched ops (e.g. quasi_status)
 *
 * Returns `undefined` for lines that carry no content.
 */
export function parseDeepSeekWebChunk(line: string, lastPath: string | undefined): DeepSeekWebChunk | undefined {
	if (!line) {
		return undefined;
	}
	if (line.startsWith('event: ') || line.startsWith(':')) {
		return undefined;
	}
	if (!line.startsWith('data: ')) {
		return undefined;
	}

	let data: unknown;
	try {
		data = JSON.parse(line.slice('data: '.length));
	} catch {
		return undefined;
	}
	if (!data || typeof data !== 'object') {
		return undefined;
	}
	const record = data as Record<string, unknown>;

	// Non-stream JSON error envelope (e.g. biz_code 9 "invalid ref file id").
	const envelope = record['data'];
	if (envelope && typeof envelope === 'object') {
		const bizCode = (envelope as Record<string, unknown>)['biz_code'];
		if (bizCode !== undefined && bizCode !== 0) {
			return {
				content: '',
				type: 'error',
				finishReason: 'error',
			};
		}
	}

	// JSON-patch style op: {"p": path, "o": op, "v": value}
	if (typeof record['p'] === 'string' && typeof record['o'] === 'string' && 'v' in record) {
		const path = record['p'];
		const op = record['o'];
		const value = record['v'];
		if (path.endsWith('/content') && op === 'APPEND' && typeof value === 'string') {
			return { content: value, type: 'content' };
		}
		if (path === 'response/status' && op === 'SET') {
			if (value === 'FINISHED') {
				return { content: '', type: 'finish', finishReason: 'stop' };
			}
			if (value === 'ERROR') {
				return { content: '', type: 'error', finishReason: 'error' };
			}
		}
		if (op === 'BATCH' && Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === 'object' && (item as Record<string, unknown>)['p'] === 'quasi_status' && (item as Record<string, unknown>)['v'] === 'FINISHED') {
					return { content: '', type: 'finish', finishReason: 'stop' };
				}
			}
		}
		return undefined;
	}

	// Bare continuation: {"v":" text"}
	if (typeof record['v'] === 'string' && Object.keys(record).length === 1) {
		if (lastPath && lastPath.endsWith('/content')) {
			return { content: record['v'], type: 'content' };
		}
		return undefined;
	}

	// Response snapshot: {"v":{"response":{"fragments":[...]}}}
	if (typeof record['v'] === 'object' && record['v'] !== null) {
		const resp = (record['v'] as Record<string, unknown>)['response'];
		if (resp && typeof resp === 'object') {
			const fragments = (resp as Record<string, unknown>)['fragments'];
			if (Array.isArray(fragments)) {
				const text = fragments
					.filter(f => f && typeof f === 'object' && (f as Record<string, unknown>)['type'] === 'RESPONSE')
					.map(f => String((f as Record<string, unknown>)['content'] ?? ''))
					.join('');
				if (text) {
					return { content: text, type: 'content' };
				}
			}
		}
	}

	// Fallback: OpenAI-style chunks (some responses may use this shape).
	if (Array.isArray(record['choices']) && (record['choices'] as unknown[]).length > 0) {
		const choice = (record['choices'] as Record<string, unknown>[])[0];
		const delta = choice['delta'];
		if (delta && typeof delta === 'object') {
			return {
				content: String((delta as Record<string, unknown>)['content'] ?? ''),
				type: 'content',
			};
		}
	}

	return undefined;
}

/** Options for a single chat completion call. */
export interface DeepSeekWebCompletionOptions {
	readonly chatSessionId: string;
	readonly prompt: string;
	readonly parentMessageId?: string;
	readonly thinkingEnabled?: boolean;
	readonly searchEnabled?: boolean;
	readonly refFileIds?: readonly string[];
	/** Forces `model_type: 'vision'` (required for image completions). */
	readonly modelType?: string;
}

/**
 * Low-level DeepSeek web API client. Port of `dsk/api.py`'s `DeepSeekAPI`
 * with the Cloudflare-cookie machinery dropped (the extension host runs with
 * a normal network stack; cf_clearance cookies are out of scope).
 */
export class DeepSeekWebClient {
	private readonly _powSolver = new DeepSeekWebPowSolver();
	private _hifLeim: string | undefined;
	private _hifLeimFetchedAt = 0;

	constructor(
		private readonly _authToken: string,
		private readonly _fetcherService: IFetcherService,
	) { }

	private _headers(powResponse?: string, hifLeim?: string): Record<string, string> {
		const headers: Record<string, string> = {
			'accept': '*/*',
			'authorization': `Bearer ${this._authToken}`,
			'content-type': 'application/json',
			'origin': 'https://chat.deepseek.com',
			'referer': 'https://chat.deepseek.com/',
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
			// Client identity headers captured from the webapp (2.4.0): without
			// x-client-bundle-id / a current x-client-version the server
			// classifies uploads as generic files (no model_kind: VISION).
			'x-client-bundle-id': 'com.deepseek.chat',
			'x-client-locale': 'en_US',
			'x-client-platform': 'web',
			'x-client-timezone-offset': '10800',
			'x-client-version': '2.4.0',
		};
		if (powResponse) {
			headers['x-ds-pow-response'] = powResponse;
		}
		if (hifLeim) {
			headers['x-hif-leim'] = hifLeim;
		}
		return headers;
	}

	/**
	 * Fetches a fresh `x-hif-leim` value (rotating; required for vision
	 * completions), trying the primary host then the fallback. Cached with a
	 * TTL from the reference client; falls back to the last known value.
	 */
	async getHifLeim(): Promise<string> {
		const now = Date.now();
		if (this._hifLeim && now - this._hifLeimFetchedAt < HIF_LEIM_TTL_MS) {
			return this._hifLeim;
		}
		for (const url of ['https://hif-leim.deepseek.com/query', 'https://hif-test.deepseek.com/query']) {
			try {
				const response = await this._fetcherService.fetch(url, { method: 'GET', callSite: 'nika-deepseek-web-hifleim' });
				if (response.ok) {
					const body = await response.json() as { data?: { biz_data?: { value?: unknown } } };
					const value = body?.data?.biz_data?.value;
					if (typeof value === 'string' && value) {
						this._hifLeim = value;
						this._hifLeimFetchedAt = now;
						return value;
					}
				}
			} catch {
				// Try the fallback host.
			}
		}
		return this._hifLeim ?? '';
	}

	/**
	 * Fetches a fresh PoW challenge for a completion request and solves it,
	 * returning the base64 `x-ds-pow-response` header value.
	 */
	private async _solvePow(targetPath: string = '/api/v0/chat/completion'): Promise<string> {
		const response = await this._postJson('/chat/create_pow_challenge', { target_path: targetPath });
		const body = await response.json() as { data?: { biz_data?: { challenge?: DeepSeekWebPowChallenge } } };
		const challenge = body?.data?.biz_data?.challenge;
		if (!challenge || typeof challenge !== 'object') {
			throw new Error('Invalid PoW challenge response format from server');
		}
		return this._powSolver.solveChallenge(challenge);
	}

	private async _postJson(endpoint: string, json: unknown): Promise<import('../../../platform/networking/common/fetcherService').Response> {
		const response = await this._fetcherService.fetch(`${DEEP_SEEK_WEB_BASE_URL}${endpoint}`, {
			method: 'POST',
			headers: this._headers(),
			body: JSON.stringify(json),
			callSite: 'nika-deepseek-web',
		});
		if (response.status === 401) {
			throw new Error('Invalid or expired DeepSeek web authentication token');
		}
		if (response.status === 429) {
			throw new Error('DeepSeek web API rate limit exceeded');
		}
		if (!response.ok) {
			throw new Error(`DeepSeek web API request failed with HTTP ${response.status}`);
		}
		return response;
	}

	/** Creates a new chat session and returns its id. */
	async createChatSession(): Promise<string> {
		const response = await this._postJson('/chat_session/create', {});
		const body = await response.json() as { data?: { biz_data?: { chat_session?: { id?: unknown }, id?: unknown } } };
		const biz = body?.data?.biz_data;
		// The response nests the session under `chat_session` (webapp shape).
		const id = biz?.chat_session?.id ?? biz?.id;
		if (typeof id !== 'string') {
			throw new Error('Invalid session creation response format from server');
		}
		return id;
	}

	/**
	 * Streams a chat completion. Yields text chunks until the server signals
	 * `FINISHED`; throws on error envelopes or non-OK responses.
	 */
	async *streamCompletion(options: DeepSeekWebCompletionOptions, token: CancellationToken): AsyncGenerator<string, void, unknown> {
		const powResponse = await this._solvePow();
		const hifLeim = await this.getHifLeim();
		// Vision requires the explicit 'vision' model type in the JSON body
		// (reverse-engineered from the webapp's "Send to Vision." flow).
		const modelType = options.modelType ?? ((options.refFileIds?.length ?? 0) > 0 ? 'vision' : undefined);
		const response = await this._fetcherService.fetch(`${DEEP_SEEK_WEB_BASE_URL}/chat/completion`, {
			method: 'POST',
			headers: this._headers(powResponse, hifLeim),
			body: JSON.stringify({
				chat_session_id: options.chatSessionId,
				parent_message_id: options.parentMessageId ?? null,
				model_type: modelType ?? null,
				prompt: options.prompt,
				ref_file_ids: options.refFileIds ? [...options.refFileIds] : [],
				thinking_enabled: options.thinkingEnabled ?? true,
				search_enabled: options.searchEnabled ?? false,
				action: null,
				preempt: false,
			}),
			callSite: 'nika-deepseek-web-completion',
		});
		if (response.status === 401) {
			throw new Error('Invalid or expired DeepSeek web authentication token');
		}
		if (response.status === 429) {
			throw new Error('DeepSeek web API rate limit exceeded');
		}
		if (!response.ok) {
			throw new Error(`DeepSeek web chat completion failed with HTTP ${response.status}`);
		}

		const decoder = new TextDecoder('utf-8');
		let buffer = '';
		let lastPath: string | undefined;
		for await (const value of response.body) {
				if (token.isCancellationRequested) {
					await response.body.destroy();
					return;
				}
				buffer += decoder.decode(value, { stream: true });
				let newlineIndex: number;
				while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
					buffer = buffer.slice(newlineIndex + 1);
					if (!line) {
						continue;
					}
					const chunk = parseDeepSeekWebChunk(line, lastPath);
					if (!chunk) {
						continue;
					}
					if (chunk.type === 'error') {
						throw new Error('DeepSeek web API error: ' + (chunk.content || 'unknown'));
					}
					if (chunk.type === 'finish') {
						return;
					}
					// Remember the path for bare-continuation chunks. The
					// reference client only tracks content paths; matching it
					// here means the continuation check is equivalent.
					if (line.includes('"p"') && line.includes('"o"')) {
						lastPath = (JSON.parse(line.slice('data: '.length)) as { p?: unknown }).p as string | undefined;
					}
					yield chunk.content;
				}
			}
	}

	/**
	 * Uploads an image for vision completions and returns its file id.
	 * Port of `upload_file` + `_wait_file_ready`: multipart POST with the
	 * PoW-solved challenge and the file metadata headers, then polls
	 * `/file/fetch_files` until the server reports SUCCESS.
	 */
	async uploadFile(data: Uint8Array, filename: string, mimeType: string): Promise<string> {
		const powResponse = await this._solvePow('/api/v0/file/upload_file');
		const headers = this._headers(powResponse);
		delete headers['content-type'];
		headers['x-file-size'] = String(data.byteLength);
		headers['x-model-type'] = 'vision';
		headers['x-thinking-enabled'] = '1';

		const boundary = `----NikaFormBoundary${Date.now().toString(36)}`;
		const chunks: Uint8Array[] = [];
		const enc = new TextEncoder();
		const push = (text: string): void => { chunks.push(enc.encode(text)); };
		push(`--${boundary}\r\n`);
		push(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`);
		push(`Content-Type: ${mimeType}\r\n\r\n`);
		chunks.push(data);
		push(`\r\n--${boundary}--\r\n`);

		const body = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
		let offset = 0;
		for (const c of chunks) {
			body.set(c, offset);
			offset += c.length;
		}

		const response = await this._fetcherService.fetch(`${DEEP_SEEK_WEB_BASE_URL}/file/upload_file`, {
			method: 'POST',
			headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
			// The fetcher options type only allows string bodies, but every
			// extension-host fetcher (node http, node-fetch, Electron net)
			// passes the body through untouched, so binary multipart data
			// survives byte-exact.
			body: body as unknown as string,
			callSite: 'nika-deepseek-web-upload',
		});
		if (response.status === 401) {
			throw new Error('Invalid or expired DeepSeek web authentication token');
		}
		if (response.status === 429) {
			throw new Error('DeepSeek web API rate limit exceeded');
		}
		if (!response.ok) {
			throw new Error(`DeepSeek web file upload failed with HTTP ${response.status}`);
		}
		const result = await response.json() as { data?: { biz_data?: { id?: unknown } } };
		const fileId = result?.data?.biz_data?.id;
		if (typeof fileId !== 'string') {
			throw new Error('Invalid upload response format from server');
		}
		await this._waitFileReady(fileId);
		return fileId;
	}

	/**
	 * Polls `/file/fetch_files` until the uploaded file is SUCCESS (or failed),
	 * so a completion never races a still-PENDING file id.
	 */
	private async _waitFileReady(fileId: string): Promise<void> {
		const deadline = Date.now() + UPLOAD_READY_TIMEOUT_MS;
		let lastInfo: unknown;
		while (Date.now() < deadline) {
			try {
				const response = await this._fetcherService.fetch(`${DEEP_SEEK_WEB_BASE_URL}/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`, {
					method: 'GET',
					headers: this._headers(),
					callSite: 'nika-deepseek-web-fetch-files',
				});
				if (response.ok) {
					const result = await response.json() as { data?: { biz_data?: { files?: Array<{ status?: string }> } } };
					const files = result?.data?.biz_data?.files ?? [];
					if (files.length > 0) {
						lastInfo = files[0];
						const status = files[0].status;
						if (status === 'SUCCESS') {
							return;
						}
						if (status === 'FAILED') {
							throw new Error('DeepSeek web file processing failed');
						}
					}
				}
			} catch (error) {
				if (error instanceof Error && error.message.includes('failed')) {
					throw error;
				}
				// Transient polling errors are retried.
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		throw new Error(`File ${fileId} did not become ready within ${UPLOAD_READY_TIMEOUT_MS / 1000}s: ${JSON.stringify(lastInfo)}`);
	}
}
