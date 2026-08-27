/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { ModelSupportedEndpoint } from '../../../../platform/endpoint/common/endpointProvider';
import { ANTHROPIC_BASE_URL, ANTHROPIC_VERSION, NikaAnthropicProvider, nikaAnthropicModelId, resolveAnthropicModelCapabilities } from '../nikaAnthropicProvider';
import { NIKA_ANTHROPIC_MODEL_PREFIX, resolveNikaTokenLimits } from '../nikaModels';

const LIMITS = resolveNikaTokenLimits('128K', '8K');

function catalogResponse() {
	return {
		data: [
			{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model', created_at: '2025-09-29T00:00:00Z' },
			{ id: 'claude-opus-4', display_name: 'Claude Opus 4', type: 'model', created_at: '2025-05-06T00:00:00Z' },
			{ id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', type: 'model', created_at: '2025-10-22T00:00:00Z' },
		],
	};
}

function createProvider(overrides?: { json?: unknown; ok?: boolean; status?: number }) {
	const json = vi.fn().mockResolvedValue(overrides?.json ?? catalogResponse());
	const fetch = vi.fn().mockResolvedValue({ ok: overrides?.ok ?? true, status: overrides?.status ?? 200, json });
	const delegate = {
		provideLanguageModelChatResponse: vi.fn().mockResolvedValue(undefined),
		provideTokenCount: vi.fn().mockResolvedValue(7),
	};
	const createInstance = vi.fn().mockReturnValue(delegate);
	const provider = new NikaAnthropicProvider(
		{} as never,
		{ fetch } as never,
		{ createInstance } as never,
	);
	return { provider, fetch, delegate, createInstance };
}

describe('NikaAnthropicProvider', () => {
	it('fetches the catalog with x-api-key and anthropic-version headers', async () => {
		const { provider, fetch } = createProvider();
		const catalog = await provider.getCatalog('sk-ant-1', LIMITS);

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe(`${ANTHROPIC_BASE_URL}/models`);
		expect(init.headers['x-api-key']).toBe('sk-ant-1');
		expect(init.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);

		const sonnet = catalog.get('claude-sonnet-4-5');
		expect(sonnet).toBeDefined();
		// The catalog's display_name wins over the prettified fallback.
		expect(sonnet!.name).toBe('Claude Sonnet 4.5');
		expect(sonnet!.capabilities.vision).toBe(true);
		expect(sonnet!.capabilities.thinking).toBe(true);
		expect(sonnet!.capabilities.toolCalling).toBe(true);
		expect(sonnet!.capabilities.supportsReasoningEffort).toBeUndefined();
		expect(sonnet!.capabilities.supportedEndpoints).toEqual([ModelSupportedEndpoint.Messages]);
	});

	it('caches the catalog per API key within the TTL (single slot)', async () => {
		const { provider, fetch } = createProvider();
		await provider.getCatalog('key-a', LIMITS);
		await provider.getCatalog('key-a', LIMITS); // cache hit
		await provider.getCatalog('key-b', LIMITS); // cache miss, evicts key-a
		await provider.getCatalog('key-a', LIMITS); // miss again: single-slot cache

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(fetch.mock.calls[0][1].headers['x-api-key']).toBe('key-a');
		expect(fetch.mock.calls[1][1].headers['x-api-key']).toBe('key-b');
		expect(fetch.mock.calls[2][1].headers['x-api-key']).toBe('key-a');
	});

	it('refetches after invalidateCache and reports non-OK responses', async () => {
		const { provider, fetch } = createProvider({ json: catalogResponse(), ok: false, status: 401 });
		await expect(provider.getCatalog('bad-key', LIMITS)).rejects.toThrow('HTTP 401');
		expect(fetch).toHaveBeenCalledTimes(1);

		const { provider: okProvider, fetch: okFetch } = createProvider();
		await okProvider.getCatalog('key', LIMITS);
		okProvider.invalidateCache();
		await okProvider.getCatalog('key', LIMITS);
		expect(okFetch).toHaveBeenCalledTimes(2);
	});

	it('delegates chat requests with the raw id and Nika API key', async () => {
		const { provider, delegate } = createProvider();
		const model = {
			id: `${NIKA_ANTHROPIC_MODEL_PREFIX}claude-sonnet-4-5`,
			name: 'Claude Sonnet 4.5',
			maxInputTokens: 120_000,
			maxOutputTokens: 8_000,
		} as never;
		const messages = [] as never;
		const options = {} as never;
		const progress = {} as never;
		const token = {} as never;

		await provider.provideLanguageModelChatResponse(model, 'sk-ant-nika', messages, options, progress, token);

		expect(delegate.provideLanguageModelChatResponse).toHaveBeenCalledTimes(1);
		const [entry] = delegate.provideLanguageModelChatResponse.mock.calls[0];
		expect(entry.id).toBe('claude-sonnet-4-5');
		expect(entry.configuration).toEqual({ apiKey: 'sk-ant-nika' });
		expect(entry.name).toBe('Claude Sonnet 4.5');
	});

	it('delegates token counting the same way', async () => {
		const { provider, delegate } = createProvider();
		const model = { id: `${NIKA_ANTHROPIC_MODEL_PREFIX}claude-opus-4` } as never;
		const count = await provider.provideTokenCount(model, 'sk-ant-nika', 'hello', {} as never);

		expect(count).toBe(7);
		const [entry] = delegate.provideTokenCount.mock.calls[0];
		expect(entry.id).toBe('claude-opus-4');
		expect(entry.configuration).toEqual({ apiKey: 'sk-ant-nika' });
	});

	it('creates the upstream delegate with undefined known models', () => {
		const { createInstance } = createProvider();
		expect(createInstance).toHaveBeenCalledTimes(1);
		expect(createInstance.mock.calls[0][1]).toBeUndefined();
	});
});

describe('resolveAnthropicModelCapabilities', () => {
	it('assigns vision and thinking by family, with no effort control', () => {
		for (const id of ['claude-sonnet-4-5', 'claude-opus-4', 'claude-haiku-4-5']) {
			const caps = resolveAnthropicModelCapabilities(id, LIMITS);
			expect(caps.vision).toBe(true);
			expect(caps.thinking).toBe(true);
			expect(caps.supportsReasoningEffort).toBeUndefined();
			expect(caps.toolCalling).toBe(true);
			expect(caps.supportedEndpoints).toEqual([ModelSupportedEndpoint.Messages]);
		}
	});

	it('keeps unknown families text-only', () => {
		const caps = resolveAnthropicModelCapabilities('claude-3-7-sonnet-20250219', LIMITS);
		expect(caps.vision).toBe(false);
		expect(caps.thinking).toBe(false);
	});
});

describe('nikaAnthropicModelId', () => {
	it('prefixes a raw catalog id', () => {
		expect(nikaAnthropicModelId('claude-sonnet-4-5')).toBe(`${NIKA_ANTHROPIC_MODEL_PREFIX}claude-sonnet-4-5`);
	});
});
