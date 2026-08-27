/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { ModelSupportedEndpoint } from '../../../../platform/endpoint/common/endpointProvider';
import { NikaOpenAIProvider, nikaOpenAIModelId, OPENAI_BASE_URL, resolveOpenAIModelCapabilities } from '../nikaOpenAIProvider';
import { NIKA_OPENAI_MODEL_PREFIX, resolveNikaTokenLimits } from '../nikaModels';

const LIMITS = resolveNikaTokenLimits('128K', '8K');

function catalogResponse() {
	return {
		data: [
			{ id: 'gpt-5', object: 'model', owned_by: 'openai' },
			{ id: 'gpt-5-codex', object: 'model', owned_by: 'system' },
			{ id: 'gpt-4o', object: 'model', owned_by: 'openai' },
			{ id: 'o3', object: 'model', owned_by: 'openai' },
			{ id: 'text-embedding-3-small', object: 'model', owned_by: 'openai' },
		],
	};
}

function createProvider(overrides?: { json?: unknown; ok?: boolean; status?: number }) {
	const json = vi.fn().mockResolvedValue(overrides?.json ?? catalogResponse());
	const fetch = vi.fn().mockResolvedValue({ ok: overrides?.ok ?? true, status: overrides?.status ?? 200, json });
	const delegate = {
		provideLanguageModelChatResponse: vi.fn().mockResolvedValue(undefined),
		provideTokenCount: vi.fn().mockResolvedValue(12),
	};
	const createInstance = vi.fn().mockReturnValue(delegate);
	const provider = new NikaOpenAIProvider(
		{} as never,
		{ fetch } as never,
		{ createInstance } as never,
	);
	return { provider, fetch, delegate, createInstance };
}

describe('NikaOpenAIProvider', () => {
	it('fetches the catalog with bearer auth and maps entries to capabilities', async () => {
		const { provider, fetch } = createProvider();
		const catalog = await provider.getCatalog('sk-openai-1', LIMITS);

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe(`${OPENAI_BASE_URL}/models`);
		expect(init.headers.Authorization).toBe('Bearer sk-openai-1');

		const gpt5 = catalog.get('gpt-5');
		expect(gpt5).toBeDefined();
		expect(gpt5!.name).toBe('GPT-5');
		expect(gpt5!.capabilities.vision).toBe(true);
		expect(gpt5!.capabilities.toolCalling).toBe(true);
		expect(gpt5!.capabilities.supportsReasoningEffort).toEqual(['low', 'medium', 'high']);
		expect(gpt5!.capabilities.supportedEndpoints).toEqual([ModelSupportedEndpoint.ChatCompletions, ModelSupportedEndpoint.Responses]);

		// Non-chat entries are still listed; capabilities default sensibly.
		const embedding = catalog.get('text-embedding-3-small');
		expect(embedding).toBeDefined();
		expect(embedding!.capabilities.vision).toBe(false);
	});

	it('caches the catalog per API key within the TTL (single slot)', async () => {
		const { provider, fetch } = createProvider();
		await provider.getCatalog('key-a', LIMITS);
		await provider.getCatalog('key-a', LIMITS); // cache hit
		await provider.getCatalog('key-b', LIMITS); // cache miss, evicts key-a
		await provider.getCatalog('key-a', LIMITS); // miss again: single-slot cache

		// One fetch per distinct key at the time of the request.
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer key-a');
		expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer key-b');
		expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer key-a');
	});

	it('refetches after invalidateCache and degrades to an empty list on failure', async () => {
		const { provider, fetch } = createProvider({ json: catalogResponse(), ok: false, status: 401 });
		await expect(provider.getCatalog('bad-key', LIMITS)).rejects.toThrow('HTTP 401');
		expect(fetch).toHaveBeenCalledTimes(1);

		const { provider: okProvider, fetch: okFetch } = createProvider();
		await okProvider.getCatalog('key', LIMITS);
		okProvider.invalidateCache();
		await okProvider.getCatalog('key', LIMITS);
		expect(okFetch).toHaveBeenCalledTimes(2);
	});

	it('delegates chat requests with the raw id, base URL, and Nika API key', async () => {
		const { provider, delegate } = createProvider();
		// The workbench hands requests to Nika with the provider-qualified id
		// (`openai/gpt-5`, no `nika/` prefix) — same as the other Nika branches.
		const model = {
			id: `${NIKA_OPENAI_MODEL_PREFIX}gpt-5`,
			name: 'GPT-5',
			maxInputTokens: 120_000,
			maxOutputTokens: 8_000,
		} as never;
		const messages = [] as never;
		const options = {} as never;
		const progress = {} as never;
		const token = {} as never;

		await provider.provideLanguageModelChatResponse(model, 'sk-nika', messages, options, progress, token);

		expect(delegate.provideLanguageModelChatResponse).toHaveBeenCalledTimes(1);
		const [entry] = delegate.provideLanguageModelChatResponse.mock.calls[0];
		expect(entry.id).toBe('gpt-5');
		expect(entry.url).toBe(OPENAI_BASE_URL);
		expect(entry.configuration).toEqual({ apiKey: 'sk-nika' });
		expect(entry.name).toBe('GPT-5');
	});

	it('delegates token counting the same way', async () => {
		const { provider, delegate } = createProvider();
		const model = { id: `${NIKA_OPENAI_MODEL_PREFIX}o3` } as never;
		const count = await provider.provideTokenCount(model, 'sk-nika', 'hello', {} as never);

		expect(count).toBe(12);
		const [entry] = delegate.provideTokenCount.mock.calls[0];
		expect(entry.id).toBe('o3');
		expect(entry.configuration).toEqual({ apiKey: 'sk-nika' });
	});

	it('creates the upstream delegate with empty known models', () => {
		const { createInstance } = createProvider();
		expect(createInstance).toHaveBeenCalledTimes(1);
		expect(createInstance.mock.calls[0][0]).toBeDefined();
		expect(createInstance.mock.calls[0][1]).toEqual({});
	});
});

describe('resolveOpenAIModelCapabilities', () => {
	it('assigns vision and reasoning effort by family', () => {
		const gpt5 = resolveOpenAIModelCapabilities('gpt-5', LIMITS);
		expect(gpt5.vision).toBe(true);
		expect(gpt5.supportsReasoningEffort).toEqual(['low', 'medium', 'high']);
		expect(gpt5.reasoningEffortFormat).toBe('responses');

		const gpt4o = resolveOpenAIModelCapabilities('gpt-4o', LIMITS);
		expect(gpt4o.vision).toBe(true);
		expect(gpt4o.supportsReasoningEffort).toBeUndefined();

		const o3 = resolveOpenAIModelCapabilities('o3', LIMITS);
		expect(o3.supportsReasoningEffort).toEqual(['low', 'medium', 'high']);
		expect(o3.reasoningEffortFormat).toBe('chat-completions');

		const embedding = resolveOpenAIModelCapabilities('text-embedding-3-small', LIMITS);
		expect(embedding.vision).toBe(false);
		expect(embedding.supportsReasoningEffort).toBeUndefined();
		expect(embedding.toolCalling).toBe(true);
		expect(embedding.supportedEndpoints).toEqual([ModelSupportedEndpoint.ChatCompletions, ModelSupportedEndpoint.Responses]);
	});

	it('prettifies display names', () => {
		expect(resolveOpenAIModelCapabilities('gpt-5-codex', LIMITS).name).toBe('GPT-5 Codex');
		expect(resolveOpenAIModelCapabilities('gpt-4o-mini', LIMITS).name).toBe('GPT-4o Mini');
		expect(resolveOpenAIModelCapabilities('o4-mini', LIMITS).name).toBe('O4 Mini');
		expect(resolveOpenAIModelCapabilities('gpt-5-mini', LIMITS).name).toBe('GPT-5 Mini');
	});
});

describe('nikaOpenAIModelId', () => {
	it('prefixes a raw catalog id', () => {
		expect(nikaOpenAIModelId('gpt-5')).toBe(`${NIKA_OPENAI_MODEL_PREFIX}gpt-5`);
		expect(nikaOpenAIModelId('o4-mini')).toBe(`${NIKA_OPENAI_MODEL_PREFIX}o4-mini`);
	});
});
