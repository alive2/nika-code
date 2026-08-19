/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKModelCapabilities, resolveModelTokenLimits } from '../common/byokProvider';
import { NIKA_GEMINI_MODEL_IDS, NIKA_GEMINI_MODEL_PREFIX } from './nikaModels';

/** The Google Generative Language (Gemini API) host. */
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * How long a fetched Gemini model list stays usable before it is refetched.
 * The Google catalog changes rarely; a 10-minute TTL keeps the picker fresh
 * without hammering the API on every chat start.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/** Fallback limits for catalog entries that omit the token ceilings. */
const FALLBACK_INPUT_TOKENS = 128_000;
const FALLBACK_OUTPUT_TOKENS = 8_192;

/**
 * A single Gemini API model as exposed through the Nika provider. The
 * workbench-facing id is `gemini/<model id>` (e.g. `gemini/gemini-2.5-pro`);
 * the raw id (without the `models/` prefix from the API) is what the native
 * Gemini delegate sends on the wire.
 */
export interface NikaGeminiCatalogModel {
	/** Raw model id as reported by the models.list API, e.g. `gemini-2.5-pro`. */
	readonly id: string;
	readonly name: string;
	/** Resolved BYOK capabilities (limits, tooling, vision). */
	readonly capabilities: BYOKModelCapabilities;
	/** Full context window (input + output) in tokens. */
	readonly contextWindow: number;
}

/**
 * Fetches and caches the model list of the Google Gemini API
 * (`GET /v1beta/models`) for the Nika provider group. The curated native
 * lineup (`NIKA_GEMINI_MODEL_IDS`) is excluded: those ids are contributed as
 * bare native entries and must not be duplicated as `gemini/…` catalog rows.
 * Auth uses the `x-goog-api-key` header (the same convention as the Nika
 * Settings connection test).
 */
export class NikaGeminiProvider extends Disposable {
	private _catalogCache: { readonly key: string; readonly fetchedAt: number; readonly models: ReadonlyMap<string, NikaGeminiCatalogModel> } | undefined;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
	) {
		super();
	}

	/**
	 * The model list keyed by raw model id. Cached for {@link CATALOG_TTL_MS}
	 * per API key; a changed key (or an expired cache) triggers a refetch.
	 */
	async getCatalog(apiKey: string): Promise<ReadonlyMap<string, NikaGeminiCatalogModel>> {
		const cache = this._catalogCache;
		if (cache && cache.key === apiKey && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) {
			return cache.models;
		}
		const models = await this._fetchCatalog(apiKey);
		this._catalogCache = { key: apiKey, fetchedAt: Date.now(), models };
		return models;
	}

	/** Drop the cached model list (e.g. after the API key changed). */
	invalidateCache(): void {
		this._catalogCache = undefined;
	}

	private async _fetchCatalog(apiKey: string): Promise<ReadonlyMap<string, NikaGeminiCatalogModel>> {
		const nativeIds = new Set<string>(NIKA_GEMINI_MODEL_IDS);
		const models = new Map<string, NikaGeminiCatalogModel>();
		// The models.list endpoint pages at up to 100 entries per page; walk
		// the pages so the full catalog (including preview and Gemma models)
		// is available. Guard the loop so a misbehaving token can't spin.
		let pageToken: string | undefined;
		for (let page = 0; page < 10; page++) {
			const url = new URL(`${GEMINI_BASE_URL}/v1beta/models`);
			url.searchParams.set('pageSize', '100');
			if (pageToken) {
				url.searchParams.set('pageToken', pageToken);
			}
			const response = await this._fetcherService.fetch(url.toString(), {
				method: 'GET',
				headers: { 'x-goog-api-key': apiKey },
				callSite: 'nika-gemini-models',
			});
			if (!response.ok) {
				throw new Error(vscode.l10n.t('The Gemini API returned HTTP {0}.', response.status));
			}
			const body = await response.json() as { models?: unknown[]; nextPageToken?: string };
			for (const entry of body.models ?? []) {
				if (!entry || typeof entry !== 'object') {
					continue;
				}
				const raw = entry as { name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; outputTokenLimit?: unknown; supportedGenerationMethods?: unknown };
				// The API reports names as `models/<model id>`.
				const name = String(raw.name ?? '').replace(/^models\//, '');
				if (!name) {
					continue;
				}
				// Only models that can actually generate content. Embedding and
				// other non-chat models are filtered out.
				if (!Array.isArray(raw.supportedGenerationMethods) || !raw.supportedGenerationMethods.includes('generateContent')) {
					continue;
				}
				// The curated native lineup is contributed as bare native
				// entries; skip it here so the catalog never duplicates it.
				if (nativeIds.has(name)) {
					continue;
				}
				const inputLimit = typeof raw.inputTokenLimit === 'number' && raw.inputTokenLimit > 0 ? raw.inputTokenLimit : FALLBACK_INPUT_TOKENS;
				const outputLimit = typeof raw.outputTokenLimit === 'number' && raw.outputTokenLimit > 0 ? raw.outputTokenLimit : FALLBACK_OUTPUT_TOKENS;
				const limits = resolveModelTokenLimits({
					contextWindow: inputLimit + outputLimit,
					maxInputTokens: inputLimit,
					maxOutputTokens: outputLimit,
				});
				const capabilities: BYOKModelCapabilities = {
					name,
					contextWindow: limits.contextWindow,
					maxInputTokens: limits.maxInputTokens,
					maxOutputTokens: limits.maxOutputTokens,
					toolCalling: true,
					// The Gemini API accepts image and document parts natively
					// for the 2.x generation; a text-only model rejects them
					// with a clear error.
					vision: true,
					thinking: true,
					// Gemini 2.x models expose the reasoning-effort control;
					// older models reject the field, so leave it unset for
					// anything that is not a 2.x id.
					supportsReasoningEffort: name.includes('2.') ? ['none', 'low', 'high'] : undefined,
				};
				models.set(name, {
					id: name,
					name: String(raw.displayName ?? name),
					capabilities,
					contextWindow: limits.contextWindow,
				});
			}
			pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
			if (!pageToken) {
				break;
			}
		}
		return models;
	}
}

/** The workbench-facing id of a raw Gemini model id under the Nika group. */
export function nikaGeminiModelId(rawId: string): string {
	return `${NIKA_GEMINI_MODEL_PREFIX}${rawId}`;
}
