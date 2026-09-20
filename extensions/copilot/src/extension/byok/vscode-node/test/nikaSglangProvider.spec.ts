/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { NikaSglangProvider, SGLANG_DEFAULT_CONTEXT_WINDOW, SGLANG_DEFAULT_MAX_OUTPUT_TOKENS } from '../nikaSglangProvider';
import { NikaSglangServer } from '../nikaModels';

function server(id: string, baseUrl: string, label = id): NikaSglangServer {
	return { id, label, baseUrl };
}

function modelsResponse(entries: unknown[] = [
	{ id: 'Qwen/Qwen3-32B', object: 'model', root: 'Qwen/Qwen3-32B', max_model_len: 65536 },
	{ id: 'Qwen/Qwen2.5-VL-7B-Instruct', object: 'model', root: 'Qwen/Qwen2.5-VL-7B-Instruct', max_model_len: 32768 },
]) {
	return { object: 'list', data: entries };
}

/**
 * Wires a provider with a fetcher whose `/v1/models` answers per URL, so each
 * test can model independent servers (including unreachable ones).
 */
function createProvider(answers?: Record<string, { ok?: boolean; status?: number; json?: unknown } | Error>) {
	const calls: Array<{ url: string; init: { headers?: Record<string, string>; callSite?: string } }> = [];
	const createInstance = vi.fn((_ctor: unknown, ...args: unknown[]) => ({ endpointArgs: args }));
	const fetch = vi.fn(async (url: string, init: { headers?: Record<string, string>; callSite?: string }) => {
		calls.push({ url, init });
		const answer = answers?.[url];
		if (answer instanceof Error) {
			throw answer;
		}
		if (url.endsWith('/get_server_info')) {
			// Optional endpoint: absent unless a test opts in.
			return { ok: false, status: 404, json: async () => ({}) };
		}
		return { ok: answer?.ok ?? true, status: answer?.status ?? 200, json: async () => answer?.json ?? modelsResponse() };
	});
	const provider = new NikaSglangProvider({ fetch } as never, { createInstance } as never);
	return { provider, fetch, createInstance, calls };
}

describe('NikaSglangProvider', () => {
	it('fetches each server catalog from its own URL with its own bearer key', async () => {
		const { provider, calls } = createProvider();
		const box1 = server('box1', 'http://10.0.0.5:30000');
		const box2 = server('box2', 'http://10.0.0.6:30000');

		await provider.getCatalog(box1, 'key-one');
		await provider.getCatalog(box2);

		expect(calls.map(call => call.url)).toEqual([
			'http://10.0.0.5:30000/v1/models',
			'http://10.0.0.6:30000/v1/models',
		]);
		expect(calls[0].init.headers?.Authorization).toBe('Bearer key-one');
		// An absent key means an unauthenticated request.
		expect(calls[1].init.headers).toBeUndefined();
		expect(calls[0].init.callSite).toBe('nika-sglang-models');
	});

	it('caches per server so one server never hides another', async () => {
		const answers = {
			'http://10.0.0.5:30000/v1/models': { json: modelsResponse([{ id: 'a-model', max_model_len: 8192 }]) },
			'http://10.0.0.6:30000/v1/models': { json: modelsResponse([{ id: 'b-model', max_model_len: 8192 }]) },
		};
		const { provider, calls } = createProvider(answers);

		// A cached read is served from memory; a different server still fetches.
		await provider.getCatalog(server('box1', 'http://10.0.0.5:30000'));
		await provider.getCatalog(server('box1', 'http://10.0.0.5:30000'));
		await provider.getCatalog(server('box2', 'http://10.0.0.6:30000'));

		expect(calls).toHaveLength(2);
		expect([...(await provider.getCatalog(server('box1', 'http://10.0.0.5:30000'))).keys()]).toEqual(['a-model']);
		expect([...(await provider.getCatalog(server('box2', 'http://10.0.0.6:30000'))).keys()]).toEqual(['b-model']);
	});

	it('keeps the last good catalog when a server becomes unreachable', async () => {
		const answers: Record<string, { ok?: boolean; status?: number; json?: unknown } | Error> = {
			'http://10.0.0.5:30000/v1/models': { json: modelsResponse([{ id: 'kept-model', max_model_len: 4096 }]) },
		};
		const { provider } = createProvider(answers);
		const box1 = server('box1', 'http://10.0.0.5:30000');
		await provider.getCatalog(box1);

		// Expire the TTL and make the server fail.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + 11 * 60 * 1000);
			answers['http://10.0.0.5:30000/v1/models'] = new Error('ECONNREFUSED');
			const catalog = await provider.getCatalog(box1);
			expect([...catalog.keys()]).toEqual(['kept-model']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('surfaces the failure when a server was never reachable', async () => {
		const { provider } = createProvider({ 'http://10.0.0.5:30000/v1/models': new Error('ECONNREFUSED') });
		await expect(provider.getCatalog(server('box1', 'http://10.0.0.5:30000'))).rejects.toThrow('ECONNREFUSED');
	});

	it('reports a non-OK response with the server label', async () => {
		const { provider } = createProvider({ 'http://10.0.0.5:30000/v1/models': { ok: false, status: 503 } });
		await expect(provider.getCatalog(server('box1', 'http://10.0.0.5:30000', 'GPU 1'))).rejects.toThrow('GPU 1');
	});

	it('uses the served context window and falls back to the default', async () => {
		const entries = [
			{ id: 'explicit', max_model_len: 131072 },
			// Older builds omit the length on the model entry.
			{ id: 'unknown' },
		];
		const { provider } = createProvider({ 'http://10.0.0.5:30000/v1/models': { json: modelsResponse(entries) } });
		const catalog = await provider.getCatalog(server('box1', 'http://10.0.0.5:30000'));

		expect(catalog.get('explicit')!.contextWindow).toBe(131072);
		expect(catalog.get('explicit')!.capabilities.maxOutputTokens).toBe(SGLANG_DEFAULT_MAX_OUTPUT_TOKENS);
		expect(catalog.get('explicit')!.capabilities.maxInputTokens).toBe(131072 - SGLANG_DEFAULT_MAX_OUTPUT_TOKENS);
		expect(catalog.get('unknown')!.contextWindow).toBe(SGLANG_DEFAULT_CONTEXT_WINDOW);
		// SGLang implements the OpenAI tools contract and serves multimodal
		// models; the server rejects images for text-only models.
		expect(catalog.get('explicit')!.capabilities.toolCalling).toBe(true);
		expect(catalog.get('explicit')!.capabilities.vision).toBe(true);
		expect(catalog.get('explicit')!.capabilities.thinking).toBe(false);
	});

	it('reads the launch context from /get_server_info when the model entry omits it', async () => {
		const { provider, calls } = createProvider({
			'http://10.0.0.5:30000/v1/models': { json: modelsResponse([{ id: 'Qwen/Qwen3-32B' }]) },
		});
		// Answer the optional server-info probe with the serialized launch args.
		const fetchMock = (provider as unknown as { _fetcherService: { fetch: ReturnType<typeof vi.fn> } })._fetcherService.fetch;
		fetchMock.mockImplementation(async (url: string, init: { callSite?: string }) => {
			calls.push({ url, init });
			if (url.endsWith('/get_server_info')) {
				return { ok: true, status: 200, json: async () => ({ context_length: 32768, model_config: { max_position_embeddings: 131072 } }) };
			}
			return { ok: true, status: 200, json: async () => modelsResponse([{ id: 'Qwen/Qwen3-32B' }]) };
		});

		const catalog = await provider.getCatalog(server('box1', 'http://10.0.0.5:30000'));

		expect(calls.map(call => call.url)).toEqual([
			'http://10.0.0.5:30000/v1/models',
			'http://10.0.0.5:30000/get_server_info',
		]);
		expect(catalog.get('Qwen/Qwen3-32B')!.contextWindow).toBe(32768);
	});

	it('never collapses the prompt budget on a small server context', async () => {
		const { provider } = createProvider({
			'http://10.0.0.5:30000/v1/models': { json: modelsResponse([{ id: 'tiny', max_model_len: 2048 }]) },
		});
		const catalog = await provider.getCatalog(server('box1', 'http://10.0.0.5:30000'));

		const capabilities = catalog.get('tiny')!.capabilities;
		// A fixed 4096-token output reservation would zero out the input budget
		// and make every request fail while rendering the prompt.
		expect(capabilities.maxOutputTokens).toBe(1024);
		expect(capabilities.maxInputTokens).toBeGreaterThan(0);
	});

	it('drops an empty data array instead of failing', async () => {
		const { provider } = createProvider({ 'http://10.0.0.5:30000/v1/models': { json: { object: 'list', data: [null, {}, { id: '' }, 42] } } });
		const catalog = await provider.getCatalog(server('box1', 'http://10.0.0.5:30000'));
		expect(catalog.size).toBe(0);
	});

	it('creates a chat-completions endpoint for the server that owns the model', async () => {
		const { provider, createInstance } = createProvider();
		const box1 = server('box1', 'http://10.0.0.5:30000');
		await provider.getCatalog(box1, 'key-one');

		provider.createEndpoint('Qwen/Qwen3-32B', box1, 'key-one');

		expect(createInstance).toHaveBeenCalledTimes(1);
		const [, ...args] = createInstance.mock.calls[0];
		expect(args[0]).toMatchObject({ id: 'Qwen/Qwen3-32B' });
		expect(args[1]).toBe('key-one');
		expect(args[2]).toBe('http://10.0.0.5:30000/v1/chat/completions');
	});

	it('passes an empty key for unauthenticated servers', async () => {
		const { provider, createInstance } = createProvider();
		provider.createEndpoint('model', server('box1', 'http://10.0.0.5:30000'));
		const [, ...args] = createInstance.mock.calls[0];
		expect(args[1]).toBe('');
	});

	it('invalidates every cached catalog at once', async () => {
		const { provider, calls } = createProvider();
		const box1 = server('box1', 'http://10.0.0.5:30000');
		const box2 = server('box2', 'http://10.0.0.6:30000');
		await provider.getCatalog(box1);
		await provider.getCatalog(box2);

		provider.invalidateCache();
		await provider.getCatalog(box1);

		expect(calls).toHaveLength(3);
	});

	it('exposes the catalog as BYOK known models keyed by raw id', async () => {
		const { provider } = createProvider();
		const known = await provider.getKnownModels(server('box1', 'http://10.0.0.5:30000'));

		expect(Object.keys(known)).toEqual(['Qwen/Qwen3-32B', 'Qwen/Qwen2.5-VL-7B-Instruct']);
		expect(known['Qwen/Qwen3-32B'].name).toBe('Qwen/Qwen3-32B');
	});
});
