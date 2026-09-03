/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKModelCapabilities, BYOKKnownModels, resolveModelInfo, resolveModelTokenLimits } from '../common/byokProvider';
import { NIKA_PROVIDER_NAME, NIKA_ZAI_MODEL_PREFIX } from './nikaModels';
import { formatOpenRouterPriceLabel, NIKA_ZAI_PRICES, OpenRouterModelPricing } from './nikaPricing';
import { ZaiEndpoint } from '../node/zaiEndpoint';

/**
 * The Z.ai (Zhipu GLM) international platform host. API keys are created at
 * platform.z.ai and billed usage-based; the `/api/paas/v4` path is the
 * OpenAI-compatible surface (chat completions, model list). The China-side
 * Zhipu host (`open.bigmodel.cn`) shares the API shape but is out of scope
 * for this provider group.
 */
export const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

/**
 * How long a fetched Z.ai model list stays usable before it is refetched. The
 * GLM lineup changes regularly (new releases land on the platform often), so
 * a short TTL keeps the picker fresh without hammering the API on every chat
 * start.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * Fallback context window for Z.ai catalog models. The platform publishes per-
 * model windows that vary by generation (128K for the GLM-4.5 family up to 1M
 * for GLM-5.2/5.3); when the `/models` entry is unknown to the enrichment
 * table, this 128K default keeps the picker honest without overstating limits.
 */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Fallback output-token reservation for Z.ai catalog models, mirroring the
 * Cursor catalog. Real per-model output ceilings are far higher (GLM-5.1+
 * allow ~128K output), but reserving them all would shrink the prompt budget
 * below what a typical session needs.
 */
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

/**
 * A single Z.ai API model as exposed through the Nika provider. The
 * workbench-facing id is `zai/<raw id>`; the raw id is what goes on the wire.
 */
export interface NikaZaiCatalogModel {
	/** Raw model id as served by `/models`, e.g. `glm-4.7`. */
	readonly id: string;
	readonly name: string;
	/** Resolved BYOK capabilities (limits, tooling, vision, pricing). */
	readonly capabilities: BYOKModelCapabilities;
	/** Static price snapshot for the model; undefined when unpriced. */
	readonly pricing?: OpenRouterModelPricing;
	/** Full context window (input + output) in tokens. */
	readonly contextWindow: number;
}

/**
 * Enrichment table for known Z.ai catalog ids: the GLM generations whose
 * context windows and modality are published (platform.z.ai model cards, the
 * LiteLLM Z.ai provider catalog). The live `/models` response is always the
 * source of truth for *which* models exist; this table only sharpens the
 * capabilities shown in the picker. Context windows are full input + output
 * windows as published by the platform.
 */
const NIKA_ZAI_KNOWN_MODELS: Readonly<Record<string, { readonly contextWindow?: number; readonly vision?: boolean }>> = {
	// GLM-5.3 / GLM-5.2: 1M context, native multimodal (5.3-Flash).
	'glm-5.3': { contextWindow: 1_000_000 },
	'glm-5.3-flash': { contextWindow: 1_000_000, vision: true },
	'glm-5.2': { contextWindow: 1_000_000 },
	// GLM-5.1 / GLM-5 / GLM-5-Turbo / GLM-5-Code: 200K context.
	'glm-5.1': { contextWindow: 200_000 },
	'glm-5': { contextWindow: 200_000 },
	'glm-5-turbo': { contextWindow: 200_000 },
	'glm-5-code': { contextWindow: 200_000 },
	// GLM-4.7: 200K context, native image input.
	'glm-4.7': { contextWindow: 200_000, vision: true },
	'glm-4.7-flash': { contextWindow: 200_000, vision: true },
	// GLM-4.6: 200K context.
	'glm-4.6': { contextWindow: 200_000 },
	// GLM-4.5 family: 128K context.
	'glm-4.5': { contextWindow: 128_000 },
	'glm-4.5-x': { contextWindow: 128_000 },
	'glm-4.5-air': { contextWindow: 128_000 },
	'glm-4.5-airx': { contextWindow: 128_000 },
	'glm-4.5-flash': { contextWindow: 128_000 },
	// GLM-4.7-FlashX: the paid fast tier of the GLM-4.7 line, 200K context
	// and native image input like the other GLM-4.7 members.
	'glm-4.7-flashx': { contextWindow: 200_000, vision: true },
	// GLM-4.5V / GLM-4.6V: vision line, 128K context.
	'glm-4.5v': { contextWindow: 128_000, vision: true },
	'glm-4.6v': { contextWindow: 128_000, vision: true },
	'glm-4.6v-flash': { contextWindow: 128_000, vision: true },
	'glm-4.6v-flashx': { contextWindow: 128_000, vision: true },
	'glm-4v-flash': { contextWindow: 128_000, vision: true },
	'glm-4.1v-thinking-flash': { contextWindow: 128_000, vision: true },
	'glm-4.1v-thinking-flashx': { contextWindow: 128_000, vision: true },
	// GLM-4-32B-0414: legacy 128K generation still served for chat.
	'glm-4-32B-0414-128K': { contextWindow: 128_000 },
};

/**
 * True for raw ids of the Z.ai vision line. The table covers the known
 * releases; the id shape (`glm-4.5v`, `glm-5v-…`) is a reliable signal for
 * future members of the vision family.
 */
function isZaiVisionModel(id: string): boolean {
	return NIKA_ZAI_KNOWN_MODELS[id]?.vision === true || /^glm[-_]?(4\.?[0-9.]*v|5v)/i.test(id);
}

/**
 * Raw ids whose thinking cannot be turned off. The platform documents forced
 * thinking for the GLM-5.3 pair (see docs.z.ai > Thinking Mode); for those,
 * offering a `none` level would lie about what the API accepts.
 */
const ZAI_FORCED_THINKING: ReadonlySet<string> = new Set(['glm-5.3', 'glm-5.3-flash']);

/**
 * Chat model ids that api.z.ai serves but omits from `GET /models` (the
 * catalog endpoint only advertises a subset of the platform lineup).
 * Verified live on 2026-09-03 with an API key: the free pair return HTTP 200
 * chat completions, GLM-4.6V-Flash answers HTTP 429 "overloaded" (free tier,
 * model exists), and the paid entries answer HTTP 429 "insufficient balance"
 * (model exists — the API returns "Unknown Model" HTTP 400 for ids it does
 * not serve). Pricing follows the platform pricing page
 * (https://docs.z.ai/guides/overview/pricing.md). The live `/models`
 * response stays the primary source of truth; this supplement keeps the
 * picker from hiding callable models. Drop an id here if Z.ai stops serving
 * it (requests then fail with a clear model-not-found error and the entry
 * can be removed).
 */
const ZAI_CATALOG_SUPPLEMENT: readonly string[] = [
	// Free tier.
	'glm-4.5-flash',
	'glm-4.7-flash',
	'glm-4.6v-flash',
	// Paid tier (listed on the platform pricing page, absent from /models).
	'glm-4.5v',
	'glm-4.6v',
	'glm-4.6v-flashx',
	'glm-4.7-flashx',
	'glm-5-code',
	'glm-4-32B-0414-128K',
];

/**
 * Resolve the thinking controls a raw Z.ai id accepts. GLM models reason by
 * default and expose a binary `thinking: { type: 'enabled' | 'disabled' }`
 * switch; there is no OpenAI-style `reasoning_effort` magnitude (the API
 * ignores it), so the picker offers exactly two levels: `none` (thinking
 * off) and `high` (thinking on — the platform default). Forced-thinking ids
 * only offer `high`.
 */
function zaiThinkingCapabilities(id: string): Pick<BYOKModelCapabilities, 'thinking' | 'supportsReasoningEffort' | 'defaultReasoningEffort' | 'reasoningEffortFormat'> {
	const forced = ZAI_FORCED_THINKING.has(id);
	return {
		thinking: true,
		supportsReasoningEffort: forced ? ['high'] : ['none', 'high'],
		defaultReasoningEffort: 'high',
		reasoningEffortFormat: 'chat-completions',
	};
}

/**
 * Map static Z.ai pricing onto `BYOKModelCapabilities.pricing` for the model
 * picker / management surfaces, mirroring the OpenRouter catalog conversion.
 * Numeric fields are USD per 1M tokens; the label carries currency clarity.
 */
function zaiPricingToCapabilities(pricing: OpenRouterModelPricing): NonNullable<BYOKModelCapabilities['pricing']> {
	return {
		label: formatOpenRouterPriceLabel(pricing),
		inputCost: pricing.promptPerMTok,
		outputCost: pricing.completionPerMTok,
		cacheCost: pricing.cacheReadPerMTok,
	};
}

/**
 * Fetches and caches the model list of the Z.ai platform (OpenAI-compatible
 * `GET <base>/models`) for the Nika provider group. Requests are authenticated
 * with the platform API key (`Authorization: Bearer <key>`).
 */
export class NikaZaiProvider extends Disposable {
	private _catalogCache: { readonly key: string; readonly fetchedAt: number; readonly models: ReadonlyMap<string, NikaZaiCatalogModel> } | undefined;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	/**
	 * The model list keyed by raw model id. Cached for {@link CATALOG_TTL_MS}
	 * per API key; a changed key (or an expired cache) triggers a refetch.
	 */
	async getCatalog(apiKey: string): Promise<ReadonlyMap<string, NikaZaiCatalogModel>> {
		const cache = this._catalogCache;
		if (cache && cache.key === apiKey && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) {
			return cache.models;
		}
		const models = await this._fetchCatalog(apiKey);
		this._catalogCache = { key: apiKey, fetchedAt: Date.now(), models };
		return models;
	}

	/**
	 * Catalog entries as a `BYOKKnownModels` map keyed by raw id, for use with
	 * `byokKnownModelToAPIInfo`-style conversion.
	 */
	async getKnownModels(apiKey: string): Promise<BYOKKnownModels> {
		const catalog = await this.getCatalog(apiKey);
		return Object.fromEntries([...catalog].map(([id, model]) => [id, model.capabilities]));
	}

	/**
	 * Build a chat-completions request endpoint for a raw Z.ai model id.
	 * Capabilities resolve from the cached catalog when available so the wire
	 * model matches the picker entry exactly. Requests go through
	 * {@link ZaiEndpoint}, which translates the picker's thinking selection
	 * into the platform's binary `thinking` parameter.
	 */
	createEndpoint(modelId: string, apiKey: string): ZaiEndpoint {
		const capabilities = this._catalogCache?.models.get(modelId)?.capabilities;
		const modelInfo = resolveModelInfo(modelId, NIKA_PROVIDER_NAME, undefined, capabilities);
		return this._instantiationService.createInstance(ZaiEndpoint, modelInfo, apiKey, `${ZAI_BASE_URL}/chat/completions`);
	}

	/** Drop the cached model list (e.g. after the API key changed). */
	invalidateCache(): void {
		this._catalogCache = undefined;
	}

	private async _fetchCatalog(apiKey: string): Promise<ReadonlyMap<string, NikaZaiCatalogModel>> {
		const response = await this._fetcherService.fetch(`${ZAI_BASE_URL}/models`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
			callSite: 'nika-zai-models',
		});
		if (!response.ok) {
			throw new Error(vscode.l10n.t('The Z.ai API returned HTTP {0}.', response.status));
		}
		const body = await response.json() as { data?: unknown[] };
		const models = new Map<string, NikaZaiCatalogModel>();

		const buildEntry = (id: string): NikaZaiCatalogModel => {
			const known = NIKA_ZAI_KNOWN_MODELS[id] ?? {};
			// The platform publishes per-generation context windows; unknown
			// ids (new releases the enrichment table has not seen yet) fall
			// back to the default. Never let the output reservation eat the
			// window: cap it at half, mirroring the OpenRouter catalog.
			const contextWindow = known.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
			const maxOutputTokens = Math.min(FALLBACK_MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(contextWindow / 2)));
			const limits = resolveModelTokenLimits({
				contextWindow,
				maxInputTokens: contextWindow,
				maxOutputTokens,
			});
			const pricing = NIKA_ZAI_PRICES[id];
			const capabilities: BYOKModelCapabilities = {
				name: id,
				contextWindow: limits.contextWindow,
				maxInputTokens: limits.maxInputTokens,
				maxOutputTokens: limits.maxOutputTokens,
				toolCalling: true,
				// Z.ai serves GLM models with full tool calling; the vision
				// line accepts image parts natively while text-only models
				// reject them with a clear error.
				vision: isZaiVisionModel(id),
				// GLM models reason by default server-side; the binary thinking
				// switch is mapped per request by {@link ZaiEndpoint}. Forced-
				// thinking ids (GLM-5.3 pair) drop the `none` level.
				...zaiThinkingCapabilities(id),
				...(pricing ? { pricing: zaiPricingToCapabilities(pricing) } : {}),
			};
			return {
				id,
				name: capabilities.name,
				capabilities,
				pricing,
				contextWindow: limits.contextWindow,
			};
		};

		for (const entry of body.data ?? []) {
			if (!entry || typeof entry !== 'object' || !('id' in entry)) {
				continue;
			}
			const id = String(entry.id);
			if (!id) {
				continue;
			}
			models.set(id, buildEntry(id));
		}
		// Free-tier models the platform serves but leaves out of `/models`.
		for (const id of ZAI_CATALOG_SUPPLEMENT) {
			if (!models.has(id)) {
				models.set(id, buildEntry(id));
			}
		}
		return models;
	}
}

/** The workbench-facing id of a raw Z.ai model id under the Nika group. */
export function nikaZaiModelId(rawId: string): string {
	return `${NIKA_ZAI_MODEL_PREFIX}${rawId}`;
}
