/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { DeepSeekWebClient, DeepSeekWebChunk, parseDeepSeekWebChunk } from '../deepSeekWebClient';

describe('parseDeepSeekWebChunk', () => {
	it('skips metadata, comments, and empty lines', () => {
		expect(parseDeepSeekWebChunk('', undefined)).toBeUndefined();
		expect(parseDeepSeekWebChunk('event: ready', undefined)).toBeUndefined();
		expect(parseDeepSeekWebChunk(': keep-alive', undefined)).toBeUndefined();
		expect(parseDeepSeekWebChunk('garbage line', undefined)).toBeUndefined();
		expect(parseDeepSeekWebChunk('data: not-json', undefined)).toBeUndefined();
	});

	it('extracts text from the initial response snapshot', () => {
		const chunk = parseDeepSeekWebChunk('data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"Hello"},{"type":"RESPONSE","content":" there"}]}}}', undefined);
		expect(chunk).toEqual<DeepSeekWebChunk>({ content: 'Hello there', type: 'content' });
	});

	it('extracts explicit APPEND patches to a content path', () => {
		const chunk = parseDeepSeekWebChunk('data: {"p":"response/fragments/-1/content","o":"APPEND","v":" world"}', undefined);
		expect(chunk).toEqual<DeepSeekWebChunk>({ content: ' world', type: 'content' });
	});

	it('treats a bare continuation as content when the last path was content', () => {
		const chunk = parseDeepSeekWebChunk('data: {"v":"!"}', 'response/fragments/-1/content');
		expect(chunk).toEqual<DeepSeekWebChunk>({ content: '!', type: 'content' });
	});

	it('ignores bare continuations without a known content path', () => {
		expect(parseDeepSeekWebChunk('data: {"v":"!"}', undefined)).toBeUndefined();
		expect(parseDeepSeekWebChunk('data: {"v":"!"}', 'response/fragments/-1/tokens')).toBeUndefined();
	});

	it('ignores APPEND patches to non-content paths', () => {
		expect(parseDeepSeekWebChunk('data: {"p":"response/fragments/-1/tokens","o":"APPEND","v":3}', undefined)).toBeUndefined();
	});

	it('reports FINISHED status', () => {
		const chunk = parseDeepSeekWebChunk('data: {"p":"response/status","o":"SET","v":"FINISHED"}', undefined);
		expect(chunk).toEqual<DeepSeekWebChunk>({ content: '', type: 'finish', finishReason: 'stop' });
	});

	it('reports ERROR status', () => {
		const chunk = parseDeepSeekWebChunk('data: {"p":"response/status","o":"SET","v":"ERROR"}', undefined);
		expect(chunk).toEqual<DeepSeekWebChunk>({ content: '', type: 'error', finishReason: 'error' });
	});

	it('detects FINISHED inside a BATCH op', () => {
		const chunk = parseDeepSeekWebChunk('data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","o":"SET","v":"FINISHED"}]}', undefined);
		expect(chunk).toEqual<DeepSeekWebChunk>({ content: '', type: 'finish', finishReason: 'stop' });
	});

	it('detects the biz_code error envelope', () => {
		const chunk = parseDeepSeekWebChunk('data: {"data":{"biz_code":9,"biz_msg":"invalid ref file id"}}', undefined);
		expect(chunk).toEqual<DeepSeekWebChunk>({ content: '', type: 'error', finishReason: 'error' });
	});

	it('ignores a zero biz_code envelope (not an error)', () => {
		expect(parseDeepSeekWebChunk('data: {"data":{"biz_code":0}}', undefined)).toBeUndefined();
	});

	it('falls back to OpenAI-style choices chunks', () => {
		const chunk = parseDeepSeekWebChunk('data: {"choices":[{"delta":{"content":"openai-style"}}]}', undefined);
		expect(chunk).toEqual<DeepSeekWebChunk>({ content: 'openai-style', type: 'content' });
	});
});

/** Minimal Response-like object the client consumes. */
function fakeResponse(status: number, body: unknown, sseText = ''): unknown {
	const ok = status >= 200 && status < 300;
	return {
		ok,
		status,
		json: async () => body,
		body: (() => {
			const bytes = new TextEncoder().encode(sseText);
			return {
				async *[Symbol.asyncIterator]() {
					let index = 0;
					while (index < bytes.length) {
						const value = bytes.slice(index, index + 64);
						index += value.length;
						yield value;
					}
				},
				destroy: async () => { },
			};
		})(),
	};
}

/** Fetcher stub routing by URL substring. */
function fakeFetcher(routes: Array<[string, (init: RequestInit) => unknown]>): IFetcherService {
	return {
		fetch: vi.fn(async (url: string, init: RequestInit) => {
			const hit = routes.find(([pattern]) => url.includes(pattern));
			if (!hit) {
				throw new Error(`Unexpected fetch: ${url}`);
			}
			return hit[1](init);
		}),
	} as unknown as IFetcherService;
}

const FAKE_CHALLENGE = {
	data: {
		biz_data: {
			challenge: {
				algorithm: 'DeepSeekHashV1',
				challenge: 'b0000b22959bad0cc1ecbbfa07f97191b20332fa10d7341ff9c7ba6e7ed927f1',
				salt: 'dde3ed472be5a2494ee0',
				difficulty: 144000,
				expire_at: 1_777_057_596_443,
				signature: 'test',
				target_path: '/api/v0/chat/completion',
			},
		},
	},
};

describe('DeepSeekWebClient', () => {
	it('creates a chat session from the nested webapp shape', async () => {
		const fetcher = fakeFetcher([
			['/chat_session/create', () => fakeResponse(200, { data: { biz_data: { chat_session: { id: 'session-abc' } } } })],
		]);
		const client = new DeepSeekWebClient('token', fetcher);
		await expect(client.createChatSession()).resolves.toBe('session-abc');
	});

	it('creates a chat session from the flat biz_data shape', async () => {
		const fetcher = fakeFetcher([
			['/chat_session/create', () => fakeResponse(200, { data: { biz_data: { id: 'session-flat' } } })],
		]);
		const client = new DeepSeekWebClient('token', fetcher);
		await expect(client.createChatSession()).resolves.toBe('session-flat');
	});

	it('throws on a 401 token rejection', async () => {
		const fetcher = fakeFetcher([
			['/chat_session/create', () => fakeResponse(401, {})],
		]);
		const client = new DeepSeekWebClient('token', fetcher);
		await expect(client.createChatSession()).rejects.toThrow('Invalid or expired DeepSeek web authentication token');
	});

	it('streams content, handles continuations, and stops on FINISHED', async () => {
		const fetcher = fakeFetcher([
			['/chat/create_pow_challenge', () => fakeResponse(200, FAKE_CHALLENGE)],
			['hif-leim', () => fakeResponse(200, { data: { biz_data: { value: 'leim-value' } } })],
			['/chat/completion', () => fakeResponse(200, {}, [
				'event: ready\n',
				'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"Hello"}]}}}\n',
				'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" world"}\n',
				'data: {"v":"!"}\n',
				'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n',
			].join(''))],
		]);
		const client = new DeepSeekWebClient('token', fetcher);
		const chunks: string[] = [];
		for await (const chunk of client.streamCompletion({ chatSessionId: 'session-abc', prompt: 'hi' }, CancellationToken.None)) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual(['Hello', ' world', '!']);
	});

	it('sends the solved PoW header and the session body', async () => {
		let capturedInit: RequestInit | undefined;
		const fetcher = fakeFetcher([
			['/chat/create_pow_challenge', () => fakeResponse(200, FAKE_CHALLENGE)],
			['hif-leim', () => fakeResponse(200, { data: { biz_data: { value: 'leim-value' } } })],
			['/chat/completion', (init) => {
				capturedInit = init;
				return fakeResponse(200, {}, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n');
			}],
		]);
		const client = new DeepSeekWebClient('token', fetcher);
		const chunks: string[] = [];
		for await (const chunk of client.streamCompletion({ chatSessionId: 'session-abc', prompt: 'hi', thinkingEnabled: false }, CancellationToken.None)) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual([]);
		const headers = capturedInit!.headers as Record<string, string>;
		expect(headers['authorization']).toBe('Bearer token');
		expect(headers['x-ds-pow-response']).toBeTruthy();
		expect(headers['x-hif-leim']).toBe('leim-value');
		const body = JSON.parse(capturedInit!.body as string);
		expect(body.chat_session_id).toBe('session-abc');
		expect(body.prompt).toBe('hi');
		expect(body.thinking_enabled).toBe(false);
		expect(body.ref_file_ids).toEqual([]);
		// No images: the webapp's default mode is `default` (Instant).
		expect(body.model_type).toBe('default');
	});

	it('passes an explicit model type through (expert / vision)', async () => {
		const bodies: string[] = [];
		const fetcher = fakeFetcher([
			['/chat/create_pow_challenge', () => fakeResponse(200, FAKE_CHALLENGE)],
			['hif-leim', () => fakeResponse(200, { data: { biz_data: { value: 'leim-value' } } })],
			['/chat/completion', (init) => {
				bodies.push(init.body as string);
				return fakeResponse(200, {}, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n');
			}],
		]);
		const client = new DeepSeekWebClient('token', fetcher);
		for await (const _ of client.streamCompletion({ chatSessionId: 's', prompt: 'a', modelType: 'expert' }, CancellationToken.None)) { /* drain */ }
		for await (const _ of client.streamCompletion({ chatSessionId: 's', prompt: 'b', modelType: 'vision' }, CancellationToken.None)) { /* drain */ }
		expect(JSON.parse(bodies[0]).model_type).toBe('expert');
		expect(JSON.parse(bodies[1]).model_type).toBe('vision');
	});

	it('forces model_type vision when ref files are present', async () => {
		let capturedBody: string | undefined;
		const fetcher = fakeFetcher([
			['/chat/create_pow_challenge', () => fakeResponse(200, FAKE_CHALLENGE)],
			['hif-leim', () => fakeResponse(200, { data: { biz_data: { value: 'leim-value' } } })],
			['/chat/completion', (init) => {
				capturedBody = init.body as string;
				return fakeResponse(200, {}, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n');
			}],
		]);
		const client = new DeepSeekWebClient('token', fetcher);
		for await (const _ of client.streamCompletion({ chatSessionId: 's', prompt: 'look', refFileIds: ['file-1'] }, CancellationToken.None)) { /* drain */ }
		expect(JSON.parse(capturedBody!).model_type).toBe('vision');
	});

	it('throws on a biz_code error envelope mid-stream', async () => {
		const fetcher = fakeFetcher([
			['/chat/create_pow_challenge', () => fakeResponse(200, FAKE_CHALLENGE)],
			['hif-leim', () => fakeResponse(200, { data: { biz_data: { value: 'leim-value' } } })],
			['/chat/completion', () => fakeResponse(200, {}, 'data: {"data":{"biz_code":9,"biz_msg":"invalid"}}\n')],
		]);
		const client = new DeepSeekWebClient('token', fetcher);
		const generator = client.streamCompletion({ chatSessionId: 's', prompt: 'p' }, CancellationToken.None);
		await expect(generator.next()).rejects.toThrow('DeepSeek web API error');
	});

	it('uploads an image with multipart metadata and waits for SUCCESS', async () => {
		const uploadCalls: Array<{ init: RequestInit }> = [];
		const fetcher = fakeFetcher([
			['/chat/create_pow_challenge', () => fakeResponse(200, FAKE_CHALLENGE)],
			['/file/upload_file', (init) => {
				uploadCalls.push({ init });
				return fakeResponse(200, { data: { biz_data: { id: 'file-1' } } });
			}],
			['/file/fetch_files', () => fakeResponse(200, { data: { biz_data: { files: [{ status: 'SUCCESS' }] } } })],
		]);
		const client = new DeepSeekWebClient('token', fetcher);
		const data = new Uint8Array([1, 2, 3, 4]);
		await expect(client.uploadFile(data, 'image-1.png', 'image/png')).resolves.toBe('file-1');
		expect(uploadCalls).toHaveLength(1);
		const headers = uploadCalls[0].init.headers as Record<string, string>;
		expect(headers['x-file-size']).toBe('4');
		expect(headers['x-model-type']).toBe('vision');
		expect(headers['x-thinking-enabled']).toBe('1');
		expect(headers['x-ds-pow-response']).toBeTruthy();
		expect(headers['content-type']).toContain('multipart/form-data; boundary=----NikaFormBoundary');
		const body = new TextDecoder().decode(uploadCalls[0].init.body as Uint8Array);
		expect(body).toContain('Content-Disposition: form-data; name="file"; filename="image-1.png"');
		expect(body).toContain('Content-Type: image/png');
	});

	it('fails the upload when the file never becomes ready', async () => {
		vi.useFakeTimers();
		try {
			const fetcher = fakeFetcher([
				['/chat/create_pow_challenge', () => fakeResponse(200, FAKE_CHALLENGE)],
				['/file/upload_file', () => fakeResponse(200, { data: { biz_data: { id: 'file-1' } } })],
				// Forever PENDING: the poll loop must time out.
				['/file/fetch_files', () => fakeResponse(200, { data: { biz_data: { files: [{ status: 'PENDING' }] } } })],
			]);
			const client = new DeepSeekWebClient('token', fetcher);
			const uploading = client.uploadFile(new Uint8Array([1]), 'a.png', 'image/png');
			// Attach the rejection handler before the timers fire so vitest
			// never sees an unhandled rejection.
			const rejection = expect(uploading).rejects.toThrow('did not become ready');
			await vi.advanceTimersByTimeAsync(25_000);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});
});
