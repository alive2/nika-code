/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKModelCapabilities, resolveModelInfo, resolveModelTokenLimits } from '../common/byokProvider';
import { NIKA_CURSOR_MODEL_PREFIX, NIKA_PROVIDER_NAME } from './nikaModels';
import { OpenAIEndpoint } from '../node/openAIEndpoint';

/**
 * The Cursor API host. API keys are created at cursor.com/settings/api-keys
 * and billed to the user's Cursor account (usage-based).
 */
export const CURSOR_BASE_URL = 'https://api.cursor.com';

/**
 * How long a fetched Cursor model list stays usable before it is refetched.
 * Cursor's catalog changes rarely; a 10-minute TTL keeps the picker fresh
 * without hammering the API on every chat start.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * Fallback context window for Cursor models. Cursor serves frontier models
 * (Claude / GPT / Gemini families) whose real windows vary by model; when the
 * `/v1/models` entry does not publish one, this 128K default keeps the picker
 * honest without overstating a specific model's limits.
 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

/**
 * A single Cursor API model as exposed through the Nika provider. The
 * workbench-facing id is `cursor/<raw id>`; the raw id is what goes on the
 * wire.
 */
export interface NikaCursorCatalogModel {
	/** Raw model id as reported by `/v1/models`, e.g. `cursor-fast`. */
	readonly id: string;
	readonly name: string;
	/** Resolved BYOK capabilities (limits, tooling, vision). */
	readonly capabilities: BYOKModelCapabilities;
	/** Full context window (input + output) in tokens. */
	readonly contextWindow: number;
}

/**
 * Fetches and caches the model list of the Cursor API (OpenAI-compatible
 * `GET /v1/models`) for the Nika provider group. Requests are authenticated
 * with the account API key (`Authorization: Bearer <key>`).
 */
export class NikaCursorProvider extends Disposable {
	private _catalogCache: { readonly key: string; readonly fetchedAt: number; readonly models: ReadonlyMap<string, NikaCursorCatalogModel> } | undefined;

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
	async getCatalog(apiKey: string): Promise<ReadonlyMap<string, NikaCursorCatalogModel>> {
		const cache = this._catalogCache;
		if (cache && cache.key === apiKey && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) {
			return cache.models;
		}
		const models = await this._fetchCatalog(apiKey);
		this._catalogCache = { key: apiKey, fetchedAt: Date.now(), models };
		return models;
	}

	/**
	 * Build a chat-completions request endpoint for a raw Cursor model id.
	 * Capabilities resolve from the cached catalog when available so the wire
	 * model matches the picker entry exactly.
	 */
	createEndpoint(modelId: string, apiKey: string): OpenAIEndpoint {
		const capabilities = this._catalogCache?.models.get(modelId)?.capabilities;
		const modelInfo = resolveModelInfo(modelId, NIKA_PROVIDER_NAME, undefined, capabilities);
		return this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey, `${CURSOR_BASE_URL}/v1/chat/completions`);
	}

	/** Drop the cached model list (e.g. after the API key changed). */
	invalidateCache(): void {
		this._catalogCache = undefined;
	}

	private async _fetchCatalog(apiKey: string): Promise<ReadonlyMap<string, NikaCursorCatalogModel>> {
		const response = await this._fetcherService.fetch(`${CURSOR_BASE_URL}/v1/models`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
			callSite: 'nika-cursor-models',
		});
		if (!response.ok) {
			throw new Error(vscode.l10n.t('The Cursor API returned HTTP {0}.', response.status));
		}
		const body = await response.json() as { data?: unknown[] };
		const models = new Map<string, NikaCursorCatalogModel>();
		for (const entry of body.data ?? []) {
			if (!entry || typeof entry !== 'object' || !('id' in entry)) {
				continue;
			}
			const id = String(entry.id);
			if (!id) {
				continue;
			}
			// Cursor publishes the context window on some entries (as
			// `context_window` or `max_context_window`); fall back to the
			// default when it is missing.
			const raw = entry as { context_window?: unknown; max_context_window?: unknown };
			const windowValue = typeof raw.context_window === 'number' && raw.context_window > 0
				? raw.context_window
				: typeof raw.max_context_window === 'number' && raw.max_context_window > 0
					? raw.max_context_window
					: FALLBACK_CONTEXT_WINDOW;
			const limits = resolveModelTokenLimits({
				contextWindow: windowValue,
				maxInputTokens: windowValue,
				maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
			});
			const capabilities: BYOKModelCapabilities = {
				name: id,
				contextWindow: limits.contextWindow,
				maxInputTokens: limits.maxInputTokens,
				maxOutputTokens: limits.maxOutputTokens,
				toolCalling: true,
				// Cursor serves frontier multimodal models (Claude / GPT /
				// Gemini families); a text-only model rejects image parts
				// with a clear error.
				vision: true,
				thinking: false,
			};
			models.set(id, {
				id,
				name: capabilities.name,
				capabilities,
				contextWindow: limits.contextWindow,
			});
		}
		return models;
	}
}

/** The workbench-facing id of a raw Cursor model id under the Nika group. */
export function nikaCursorModelId(rawId: string): string {
	return `${NIKA_CURSOR_MODEL_PREFIX}${rawId}`;
}
