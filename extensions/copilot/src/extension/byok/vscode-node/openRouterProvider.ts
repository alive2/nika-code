/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';

import { IChatWebSocketManager } from '../../../platform/networking/node/chatWebSocketManager';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKModelCapabilities } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { formatOpenRouterPriceLabel, OpenRouterModelPricing, OpenRouterPricingRaw, parseOpenRouterPricing } from './nikaPricing';
import { AbstractOpenAICompatibleLMProvider, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

export interface OpenRouterModelData {
	id: string;
	name: string;
	/**
	 * The unified parameter capabilities the model accepts, e.g. `tools`,
	 * `reasoning` / `reasoning_effort`, `web_search`, `structured_outputs`,
	 * `response_format`, `prompt_caching`, `vision`.
	 */
	supported_parameters?: Array<'tools' | 'reasoning' | 'reasoning_effort' | 'web_search' | 'structured_outputs' | 'response_format' | 'prompt_caching' | 'vision' | (string & {})>;
	architecture?: {
		input_modalities?: string[];
	};
	/**
	 * The model's actual maximum context window, independent of which provider
	 * OpenRouter ranks highest. Prefer this over `top_provider.context_length`,
	 * which only reflects the primary provider and can be far smaller for
	 * multi-provider models.
	 * @see https://openrouter.ai/docs/guides/overview/models
	 */
	context_length?: number;
	/**
	 * Catalog pricing (USD strings; token prices per 1M tokens, `request` is a
	 * flat per-request fee). Missing for a few legacy entries.
	 */
	pricing?: OpenRouterPricingRaw;
	top_provider: {
		context_length: number;
		/** Maximum tokens the primary provider will produce in a response. */
		max_completion_tokens?: number;
	};
}

/**
 * Fallback output-token budget used only when OpenRouter does not report
 * `top_provider.max_completion_tokens` for a model. The value is heuristic — most
 * tool-capable models do report an explicit budget, in which case this is unused.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Map parsed OpenRouter catalog pricing onto `BYOKModelCapabilities.pricing`
 * for the model picker / management surfaces. Numeric fields are USD per 1M
 * tokens; the label carries the currency clarity.
 */
export function openRouterPricingToCapabilities(pricing: OpenRouterModelPricing | undefined): NonNullable<BYOKModelCapabilities['pricing']> | undefined {
	if (!pricing) {
		return undefined;
	}
	return {
		label: formatOpenRouterPriceLabel(pricing),
		inputCost: pricing.promptPerMTok,
		outputCost: pricing.completionPerMTok,
		cacheCost: pricing.cacheReadPerMTok,
	};
}

/**
 * Resolve BYOK capabilities from an OpenRouter catalog entry. Shared by the
 * standalone OpenRouter provider group and the Nika provider's OpenRouter
 * catalog so both surfaces behave identically.
 */
export function resolveOpenRouterModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
	const openRouterModelData = modelData as OpenRouterModelData;
	if (!openRouterModelData || typeof openRouterModelData.id !== 'string' || !openRouterModelData.top_provider || typeof openRouterModelData.top_provider.context_length !== 'number') {
		return undefined;
	}
	const supportedParameters = openRouterModelData.supported_parameters ?? [];
	// OpenRouter reports reasoning support per model via `supported_parameters`. The unified `reasoning` parameter and
	// the OpenAI-style `reasoning_effort` alias both indicate the model accepts an effort level.
	// See https://openrouter.ai/docs/use-cases/reasoning-tokens
	const supportsReasoningEffort = supportedParameters.includes('reasoning') || supportedParameters.includes('reasoning_effort')
		? ['low', 'medium', 'high']
		: undefined;
	// Prefer the model-level `context_length` (the real capability) over
	// `top_provider.context_length`, which only reflects OpenRouter's
	// highest-ranked provider and can be much smaller for multi-provider models.
	const contextWindow = openRouterModelData.context_length ?? openRouterModelData.top_provider.context_length;
	// Reserve output tokens from the window. Clamp the reserve so a small-context
	// model (or a missing/oversized `max_completion_tokens`) never yields a
	// non-positive prompt budget.
	const requestedMaxOutputTokens = openRouterModelData.top_provider.max_completion_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
	const maxOutputTokens = Math.min(requestedMaxOutputTokens, Math.floor(contextWindow / 2));
	const pricing = openRouterPricingToCapabilities(parseOpenRouterPricing(openRouterModelData.pricing));
	return {
		name: openRouterModelData.name ?? openRouterModelData.id,
		toolCalling: supportedParameters.includes('tools'),
		vision: openRouterModelData.architecture?.input_modalities?.includes('image') ?? false,
		maxInputTokens: contextWindow - maxOutputTokens,
		maxOutputTokens,
		supportsReasoningEffort,
		...(pricing ? { pricing } : {}),
	};
}

export class OpenRouterLMProvider extends AbstractOpenAICompatibleLMProvider {

	public static readonly providerName = 'OpenRouter';
	public static readonly providerId = this.providerName.toLowerCase();

	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService
	) {
		super(
			OpenRouterLMProvider.providerId,
			OpenRouterLMProvider.providerName,
			undefined,
			byokStorageService,
			fetcherService,
			logService,
			instantiationService,
			configurationService,
			expService
		);
	}

	protected override getModelsBaseUrl(): string | undefined {
		return 'https://openrouter.ai/api/v1';
	}

	protected override getModelsDiscoveryUrl(modelsBaseUrl: string): string {
		// Full catalog — no `supported_parameters` filter — so `:free`, `:nitro`,
		// `:extended`, and `:online` variants are all discoverable, matching the
		// Nika provider group's OpenRouter catalog.
		return `${modelsBaseUrl}/models`;
	}

	protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		return resolveOpenRouterModelCapabilities(modelData);
	}

	protected override async createOpenAIEndPoint(model: OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>): Promise<OpenAIEndpoint> {
		const modelInfo = this.getModelInfo(model.id, model.url);
		return createOpenRouterEndpoint(this._instantiationService, modelInfo, model.configuration?.apiKey ?? '', model.id, model.url);
	}
}

/**
 * Build an OpenRouter endpoint for a model id, routing Anthropic models through
 * the native Messages API and everything else through `/chat/completions`.
 * Shared by the standalone OpenRouter provider group and the Nika provider.
 */
export function createOpenRouterEndpoint(
	instantiationService: IInstantiationService,
	modelInfo: IChatModelInformation,
	apiKey: string,
	modelId: string,
	baseUrl: string,
): OpenRouterEndpoint {
	const isAnthropic = isAnthropicModelId(modelId);

	if (isAnthropic) {
		// Anthropic models on OpenRouter use the native Messages API which
		// provides full cache_control, thinking, and tool support identical
		// to the direct Anthropic API.
		modelInfo.supported_endpoints = [ModelSupportedEndpoint.Messages];
	}

	const url = isAnthropic
		? `${baseUrl}/messages`
		: `${baseUrl}/chat/completions`;

	return instantiationService.createInstance(OpenRouterEndpoint, modelInfo, apiKey, url);
}

/**
 * Checks whether an OpenRouter model ID refers to an Anthropic model.
 * OpenRouter model IDs follow the format `provider/model-name`, e.g.
 * `anthropic/claude-sonnet-4` or `anthropic/claude-opus-4`.
 */
export function isAnthropicModelId(modelId: string): boolean {
	return modelId.startsWith('anthropic/');
}

/**
 * OpenRouter-specific endpoint that routes Anthropic models through the native
 * Messages API (`/api/v1/messages`) for full prompt caching, thinking, and tool
 * support identical to the direct Anthropic API.
 *
 * @see https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages
 */
export class OpenRouterEndpoint extends OpenAIEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		apiKey: string,
		modelUrl: string,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@IChatWebSocketManager chatWebSocketService: IChatWebSocketManager,
		@ILogService logService: ILogService,
	) {
		super(modelMetadata, apiKey, modelUrl, domainService, chatMLFetcher, tokenizerProvider, instantiationService, configurationService, expService, chatWebSocketService, logService);
	}

	/**
	 * Enable the Messages API path for Anthropic models. This bypasses the
	 * experiment flag check in the base class because BYOK models are always
	 * user-controlled — the `supported_endpoints` metadata is already set
	 * correctly by {@link OpenRouterLMProvider.createOpenAIEndPoint}.
	 */
	protected override get useMessagesApi(): boolean {
		return !!this.modelMetadata.supported_endpoints?.includes(ModelSupportedEndpoint.Messages);
	}

	public override getExtraHeaders(): Record<string, string> {
		const headers = super.getExtraHeaders();
		if (this.useMessagesApi) {
			Object.assign(headers, this.getAnthropicBetaHeader());
		}
		return headers;
	}
}
