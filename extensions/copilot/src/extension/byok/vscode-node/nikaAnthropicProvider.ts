/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { NIKA_ANTHROPIC_MODEL_PREFIX, NikaTokenLimits } from './nikaModels';
import { AnthropicLMProvider } from './anthropicProvider';
import { IBYOKStorageService } from './byokStorageService';

/**
 * Anthropic base URL used for both the catalog and request endpoints.
 */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

/**
 * API version header required by every Anthropic API request.
 */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * How long a fetched Anthropic catalog stays usable before it is refetched.
 * The catalog changes rarely (new models), so a short TTL keeps the picker
 * fresh without hammering the API on every chat start.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * A single Anthropic catalog entry as exposed through the Nika provider.
 * The workbench-facing id is `anthropic/<raw catalog id>`; the raw id is what
 * goes on the wire.
 */
export interface NikaAnthropicCatalogModel {
	/** Raw Anthropic catalog id, e.g. `claude-sonnet-4`. */
	readonly id: string;
	readonly name: string;
	/** Resolved BYOK capabilities (limits, tooling, vision, thinking). */
	readonly capabilities: BYOKModelCapabilities;
	/** Full context window (input + output) in tokens. */
	readonly contextWindow: number;
}

/** Claude model families that accept images and extended thinking natively. */
const ANTHROPIC_MODAL_FAMILY = /^claude-(sonnet|opus|haiku)/i;

/**
 * A human-friendly display name for a raw Anthropic model id, used only as a
 * fallback — the catalog normally provides `display_name`.
 */
function anthropicModelDisplayName(rawId: string): string {
	return rawId
		.replace(/^claude-/i, 'Claude ')
		.replace(/-sonnet/i, ' Sonnet')
		.replace(/-opus/i, ' Opus')
		.replace(/-haiku/i, ' Haiku')
		.replace(/-4-5/i, ' 4.5')
		.replace(/-4/i, ' 4')
		.replace(/-latest/i, '');
}

/**
 * Resolves the BYOK capabilities Nika exposes an Anthropic catalog model
 * with. Anthropic's catalog does not report limits, so the user-configured
 * Nika token limits apply uniformly; family heuristics decide vision and
 * thinking support. Anthropic models have no reasoning-effort control (their
 * "extended thinking" is a budget, handled by the upstream delegate).
 */
export function resolveAnthropicModelCapabilities(rawId: string, limits: NikaTokenLimits): BYOKModelCapabilities {
	const modal = ANTHROPIC_MODAL_FAMILY.test(rawId);
	return {
		name: anthropicModelDisplayName(rawId),
		contextWindow: limits.contextWindow,
		maxInputTokens: limits.maxInputTokens,
		maxOutputTokens: limits.maxOutputTokens,
		toolCalling: true,
		vision: modal,
		thinking: modal,
		supportedEndpoints: [ModelSupportedEndpoint.Messages],
	};
}

/**
 * Fetches and caches the Anthropic model catalog for the Nika provider group
 * and delegates request handling to the upstream {@link AnthropicLMProvider}
 * — the same provider the upstream BYOK picker ships. The delegate honors
 * `model.configuration.apiKey` (`anthropicProvider.ts`), so the Nika key
 * reaches the wire without touching the global BYOK storage.
 */
export class NikaAnthropicProvider extends Disposable {
	private _catalogCache: { readonly key: string; readonly fetchedAt: number; readonly models: ReadonlyMap<string, NikaAnthropicCatalogModel> } | undefined;
	private readonly _anthropicProvider: AnthropicLMProvider;

	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		// `undefined` known models: upstream itself registers the Anthropic
		// provider with an empty map (`byokContribution.ts`), and the delegate
		// resolves wire behavior from the per-model Nika entry.
		this._anthropicProvider = this._instantiationService.createInstance(AnthropicLMProvider, undefined, byokStorageService);
	}

	/**
	 * The full catalog keyed by raw model id. Cached for
	 * {@link CATALOG_TTL_MS} per API key; a changed key (or an expired cache)
	 * triggers a refetch.
	 */
	async getCatalog(apiKey: string, limits: NikaTokenLimits): Promise<ReadonlyMap<string, NikaAnthropicCatalogModel>> {
		const cache = this._catalogCache;
		if (cache && cache.key === apiKey && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) {
			return cache.models;
		}
		const models = await this._fetchCatalog(apiKey, limits);
		this._catalogCache = { key: apiKey, fetchedAt: Date.now(), models };
		return models;
	}

	/**
	 * Catalog entries as a `BYOKKnownModels` map keyed by raw id, for use with
	 * `byokKnownModelToAPIInfo`-style conversion.
	 */
	async getKnownModels(apiKey: string, limits: NikaTokenLimits): Promise<BYOKKnownModels> {
		const catalog = await this.getCatalog(apiKey, limits);
		return Object.fromEntries([...catalog].map(([id, model]) => [id, model.capabilities]));
	}

	/**
	 * Resolved capabilities for a raw catalog id from the cached catalog, or
	 * `undefined` when the catalog has not been fetched yet. Never triggers a
	 * fetch — hot paths (e.g. request-time warnings) use this to avoid adding
	 * latency; the request branch fetches the catalog anyway.
	 */
	getCachedCapabilities(modelId: string): BYOKModelCapabilities | undefined {
		return this._catalogCache?.models.get(modelId)?.capabilities;
	}

	/**
	 * Delegate a chat request to the upstream Anthropic provider. The Nika
	 * entry (`anthropic/<raw id>`) is rewritten to the raw wire id with the
	 * Nika API key attached, so the upstream Messages-API handling and
	 * tooling apply unchanged.
	 */
	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		apiKey: string,
		messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>,
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const delegate: vscode.LanguageModelChatInformation = {
			...model,
			id: model.id.slice(NIKA_ANTHROPIC_MODEL_PREFIX.length),
			configuration: { apiKey },
		};
		return this._anthropicProvider.provideLanguageModelChatResponse(delegate, messages, options, progress, token);
	}

	/** Delegate token counting to the upstream Anthropic provider. */
	async provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		apiKey: string,
		text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2,
		token: vscode.CancellationToken,
	): Promise<number> {
		const delegate: vscode.LanguageModelChatInformation = {
			...model,
			id: model.id.slice(NIKA_ANTHROPIC_MODEL_PREFIX.length),
			configuration: { apiKey },
		};
		return this._anthropicProvider.provideTokenCount(delegate, text, token);
	}

	/** Drop the cached catalog (e.g. after the API key changed). */
	invalidateCache(): void {
		this._catalogCache = undefined;
	}

	private async _fetchCatalog(apiKey: string, limits: NikaTokenLimits): Promise<ReadonlyMap<string, NikaAnthropicCatalogModel>> {
		const response = await this._fetcherService.fetch(`${ANTHROPIC_BASE_URL}/models`, {
			method: 'GET',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': ANTHROPIC_VERSION,
			},
			callSite: 'nika-anthropic-catalog',
		});
		if (!response.ok) {
			throw new Error(vscode.l10n.t('The Anthropic model catalog returned HTTP {0}.', response.status));
		}
		const body = await response.json() as { data?: Array<{ id?: unknown; display_name?: unknown }> };
		const models = new Map<string, NikaAnthropicCatalogModel>();
		for (const entry of body.data ?? []) {
			if (typeof entry.id !== 'string' || entry.id.length === 0) {
				continue;
			}
			const capabilities = resolveAnthropicModelCapabilities(entry.id, limits);
			models.set(entry.id, {
				id: entry.id,
				name: typeof entry.display_name === 'string' && entry.display_name.length > 0 ? entry.display_name : capabilities.name,
				capabilities,
				contextWindow: (capabilities.maxInputTokens ?? 0) + (capabilities.maxOutputTokens ?? 0),
			});
		}
		return models;
	}
}

/** The workbench-facing id of a raw Anthropic catalog id under the Nika group. */
export function nikaAnthropicModelId(rawId: string): string {
	return `${NIKA_ANTHROPIC_MODEL_PREFIX}${rawId}`;
}
