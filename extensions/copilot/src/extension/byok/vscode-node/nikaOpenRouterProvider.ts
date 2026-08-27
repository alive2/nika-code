/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKKnownModels, BYOKModelCapabilities, resolveModelInfo } from '../common/byokProvider';
import { NIKA_OPENROUTER_MODEL_PREFIX, NIKA_PROVIDER_NAME } from './nikaModels';
import { OpenRouterModelPricing, parseOpenRouterPricing } from './nikaPricing';
import { createOpenRouterEndpoint, OpenRouterEndpoint, OpenRouterModelData, resolveOpenRouterModelCapabilities } from './openRouterProvider';

/**
 * OpenRouter base URL used for both the catalog and request endpoints.
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * How long a fetched OpenRouter catalog stays usable before it is refetched.
 * The catalog changes rarely (new models), so a short TTL keeps the picker
 * fresh without hammering the API on every chat start.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * A single OpenRouter catalog entry as exposed through the Nika provider.
 * The workbench-facing id is `openrouter/<raw catalog id>`; the raw id is what
 * goes on the wire.
 */
export interface NikaOpenRouterCatalogModel {
	/** Raw OpenRouter catalog id, e.g. `anthropic/claude-sonnet-4`. */
	readonly id: string;
	readonly name: string;
	/** Resolved BYOK capabilities (limits, tooling, vision, pricing). */
	readonly capabilities: BYOKModelCapabilities;
	/** Parsed catalog pricing; undefined when the entry carries none. */
	readonly pricing?: OpenRouterModelPricing;
	/** Full context window (input + output) in tokens. */
	readonly contextWindow: number;
}

/**
 * Fetches and caches the OpenRouter model catalog for the Nika provider group.
 * The catalog is public but the request is authenticated so it behaves
 * identically to the user's other OpenRouter traffic (and works if OpenRouter
 * ever requires auth for it).
 */
export class NikaOpenRouterProvider extends Disposable {
	private _catalogCache: { readonly key: string; readonly fetchedAt: number; readonly models: ReadonlyMap<string, NikaOpenRouterCatalogModel> } | undefined;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	/**
	 * The full catalog (no `supported_parameters` filter), keyed by raw model
	 * id. Cached for {@link CATALOG_TTL_MS} per API key; a changed key (or an
	 * expired cache) triggers a refetch.
	 */
	async getCatalog(apiKey: string): Promise<ReadonlyMap<string, NikaOpenRouterCatalogModel>> {
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
	 * Parsed pricing for a raw catalog id, or `undefined` when the entry has
	 * no pricing (or the catalog has not been fetched yet).
	 */
	getPricing(modelId: string): OpenRouterModelPricing | undefined {
		return this._catalogCache?.models.get(modelId)?.pricing;
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
	 * Build an OpenRouter request endpoint for a raw catalog id, routing
	 * Anthropic models through the native Messages API. Capabilities resolve
	 * from the cached catalog when available so the wire model matches the
	 * picker entry exactly.
	 */
	createEndpoint(modelId: string, apiKey: string): OpenRouterEndpoint {
		const capabilities = this._catalogCache?.models.get(modelId)?.capabilities;
		const modelInfo = resolveModelInfo(modelId, NIKA_PROVIDER_NAME, undefined, capabilities);
		return createOpenRouterEndpoint(this._instantiationService, modelInfo, apiKey, modelId, OPENROUTER_BASE_URL);
	}

	/** Drop the cached catalog (e.g. after the API key changed). */
	invalidateCache(): void {
		this._catalogCache = undefined;
	}

	private async _fetchCatalog(apiKey: string): Promise<ReadonlyMap<string, NikaOpenRouterCatalogModel>> {
		const response = await this._fetcherService.fetch(`${OPENROUTER_BASE_URL}/models`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
			callSite: 'nika-openrouter-catalog',
		});
		if (!response.ok) {
			throw new Error(vscode.l10n.t('The OpenRouter model catalog returned HTTP {0}.', response.status));
		}
		const body = await response.json() as { data?: unknown[] };
		const models = new Map<string, NikaOpenRouterCatalogModel>();
		for (const entry of body.data ?? []) {
			const capabilities = resolveOpenRouterModelCapabilities(entry);
			if (!capabilities) {
				continue;
			}
			const data = entry as OpenRouterModelData;
			const pricing = parseOpenRouterPricing(data.pricing);
			models.set(data.id, {
				id: data.id,
				name: capabilities.name,
				capabilities,
				pricing,
				contextWindow: (capabilities.maxInputTokens ?? 0) + (capabilities.maxOutputTokens ?? 0),
			});
		}
		return models;
	}
}

/** The workbench-facing id of a raw OpenRouter catalog id under the Nika group. */
export function nikaOpenRouterModelId(rawId: string): string {
	return `${NIKA_OPENROUTER_MODEL_PREFIX}${rawId}`;
}
