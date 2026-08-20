/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { LLAMACPP_DEFAULT_CONTEXT_WINDOW, LLAMACPP_DEFAULT_MAX_OUTPUT_TOKENS, NikaLlamaCppProvider, nikaLlamaCppModelId } from '../nikaLlamaCppProvider';
import { OpenAIEndpoint } from '../../node/openAIEndpoint';

function modelsResponse() {
	return {
		object: 'list',
		data: [
			{ id: 'qwen2.5vl-7b', object: 'model', created: 1710000000, owned_by: 'local' },
			{ id: 'llama-3.2-3b', object: 'model', created: 1710000001, owned_by: 'local' },
		],
	};
}

function createProvider(overrides?: { json?: unknown; ok?: boolean; status?: number }) {
	const json = vi.fn().mockResolvedValue(overrides?.json ?? modelsResponse());
	const fetch = vi.fn().mockResolvedValue({ ok: overrides?.ok ?? true, status: overrides?.status ?? 200, json });
	const createInstance = vi.fn();
	const provider = new NikaLlamaCppProvider(
		{ fetch } as never,
		{ createInstance } as never,
	);
	return { provider, fetch, createInstance };
}

describe('NikaLlamaCppProvider', () => {
	it('fetches the server model list with optional bearer auth', async () => {
		const { provider, fetch } = createProvider();
		await provider.getCatalog('http://localhost:8080', 'secret');

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('http://localhost:8080/v1/models');
		expect(init.headers.Authorization).toBe('Bearer secret');
		expect(init.callSite).toBe('nika-llamacpp-models');
	});

	it('omits the auth header when no key is supplied', async () => {
		const { provider, fetch } = createProvider();
		await provider.getCatalog('http://localhost:8080');

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('http://localhost:8080/v1/models');
		expect(init.headers).toBeUndefined();
	});

	it('maps server entries to default capabilities', async () => {
		const { provider } = createProvider();
		const catalog = await provider.getCatalog('http://localhost:8080');

		const model = catalog.get('qwen2.5vl-7b');
		expect(model).toBeDefined();
		expect(model!.name).toBe('qwen2.5vl-7b');
		expect(model!.contextWindow).toBe(LLAMACPP_DEFAULT_CONTEXT_WINDOW);
		expect(model!.capabilities.contextWindow).toBe(LLAMACPP_DEFAULT_CONTEXT_WINDOW);
		expect(model!.capabilities.maxOutputTokens).toBe(LLAMACPP_DEFAULT_MAX_OUTPUT_TOKENS);
		expect(model!.capabilities.maxInputTokens).toBe(LLAMACPP_DEFAULT_CONTEXT_WINDOW - LLAMACPP_DEFAULT_MAX_OUTPUT_TOKENS);
		expect(model!.capabilities.toolCalling).toBe(true);
		// The server decides whether a loaded model accepts images; advertise
		// vision so multimodal GGUFs work natively.
		expect(model!.capabilities.vision).toBe(true);
		expect(model!.capabilities.thinking).toBe(false);
		expect(catalog.size).toBe(2);
	});

	it('reads the served context from launch args for every model, and meta.n_ctx for the loaded one', async () => {
		const { provider } = createProvider({
			json: {
				object: 'list',
				data: [
					// Unloaded model: no meta at all, but status.args carries --ctx-size.
					{
						id: 'qwen-q6-262k',
						object: 'model',
						owned_by: 'llamacpp',
						status: { value: 'unloaded', args: ['llama-server.exe', '--alias', 'qwen-q6-262k', '--ctx-size', '262144', '--model', 'C:/Models/Qwen3.8-27B-Q6_K.gguf'] },
					},
					// Loaded model: meta.n_ctx is the served context, not n_ctx_train.
					{
						id: 'qwen-q8-64k',
						object: 'model',
						owned_by: 'llamacpp',
						status: { value: 'loaded', args: ['llama-server.exe', '--alias', 'qwen-q8-64k', '--ctx-size', '65536'] },
						meta: { n_ctx: 65536, n_ctx_train: 262144, n_vocab: 248320 },
					},
					// Inline --ctx-size=<n> form.
					{
						id: 'inline-form',
						object: 'model',
						owned_by: 'llamacpp',
						status: { value: 'unloaded', args: ['llama-server.exe', '--ctx-size=8192', '--model', 'C:/Models/x.gguf'] },
					},
				],
			},
		});
		const catalog = await provider.getCatalog('http://localhost:8080');

		expect(catalog.get('qwen-q6-262k')!.contextWindow).toBe(262144);
		expect(catalog.get('qwen-q8-64k')!.contextWindow).toBe(65536);
		expect(catalog.get('qwen-q8-64k')!.capabilities.maxInputTokens).toBe(65536 - LLAMACPP_DEFAULT_MAX_OUTPUT_TOKENS);
		expect(catalog.get('qwen-q8-64k')!.capabilities.maxOutputTokens).toBe(LLAMACPP_DEFAULT_MAX_OUTPUT_TOKENS);
		expect(catalog.get('inline-form')!.contextWindow).toBe(8192);
	});

	it('accepts meta.llama.context_length from forks and meta.n_ctx', async () => {
		const { provider } = createProvider({
			json: {
				object: 'list',
				data: [
					{ id: 'fork-string', object: 'model', created: 1, owned_by: 'llamacpp', meta: { 'llama.context_length': '262144' } },
					{ id: 'fork-number', object: 'model', created: 2, owned_by: 'llamacpp', meta: { 'llama.context_length': 65536 } },
				],
			},
		});
		const catalog = await provider.getCatalog('http://localhost:8080');

		expect(catalog.get('fork-string')!.contextWindow).toBe(262144);
		expect(catalog.get('fork-number')!.contextWindow).toBe(65536);
	});

	it('falls back to the default window when context is absent or invalid', async () => {
		const { provider } = createProvider({
			json: {
				object: 'list',
				data: [
					{ id: 'unloaded', object: 'model', created: 1, owned_by: 'llamacpp' },
					{ id: 'noargs', object: 'model', created: 2, owned_by: 'llamacpp', status: { value: 'unloaded', args: ['llama-server.exe', '--model', 'C:/Models/x.gguf'] } },
					{ id: 'broken', object: 'model', created: 3, owned_by: 'llamacpp', meta: { 'llama.context_length': 'lots' } },
					{ id: 'zero', object: 'model', created: 4, owned_by: 'llamacpp', meta: { 'llama.context_length': '0' } },
				],
			},
		});
		const catalog = await provider.getCatalog('http://localhost:8080');

		for (const id of ['unloaded', 'noargs', 'broken', 'zero']) {
			expect(catalog.get(id)!.contextWindow).toBe(LLAMACPP_DEFAULT_CONTEXT_WINDOW);
		}
	});

	it('skips entries without an id and exposes known models', async () => {
		const { provider } = createProvider({ json: { object: 'list', data: [{ created: 1 }, { id: 'llama-3.2-3b' }] } });
		const catalog = await provider.getCatalog('http://localhost:8080');

		expect(catalog.size).toBe(1);
		const known = await provider.getKnownModels('http://localhost:8080');
		expect(known['llama-3.2-3b'].vision).toBe(true);
		expect(known['llama-3.2-3b'].toolCalling).toBe(true);
	});

	it('caches per base URL with a TTL and refetches on a different URL', async () => {
		const { provider, fetch } = createProvider();
		await provider.getCatalog('http://localhost:8080');
		await provider.getCatalog('http://localhost:8080');
		expect(fetch).toHaveBeenCalledTimes(1);

		await provider.getCatalog('http://localhost:9090');
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('refetches after invalidateCache', async () => {
		const { provider, fetch } = createProvider();
		await provider.getCatalog('http://localhost:8080');
		provider.invalidateCache();
		await provider.getCatalog('http://localhost:8080');
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('rethrows a non-ok response', async () => {
		const { provider } = createProvider({ ok: false, status: 500 });
		await expect(provider.getCatalog('http://localhost:8080')).rejects.toThrow(/HTTP 500/);
	});

	it('serves the last known catalog when a refetch fails (stale-while-revalidate)', async () => {
		vi.useFakeTimers();
		try {
			const { provider, fetch } = createProvider();
			await provider.getCatalog('http://localhost:8080');
			expect(fetch).toHaveBeenCalledTimes(1);

			// Expire the TTL, then make the refetch fail (e.g. the server
			// reloading a model after an idle unload): the last known list is
			// served instead of emptying the picker.
			vi.setSystemTime(Date.now() + 11 * 60 * 1000);
			fetch.mockResolvedValueOnce({ ok: false, status: 500, json: vi.fn() });
			const catalog = await provider.getCatalog('http://localhost:8080');

			expect(fetch).toHaveBeenCalledTimes(2);
			expect(catalog.get('qwen2.5vl-7b')).toBeDefined();
			expect(catalog.size).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('creates a chat completions endpoint with the resolved model info', async () => {
		const { provider, createInstance } = createProvider();
		await provider.getCatalog('http://localhost:8080');

		provider.createEndpoint('qwen2.5vl-7b', 'http://localhost:8080', 'secret');

		const call = createInstance.mock.calls.at(-1)!;
		expect(call[0]).toBe(OpenAIEndpoint);
		// The wire model id is the raw server id (no `llamacpp/` prefix).
		expect((call[1] as { id: string }).id).toBe('qwen2.5vl-7b');
		expect(call[2]).toBe('secret');
		expect(call[3]).toBe('http://localhost:8080/v1/chat/completions');
	});

	it('creates an unauthenticated endpoint when the key is empty', async () => {
		const { provider, createInstance } = createProvider();
		await provider.getCatalog('http://localhost:8080');

		provider.createEndpoint('qwen2.5vl-7b', 'http://localhost:8080');

		const call = createInstance.mock.calls.at(-1)!;
		expect(call[2]).toBe('');
	});

	it('qualifies raw server ids with the llamacpp provider prefix', () => {
		expect(nikaLlamaCppModelId('qwen2.5vl-7b')).toBe('llamacpp/qwen2.5vl-7b');
	});
});
