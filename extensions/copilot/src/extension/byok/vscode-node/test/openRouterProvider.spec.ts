/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { BYOKModelCapabilities } from '../../common/byokProvider';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../../platform/endpoint/common/endpointProvider';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createOpenRouterEndpoint, isAnthropicModelId, OpenRouterLMProvider } from '../openRouterProvider';

/**
 * Tests for issue #324671:
 * OpenRouter BYOK previously derived the context window from `top_provider.context_length`,
 * which is the window of the highest-ranked provider — NOT the model's real capability
 * (`context_length`). For multi-provider models this could be off by 32×. These tests
 * verify the fix: the model-level `context_length` is preferred, with `top_provider`
 * used only as a fallback.
 */

/** Exposes the protected members for focused testing. */
class TestableOpenRouterLMProvider extends OpenRouterLMProvider {
	public resolveCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		return this.resolveModelCapabilities(modelData);
	}

	public discoveryUrl(baseUrl: string): string {
		return this.getModelsDiscoveryUrl(baseUrl);
	}
}

function createProvider(): TestableOpenRouterLMProvider {
	const logService = {
		trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
		show: vi.fn(), createSubLogger: vi.fn(), withExtraTarget: vi.fn(),
	};
	logService.createSubLogger.mockReturnValue(logService);
	logService.withExtraTarget.mockReturnValue(logService);

	return new TestableOpenRouterLMProvider(
		{ getAPIKey: vi.fn().mockResolvedValue(undefined), storeAPIKey: vi.fn(), deleteAPIKey: vi.fn() } as any,
		{ fetch: vi.fn() } as any,
		logService as any,
		{ createInstance: vi.fn().mockReturnValue({}) } as any,
		{ isConfigured: vi.fn().mockReturnValue(false), getConfig: vi.fn(), setConfig: vi.fn() } as any,
		{} as any,
	);
}

describe('OpenRouterLMProvider context window (issue #324671)', () => {
	it('derives maxInputTokens from the model-level context_length, not top_provider', () => {
		const provider = createProvider();

		// `xiaomi/mimo-v2.5`: the model supports 1M tokens, but the highest-ranked
		// provider only serves 32K. The Xiaomi provider (1M) is not the top provider.
		const caps = provider.resolveCapabilities({
			id: 'xiaomi/mimo-v2.5',
			name: 'MiMo v2.5',
			supported_parameters: ['tools'],
			architecture: { input_modalities: ['text'] },
			context_length: 1048576,            // actual model capability (1M)
			top_provider: { context_length: 32000 }, // highest-ranked provider (32K)
		});

		// Uses the real 1M window minus the default 16K output reserve.
		expect(caps?.maxInputTokens).toBe(1048576 - 16000);
		expect(caps?.maxOutputTokens).toBe(16000);
	});

	it('honors top_provider.max_completion_tokens as the output budget', () => {
		const provider = createProvider();

		const caps = provider.resolveCapabilities({
			id: 'some/reasoning-model',
			name: 'Reasoning Model',
			supported_parameters: ['tools'],
			context_length: 200000,
			top_provider: { context_length: 200000, max_completion_tokens: 64000 },
		});

		expect(caps?.maxOutputTokens).toBe(64000);
		expect(caps?.maxInputTokens).toBe(200000 - 64000);
	});

	it('falls back to top_provider.context_length when the model omits context_length', () => {
		const provider = createProvider();

		const caps = provider.resolveCapabilities({
			id: 'legacy/model',
			name: 'Legacy Model',
			supported_parameters: ['tools'],
			top_provider: { context_length: 128000 },
		});

		expect(caps?.maxInputTokens).toBe(128000 - 16000);
	});

	it('clamps the output reserve so a small-context model keeps a positive prompt budget', () => {
		const provider = createProvider();

		// An 8K model whose provider reports a 16K completion budget larger than the
		// window. Without clamping, maxInputTokens would go negative (8000 - 16000).
		const caps = provider.resolveCapabilities({
			id: 'tiny/model',
			name: 'Tiny Model',
			supported_parameters: ['tools'],
			context_length: 8000,
			top_provider: { context_length: 8000, max_completion_tokens: 16000 },
		});

		// Reserve is capped at half the window, so the prompt budget stays positive.
		expect(caps?.maxOutputTokens).toBe(4000);
		expect(caps?.maxInputTokens).toBe(4000);
	});
});

describe('OpenRouter pricing into capabilities', () => {
	it('maps catalog pricing strings onto the picker pricing fields', () => {
		const provider = createProvider();

		const caps = provider.resolveCapabilities({
			id: 'anthropic/claude-sonnet-4',
			name: 'Claude Sonnet 4',
			supported_parameters: ['tools', 'reasoning', 'vision'],
			architecture: { input_modalities: ['text', 'image'] },
			context_length: 200000,
			top_provider: { context_length: 200000, max_completion_tokens: 64000 },
			pricing: { prompt: '3', completion: '15', request: '0.005', image: '0.0045', web_search: '0.03', cache_read: '0.3', cache_write: '0.3' },
		});

		expect(caps?.pricing).toEqual({
			label: '$3/M in · $15/M out · cache $0.3/M · $0.005/req',
			inputCost: 3,
			outputCost: 15,
			cacheCost: 0.3,
		});
	});

	it('marks zero-priced models as Free', () => {
		const provider = createProvider();

		const caps = provider.resolveCapabilities({
			id: 'meta-llama/llama-3.3-70b-instruct:free',
			name: 'Llama 3.3 70B Instruct (free)',
			supported_parameters: ['tools'],
			context_length: 131072,
			top_provider: { context_length: 131072 },
			pricing: { prompt: '0', completion: '0', request: '0', image: '0', web_search: '0', cache_read: '0', cache_write: '0' },
		});

		expect(caps?.pricing?.label).toBe('Free');
		expect(caps?.pricing?.inputCost).toBe(0);
		expect(caps?.pricing?.outputCost).toBe(0);
	});

	it('omits pricing for catalog entries without a pricing block', () => {
		const provider = createProvider();

		const caps = provider.resolveCapabilities({
			id: 'legacy/model',
			name: 'Legacy Model',
			supported_parameters: ['tools'],
			context_length: 128000,
			top_provider: { context_length: 128000 },
		});

		expect(caps?.pricing).toBeUndefined();
	});

	it('derives vision, tool calling, and reasoning effort flags', () => {
		const provider = createProvider();

		const caps = provider.resolveCapabilities({
			id: 'google/gemini-2.5-flash',
			name: 'Gemini 2.5 Flash',
			supported_parameters: ['tools', 'reasoning_effort'],
			architecture: { input_modalities: ['text', 'image'] },
			context_length: 1048576,
			top_provider: { context_length: 1048576, max_completion_tokens: 65536 },
		});

		expect(caps?.toolCalling).toBe(true);
		expect(caps?.vision).toBe(true);
		expect(caps?.supportsReasoningEffort).toEqual(['low', 'medium', 'high']);
	});
});

describe('OpenRouter discovery and endpoint routing', () => {
	it('uses the full catalog URL without a supported_parameters filter', () => {
		const provider = createProvider();
		expect(provider.discoveryUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/models');
	});

	it('routes Anthropic models through the native Messages API', () => {
		const instantiationService = { createInstance: vi.fn(() => ({})) } as unknown as IInstantiationService;
		const modelInfo = { id: 'openrouter/anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' } as unknown as IChatModelInformation;

		createOpenRouterEndpoint(instantiationService, modelInfo, 'key', 'anthropic/claude-sonnet-4', 'https://openrouter.ai/api/v1');

		expect(instantiationService.createInstance).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ supported_endpoints: [ModelSupportedEndpoint.Messages] }),
			'key',
			'https://openrouter.ai/api/v1/messages',
		);
	});

	it('routes non-Anthropic models through chat/completions', () => {
		const instantiationService = { createInstance: vi.fn(() => ({})) } as unknown as IInstantiationService;
		const modelInfo = { id: 'openrouter/deepseek/deepseek-chat', name: 'DeepSeek Chat' } as unknown as IChatModelInformation;

		createOpenRouterEndpoint(instantiationService, modelInfo, 'key', 'deepseek/deepseek-chat', 'https://openrouter.ai/api/v1');

		expect(instantiationService.createInstance).toHaveBeenCalledWith(
			expect.any(Function),
			expect.not.objectContaining({ supported_endpoints: [ModelSupportedEndpoint.Messages] }),
			'key',
			'https://openrouter.ai/api/v1/chat/completions',
		);
	});

	it('recognizes Anthropic model ids by provider prefix', () => {
		expect(isAnthropicModelId('anthropic/claude-opus-4')).toBe(true);
		expect(isAnthropicModelId('anthropic/claude-sonnet-4')).toBe(true);
		expect(isAnthropicModelId('deepseek/deepseek-chat')).toBe(false);
		expect(isAnthropicModelId('openai/gpt-5')).toBe(false);
	});
});
