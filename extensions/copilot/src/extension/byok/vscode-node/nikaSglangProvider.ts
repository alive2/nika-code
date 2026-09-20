/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKKnownModels, BYOKModelCapabilities, resolveModelInfo, resolveModelTokenLimits } from '../common/byokProvider';
import { NIKA_PROVIDER_NAME, NikaSglangServer } from './nikaModels';
import { OpenAIEndpoint } from '../node/openAIEndpoint';

/**
 * How long a fetched SGLang model list stays usable before it is refetched.
 * SGLang serves whatever was launched on the server, which changes rarely, so
 * a short TTL keeps pickers fresh without hammering the server on every chat
 * start. The cache is kept per server, so one unreachable box never hides the
 * models of the others.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * How long a resolved context window from `/get_server_info` is reused. The
 * launch configuration cannot change without the server process restarting,
 * so a long TTL is fine (and the endpoint is optional anyway).
 */
const SERVER_INFO_TTL_MS = 30 * 60 * 1000;

/**
 * Fallback context window for SGLang models that report none. SGLang servers
 * are usually launched with `--context-length` (or fall back to the model's
 * own maximum), and its OpenAI-compatible `/v1/models` response often omits
 * the length; this conservative default keeps the prompt budget valid instead
 * of overflowing the server's window.
 */
export const SGLANG_DEFAULT_CONTEXT_WINDOW = 32768;
export const SGLANG_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * A single SGLang server model as exposed through the Nika provider. The
 * workbench-facing id is `sglang/<server id>/<raw id>`; the raw id is what
 * goes on the wire.
 */
export interface NikaSglangCatalogModel {
	/** Raw model id as reported by `/v1/models`, e.g. `Qwen/Qwen3-32B`. */
	readonly id: string;
	readonly name: string;
	/** Resolved BYOK capabilities (limits, tooling, vision). */
	readonly capabilities: BYOKModelCapabilities;
	/** Full context window (input + output) in tokens. */
	readonly contextWindow: number;
}

/**
 * Fetches and caches the model list of SGLang servers (OpenAI-compatible
 * `GET <base>/v1/models`) for the Nika provider group. Unlike the other
 * self-hosted providers, SGLang supports several servers at once: every
 * registered server has its own cache entry, its own optional API key
 * (`nika.sglang.<server id>.apiKey`) and its own id segment in the exposed
 * model ids (`sglang/<server id>/<model id>`).
 */
export class NikaSglangProvider extends Disposable {
	private readonly _catalogCache = new Map<string, { readonly fetchedAt: number; readonly models: ReadonlyMap<string, NikaSglangCatalogModel> }>();
	private readonly _serverInfoCache = new Map<string, { readonly fetchedAt: number; readonly contextWindow: number | undefined }>();

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	/**
	 * The model list of one server, keyed by raw server id. Cached per server
	 * for {@link CATALOG_TTL_MS}; a changed server id or base URL (or an
	 * expired cache) triggers a refetch.
	 */
	async getCatalog(server: NikaSglangServer, apiKey?: string): Promise<ReadonlyMap<string, NikaSglangCatalogModel>> {
		const key = `${server.id}|${server.baseUrl}`;
		const cache = this._catalogCache.get(key);
		if (cache && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) {
			return cache.models;
		}
		try {
			const models = await this._fetchCatalog(server, apiKey);
			this._catalogCache.set(key, { fetchedAt: Date.now(), models });
			return models;
		} catch (error) {
			// A transient failure (the server is loading weights, restarting,
			// or briefly unreachable) must not empty the model picker: serve
			// the last known catalog for this server when one exists, and only
			// surface the error on a first-ever fetch.
			if (cache) {
				return cache.models;
			}
			throw error;
		}
	}

	/**
	 * Catalog entries as a `BYOKKnownModels` map keyed by raw server id, for
	 * use with `byokKnownModelToAPIInfo`-style conversion.
	 */
	async getKnownModels(server: NikaSglangServer, apiKey?: string): Promise<BYOKKnownModels> {
		const catalog = await this.getCatalog(server, apiKey);
		return Object.fromEntries([...catalog].map(([id, model]) => [id, model.capabilities]));
	}

	/**
	 * Build a chat-completions request endpoint for a raw server model id.
	 * Capabilities resolve from the cached catalog when available so the wire
	 * model matches the picker entry exactly. An empty API key means the
	 * request goes out without an `Authorization` header.
	 */
	createEndpoint(modelId: string, server: NikaSglangServer, apiKey?: string): OpenAIEndpoint {
		const key = `${server.id}|${server.baseUrl}`;
		const capabilities = this._catalogCache.get(key)?.models.get(modelId)?.capabilities;
		const modelInfo = resolveModelInfo(modelId, NIKA_PROVIDER_NAME, undefined, capabilities);
		return this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey ?? '', `${server.baseUrl}/v1/chat/completions`);
	}

	/**
	 * Drops every cached model list (used when the API keys or the server list
	 * changed). Context-window lookups are cheap and non-authoritative, so
	 * they are also dropped to stay consistent with the refreshed catalogs.
	 */
	invalidateCache(): void {
		this._catalogCache.clear();
		this._serverInfoCache.clear();
	}

	private async _fetchCatalog(server: NikaSglangServer, apiKey?: string): Promise<ReadonlyMap<string, NikaSglangCatalogModel>> {
		const response = await this._fetcherService.fetch(`${server.baseUrl}/v1/models`, {
			method: 'GET',
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			callSite: 'nika-sglang-models',
		});
		if (!response.ok) {
			// A 404 almost always means the base URL carries a path (commonly a
			// trailing `/v1`) that the requested `/v1/models` is appended to.
			throw new Error(response.status === 404
				? vscode.l10n.t('The SGLang server {0} returned HTTP 404. Check that the base URL points at the server root, without a /v1 path.', server.label)
				: vscode.l10n.t('The SGLang server {0} returned HTTP {1}.', server.label, response.status));
		}
		const body = await response.json() as { data?: unknown[] };
		const models = new Map<string, NikaSglangCatalogModel>();
		// Resolved once per fetch: only consulted when a model entry carries no
		// context length of its own.
		let serverContext: number | undefined | 'unknown' = 'unknown';
		for (const entry of body.data ?? []) {
			if (!entry || typeof entry !== 'object' || !('id' in entry)) {
				continue;
			}
			const id = String(entry.id);
			if (!id) {
				continue;
			}
			// SGLang reports the served length on the model entry in recent
			// versions (`max_model_len`, vLLM-compatible). Older builds expose
			// nothing there, so fall back to the server's launch configuration
			// (`/get_server_info`), and finally to a conservative default.
			let parsedContext = contextFromEntry(entry);
			if (!parsedContext) {
				if (serverContext === 'unknown') {
					serverContext = await this._fetchServerContext(server, apiKey);
				}
				parsedContext = typeof serverContext === 'number' ? serverContext : undefined;
			}
			const contextWindow = parsedContext && parsedContext > 0 ? parsedContext : SGLANG_DEFAULT_CONTEXT_WINDOW;
			// Never let the output reservation eat the whole window: on a server
			// launched with a small context a fixed 4096-token output budget
			// collapses `maxInputTokens` to 0, which makes the language-model
			// wrapper render an empty prompt and fail with an opaque prompt-tsx
			// `BudgetExceededError`. Cap the reservation to half the window,
			// mirroring the Ollama and llama.cpp providers.
			const maxOutputTokens = Math.min(SGLANG_DEFAULT_MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(contextWindow / 2)));
			const limits = resolveModelTokenLimits({
				contextWindow,
				maxInputTokens: contextWindow,
				maxOutputTokens,
			});
			const capabilities: BYOKModelCapabilities = {
				name: id,
				contextWindow: limits.contextWindow,
				maxInputTokens: limits.maxInputTokens,
				maxOutputTokens: limits.maxOutputTokens,
				// SGLang implements the OpenAI tools contract; a model launched
				// without a tool-call parser answers with plain text instead.
				toolCalling: true,
				// The server decides whether the served model accepts images; a
				// text-only model rejects image parts with a clear error. Keep
				// vision advertised so multimodal models work natively.
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

	/**
	 * Best-effort read of the served context length from SGLang's
	 * `/get_server_info` (the serialized launch arguments: `context_length`, or
	 * a `model_config` with the model's own maximum). Every failure — an older
	 * server without the endpoint, authentication, a timeout — degrades to
	 * `undefined` so the caller can use its default instead of failing the
	 * whole catalog fetch.
	 */
	private async _fetchServerContext(server: NikaSglangServer, apiKey?: string): Promise<number | undefined> {
		const key = `${server.id}|${server.baseUrl}`;
		const cached = this._serverInfoCache.get(key);
		if (cached && Date.now() - cached.fetchedAt < SERVER_INFO_TTL_MS) {
			return cached.contextWindow;
		}
		let contextWindow: number | undefined;
		try {
			const response = await this._fetcherService.fetch(`${server.baseUrl}/get_server_info`, {
				method: 'GET',
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
				callSite: 'nika-sglang-server-info',
			});
			if (response.ok) {
				const body = await response.json() as Record<string, unknown>;
				const modelConfig = (body.model_config && typeof body.model_config === 'object') ? body.model_config as Record<string, unknown> : undefined;
				contextWindow = firstPositiveNumber([
					body.context_length,
					body.max_model_len,
					body.max_context_length,
					modelConfig?.context_length,
					modelConfig?.max_model_len,
					modelConfig?.max_position_embeddings,
				]);
			}
		} catch {
			// Optional endpoint: absence or failure is normal.
		}
		this._serverInfoCache.set(key, { fetchedAt: Date.now(), contextWindow });
		return contextWindow;
	}
}

/**
 * Extract a context length from a `/v1/models` entry. SGLang (and vLLM)
 * expose `max_model_len`; some builds also carry `context_length` or a
 * llama.cpp-style `meta` object (harmless to accept, and useful when SGLang
 * serves through a compatibility shim).
 */
function contextFromEntry(entry: object): number | undefined {
	const raw = entry as Record<string, unknown>;
	const meta = (raw.meta && typeof raw.meta === 'object') ? raw.meta as Record<string, unknown> : undefined;
	const value = firstPositiveNumber([
		raw.max_model_len,
		raw.context_length,
		raw.max_context_length,
		meta?.n_ctx,
		meta?.['llama.context_length'],
		meta?.['context_length'],
	]);
	return value;
}

/** The first value that parses to a finite number greater than zero. */
function firstPositiveNumber(values: unknown[]): number | undefined {
	for (const value of values) {
		const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}
