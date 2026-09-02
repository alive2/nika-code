/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { NikaZaiProvider, nikaZaiModelId, ZAI_BASE_URL } from '../nikaZaiProvider';
import { OpenAIEndpoint } from '../../node/openAIEndpoint';

function catalogResponse() {
	return {
		data: [
			{ id: 'glm-4.7', object: 'model', owned_by: 'zhipu' },
			{ id: 'glm-4.5-flash', object: 'model', owned_by: 'zhipu' },
			// A release the enrichment table has not seen yet: the picker must
			// still list it with sensible fallback capabilities.
			{ id: 'glm-5.9', object: 'model', owned_by: 'zhipu' },
			// A future member of the vision family: the `…v` id shape marks it.
			{ id: 'glm-4.9v', object: 'model', owned_by: 'zhipu' },
			{ id: 'text-embedding-3', object: 'model', owned_by: 'zhipu' },
		],
	};
}

function createProvider(overrides?: { json?: unknown; ok?: boolean; status?: number }) {
	const json = vi.fn().mockResolvedValue(overrides?.json ?? catalogResponse());
	const fetch = vi.fn().mockResolvedValue({ ok: overrides?.ok ?? true, status: overrides?.status ?? 200, json });
	const createInstance = vi.fn();
	const provider = new NikaZaiProvider(
		{ fetch } as never,
		{ createInstance } as never,
	);
	return { provider, fetch, createInstance };
}

describe('NikaZaiProvider', () => {
	it('fetches the model list URL with bearer auth', async () => {
		const { provider, fetch } = createProvider();
		await provider.getCatalog('zai-key-1');

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe(`${ZAI_BASE_URL}/models`);
		expect(init.headers.Authorization).toBe('Bearer zai-key-1');
	});

	it('maps catalog entries to capabilities with enrichment and static pricing', async () => {
		const { provider } = createProvider();
		const catalog = await provider.getCatalog('zai-key-1');

		// Known id: enrichment sharpens the context window; the static price
		// table adds the picker label.
		const glm47 = catalog.get('glm-4.7');
		expect(glm47).toBeDefined();
		expect(glm47!.name).toBe('glm-4.7');
		expect(glm47!.contextWindow).toBe(200_000);
		expect(glm47!.capabilities.toolCalling).toBe(true);
		expect(glm47!.capabilities.vision).toBe(true); // GLM-4.7 is natively multimodal
		expect(glm47!.capabilities.pricing).toEqual({
			label: '$0.6/M in · $2.2/M out · cache $0.06/M',
			inputCost: 0.6,
			outputCost: 2.2,
			cacheCost: 0.06,
		});
		expect(glm47!.pricing).toBeDefined();
		expect(glm47!.pricing!.free).toBe(false);

		// Free model: zero-price table entry renders as Free.
		const free = catalog.get('glm-4.5-flash');
		expect(free).toBeDefined();
		expect(free!.capabilities.pricing!.label).toBe('Free');
	});

	it('degrades unknown ids to fallback limits and flags future vision ids', async () => {
		const { provider } = createProvider();
		const catalog = await provider.getCatalog('zai-key-1');

		const future = catalog.get('glm-5.9');
		expect(future).toBeDefined();
		expect(future!.contextWindow).toBe(128_000);
		expect(future!.capabilities.vision).toBe(false);
		expect(future!.capabilities.pricing).toBeUndefined();
		expect(future!.pricing).toBeUndefined();

		// The `glm-…v` id shape marks vision models even when the table has
		// not seen them yet; non-chat embeddings never claim vision.
		const futureVision = catalog.get('glm-4.9v');
		expect(futureVision!.capabilities.vision).toBe(true);
		const embedding = catalog.get('text-embedding-3');
		expect(embedding!.capabilities.vision).toBe(false);
		expect(embedding!.capabilities.toolCalling).toBe(true);
	});

	it('caches per key with a TTL and refetches after expiry or invalidateCache', async () => {
		const { provider, fetch } = createProvider();
		vi.useFakeTimers();
		try {
			await provider.getCatalog('zai-1');
			await provider.getCatalog('zai-1'); // cache hit within the TTL
			expect(fetch).toHaveBeenCalledTimes(1);

			// A different key evicts the single-slot cache.
			await provider.getCatalog('zai-2');
			expect(fetch).toHaveBeenCalledTimes(2);

			vi.advanceTimersByTime(10 * 60 * 1000 + 1); // TTL (10 min) expires
			await provider.getCatalog('zai-2');
			expect(fetch).toHaveBeenCalledTimes(3);

			provider.invalidateCache();
			await provider.getCatalog('zai-2');
			expect(fetch).toHaveBeenCalledTimes(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rethrows a non-ok catalog response', async () => {
		const { provider } = createProvider({ ok: false, status: 401 });
		await expect(provider.getCatalog('zai-bad')).rejects.toThrow(/HTTP 401/);
	});

	it('creates a chat-completions endpoint with the raw wire id', async () => {
		const { provider, createInstance } = createProvider();
		await provider.getCatalog('zai-key-1');

		provider.createEndpoint('glm-4.7', 'zai-key-1');
		const call = createInstance.mock.calls.at(-1)!;
		expect(call[0]).toBe(OpenAIEndpoint);
		// The wire model id is the raw catalog id (no `zai/` prefix).
		expect((call[1] as { id: string }).id).toBe('glm-4.7');
		expect(call[2]).toBe('zai-key-1');
		expect(call[3]).toBe(`${ZAI_BASE_URL}/chat/completions`);
	});

	it('qualifies raw catalog ids with the zai provider prefix', () => {
		expect(nikaZaiModelId('glm-4.7')).toBe('zai/glm-4.7');
	});
});
