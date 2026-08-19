/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKKnownModels, BYOKModelCapabilities, resolveModelInfo, resolveModelTokenLimits } from '../common/byokProvider';
import { NIKA_LLAMACPP_MODEL_PREFIX, NIKA_PROVIDER_NAME } from './nikaModels';
import { OpenAIEndpoint } from '../node/openAIEndpoint';

/**
 * How long a fetched llama.cpp model list stays usable before it is refetched.
 * Loading a new GGUF on the server is rare, so a short TTL keeps the picker
 * fresh without hammering a local server on every chat start.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * Fallback context window for llama.cpp server models. The server's
 * `/v1/models` endpoint reports each model's context as
 * `meta["llama.context_length"]` (the GGUF-declared length, e.g. `262144`
 * for a 262k model), which is preferred when present. When it is missing
 * (e.g. a model listed but not currently loaded) this 32K default —
 * llama.cpp's own default — is used.
 */
export const LLAMACPP_DEFAULT_CONTEXT_WINDOW = 32768;
export const LLAMACPP_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * A single llama.cpp server model as exposed through the Nika provider. The
 * workbench-facing id is `llamacpp/<server id>`; the raw id is what goes on
 * the wire.
 */
export interface NikaLlamaCppCatalogModel {
	/** Raw model id as reported by `/v1/models`, e.g. `qwen2.5vl-7b`. */
	readonly id: string;
	readonly name: string;
	/** Resolved BYOK capabilities (limits, tooling, vision). */
	readonly capabilities: BYOKModelCapabilities;
	/** Full context window (input + output) in tokens. */
	readonly contextWindow: number;
}

/**
 * Fetches and caches the model list of a llama.cpp server (OpenAI-compatible
 * `GET <base>/v1/models`) for the Nika provider group. Auth is optional:
 * when an API key is supplied it is sent as `Authorization: Bearer <key>`,
 * otherwise requests go out unauthenticated (the default for a local server).
 */
export class NikaLlamaCppProvider extends Disposable {
	private _catalogCache: { readonly key: string; readonly fetchedAt: number; readonly models: ReadonlyMap<string, NikaLlamaCppCatalogModel> } | undefined;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	/**
	 * The model list keyed by raw server id. Cached for {@link CATALOG_TTL_MS}
	 * per base URL; a changed base URL (or an expired cache) triggers a
	 * refetch.
	 */
	async getCatalog(baseUrl: string, apiKey?: string): Promise<ReadonlyMap<string, NikaLlamaCppCatalogModel>> {
		const cache = this._catalogCache;
		if (cache && cache.key === baseUrl && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) {
			return cache.models;
		}
		const models = await this._fetchCatalog(baseUrl, apiKey);
		this._catalogCache = { key: baseUrl, fetchedAt: Date.now(), models };
		return models;
	}

	/**
	 * Catalog entries as a `BYOKKnownModels` map keyed by raw server id, for
	 * use with `byokKnownModelToAPIInfo`-style conversion.
	 */
	async getKnownModels(baseUrl: string, apiKey?: string): Promise<BYOKKnownModels> {
		const catalog = await this.getCatalog(baseUrl, apiKey);
		return Object.fromEntries([...catalog].map(([id, model]) => [id, model.capabilities]));
	}

	/**
	 * Build a chat-completions request endpoint for a raw server model id.
	 * Capabilities resolve from the cached catalog when available so the wire
	 * model matches the picker entry exactly. An empty API key means the
	 * request goes out without an `Authorization` header.
	 */
	createEndpoint(modelId: string, baseUrl: string, apiKey?: string): OpenAIEndpoint {
		const capabilities = this._catalogCache?.models.get(modelId)?.capabilities;
		const modelInfo = resolveModelInfo(modelId, NIKA_PROVIDER_NAME, undefined, capabilities);
		return this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey ?? '', `${baseUrl}/v1/chat/completions`);
	}

	/** Drop the cached model list (e.g. after the server or base URL changed). */
	invalidateCache(): void {
		this._catalogCache = undefined;
	}

	private async _fetchCatalog(baseUrl: string, apiKey?: string): Promise<ReadonlyMap<string, NikaLlamaCppCatalogModel>> {
		const response = await this._fetcherService.fetch(`${baseUrl}/v1/models`, {
			method: 'GET',
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			callSite: 'nika-llamacpp-models',
		});
		if (!response.ok) {
			throw new Error(vscode.l10n.t('The llama.cpp server returned HTTP {0}.', response.status));
		}
		const body = await response.json() as { data?: unknown[] };
		const models = new Map<string, NikaLlamaCppCatalogModel>();
		for (const entry of body.data ?? []) {
			if (!entry || typeof entry !== 'object' || !('id' in entry)) {
				continue;
			}
			const id = String(entry.id);
			if (!id) {
				continue;
			}
			// llama.cpp reports the per-model context as `meta["llama.context_length"]`
			// (a string, from the GGUF metadata — e.g. `262144` for a 262k model).
			// Some forks expose `meta.n_ctx` instead. Both are the model's own
			// context, not the training window; unloaded entries have no `meta`,
			// so fall back to the default.
			const meta = (entry as { meta?: Record<string, unknown> }).meta;
			const rawContext = meta
				? meta['llama.context_length'] ?? meta['context_length'] ?? meta.n_ctx
				: undefined;
			const parsedContext = typeof rawContext === 'number' ? rawContext : typeof rawContext === 'string' ? Number(rawContext) : undefined;
			const contextWindow = (parsedContext && parsedContext > 0) ? parsedContext : LLAMACPP_DEFAULT_CONTEXT_WINDOW;
			const limits = resolveModelTokenLimits({
				contextWindow,
				maxInputTokens: contextWindow,
				maxOutputTokens: LLAMACPP_DEFAULT_MAX_OUTPUT_TOKENS,
			});
			const capabilities: BYOKModelCapabilities = {
				name: id,
				contextWindow: limits.contextWindow,
				maxInputTokens: limits.maxInputTokens,
				maxOutputTokens: limits.maxOutputTokens,
				toolCalling: true,
				// The server decides whether a loaded model accepts images; a
				// text-only model rejects image parts with a clear error. Keep
				// vision advertised so multimodal GGUFs work natively.
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

/** The workbench-facing id of a raw llama.cpp server model id under the Nika group. */
export function nikaLlamaCppModelId(rawId: string): string {
	return `${NIKA_LLAMACPP_MODEL_PREFIX}${rawId}`;
}
