/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { NikaOpenRouterProvider, nikaOpenRouterModelId, OPENROUTER_BASE_URL } from '../nikaOpenRouterProvider';
import { OpenRouterEndpoint } from '../openRouterProvider';

function catalogResponse() {
	return {
		data: [
			{
				id: 'anthropic/claude-sonnet-4',
				name: 'Claude Sonnet 4',
				supported_parameters: ['tools', 'reasoning', 'web_search'],
				architecture: { input_modalities: ['text', 'image'] },
				context_length: 200000,
				pricing: { prompt: '3', completion: '15', request: '0.005', image: '0.0113', web_search: '0.005', cache_read: '0.3', cache_write: '3' },
				top_provider: { context_length: 200000, max_completion_tokens: 64000 },
			},
			{
				id: 'deepseek/deepseek-chat-v3-0324:free',
				name: 'DeepSeek Chat V3 (free)',
				supported_parameters: ['tools'],
				architecture: { input_modalities: ['text'] },
				context_length: 128000,
				pricing: { prompt: '0', completion: '0', request: '0' },
				top_provider: { context_length: 128000 },
			},
			{
				id: 'qwen/qwen3-coder:nitro',
				name: 'Qwen3 Coder (nitro)',
				supported_parameters: ['tools'],
				context_length: 262144,
				top_provider: { context_length: 262144, max_completion_tokens: 32000 },
			},
		],
	};
}

function createProvider(overrides?: { json?: unknown; ok?: boolean; status?: number }) {
	const json = vi.fn().mockResolvedValue(overrides?.json ?? catalogResponse());
	const fetch = vi.fn().mockResolvedValue({ ok: overrides?.ok ?? true, status: overrides?.status ?? 200, json });
	const createInstance = vi.fn();
	const provider = new NikaOpenRouterProvider(
		{ fetch } as never,
		{ createInstance } as never,
	);
	return { provider, fetch, createInstance };
}

describe('NikaOpenRouterProvider', () => {
	it('fetches the full catalog URL with bearer auth and no supported_parameters filter', async () => {
		const { provider, fetch } = createProvider();
		await provider.getCatalog('sk-or-1');

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe(`${OPENROUTER_BASE_URL}/models`);
		expect(url).not.toContain('supported_parameters');
		expect(init.headers.Authorization).toBe('Bearer sk-or-1');
	});

	it('maps catalog entries to capabilities with pricing', async () => {
		const { provider } = createProvider();
		const catalog = await provider.getCatalog('sk-or-1');

		const claude = catalog.get('anthropic/claude-sonnet-4');
		expect(claude).toBeDefined();
		expect(claude!.name).toBe('Claude Sonnet 4');
		expect(claude!.capabilities.vision).toBe(true);
		expect(claude!.contextWindow).toBe(200000);
		expect(claude!.capabilities.toolCalling).toBe(true);
		expect(claude!.capabilities.supportsReasoningEffort).toEqual(['low', 'medium', 'high']);
		// max_completion_tokens is honored as the output budget.
		expect(claude!.capabilities.maxOutputTokens).toBe(64000);
		expect(claude!.capabilities.maxInputTokens).toBe(200000 - 64000);
		// Pricing flows into capabilities for the model picker.
		expect(claude!.capabilities.pricing).toEqual({
			label: '$3/M in · $15/M out · cache $0.3/M · $0.005/req',
			inputCost: 3,
			outputCost: 15,
			cacheCost: 0.3,
		});
		expect(claude!.pricing).toBeDefined();
		expect(claude!.pricing!.requestFee).toBe(0.005);
	});

	it('flags all-zero pricing as free and keeps a catalog id suffix', async () => {
		const { provider } = createProvider();
		const catalog = await provider.getCatalog('sk-or-1');

		const free = catalog.get('deepseek/deepseek-chat-v3-0324:free');
		expect(free).toBeDefined();
		expect(free!.pricing!.free).toBe(true);
		expect(free!.capabilities.pricing!.label).toBe('Free');
		// The `:free` suffix survives so users can tell variants apart.
		expect(free!.id).toBe('deepseek/deepseek-chat-v3-0324:free');
	});

	it('keeps entries without pricing and defaults the output budget', async () => {
		const { provider } = createProvider();
		const catalog = await provider.getCatalog('sk-or-1');

		const qwen = catalog.get('qwen/qwen3-coder:nitro');
		expect(qwen).toBeDefined();
		expect(qwen!.pricing).toBeUndefined();
		expect(qwen!.capabilities.pricing).toBeUndefined();
		expect(qwen!.capabilities.maxOutputTokens).toBe(32000);
	});

	it('caches per key with a TTL and refetches on a different key', async () => {
		const { provider, fetch } = createProvider();
		await provider.getCatalog('sk-or-1');
		await provider.getCatalog('sk-or-1');
		expect(fetch).toHaveBeenCalledTimes(1);

		await provider.getCatalog('sk-or-2');
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('rethrows a non-ok catalog response', async () => {
		const { provider } = createProvider({ ok: false, status: 401 });
		await expect(provider.getCatalog('sk-or-bad')).rejects.toThrow(/HTTP 401/);
	});

	it('creates a Messages endpoint for Anthropic models and chat completions otherwise', async () => {
		const { provider, createInstance } = createProvider();
		await provider.getCatalog('sk-or-1');

		provider.createEndpoint('anthropic/claude-sonnet-4', 'sk-or-1');
		const anthropicCall = createInstance.mock.calls.at(-1)!;
		expect(anthropicCall[0]).toBe(OpenRouterEndpoint);
		expect(anthropicCall[3]).toBe(`${OPENROUTER_BASE_URL}/messages`);
		// The wire model id is the raw catalog id (no `openrouter/` prefix).
		expect((anthropicCall[1] as { id: string }).id).toBe('anthropic/claude-sonnet-4');

		provider.createEndpoint('qwen/qwen3-coder:nitro', 'sk-or-1');
		const openaiCall = createInstance.mock.calls.at(-1)!;
		expect(openaiCall[3]).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
	});

	it('qualifies raw catalog ids with the openrouter provider prefix', () => {
		expect(nikaOpenRouterModelId('anthropic/claude-sonnet-4')).toBe('openrouter/anthropic/claude-sonnet-4');
	});
});
