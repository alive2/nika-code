/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { ILogService } from '../../../platform/log/common/logService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKModelCapabilities, resolveModelInfo, resolveModelTokenLimits } from '../common/byokProvider';
import { NIKA_CURSOR_MODEL_PREFIX, NIKA_PROVIDER_NAME } from './nikaModels';
import { CURSOR_API_BASE_URL, CursorAgentRegistry, CursorModelVariant, CursorWireParameter, cursorContextWindowFromParameters, cursorReasoningLevels, isCursorVisionModelId } from '../node/cursorAgentClient';
import { CursorAgentEndpoint } from '../node/cursorAgentEndpoint';

/**
 * The Cursor API host. API keys are created at cursor.com/settings/api-keys
 * and billed to the user's Cursor account (usage-based).
 */
export const CURSOR_BASE_URL = CURSOR_API_BASE_URL;

/**
 * How long a fetched Cursor model list stays usable before it is refetched.
 * Cursor's catalog changes rarely; a 10-minute TTL keeps the picker fresh
 * without hammering the API on every chat start.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * Fallback context window for Cursor models. Cursor serves frontier models
 * (Claude / GPT / Gemini families) whose real windows vary by model; when the
 * `/v1/models` entry does not publish one (no `context` parameter), this 128K
 * default keeps the picker honest without overstating a model's limits.
 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

/**
 * A single Cursor API model as exposed through the Nika provider. The
 * workbench-facing id is `cursor/<raw id>`; the raw id is what goes on the
 * wire. The catalog is Cursor's Cloud Agents catalog (`GET /v1/models` →
 * `{ items: [...] }`): entries declare `id`, `displayName`, and the
 * parameters (`effort` / `reasoning` / `context` / `thinking` / `fast`) the
 * model accepts.
 */
export interface NikaCursorCatalogModel {
	/** Raw model id as reported by `/v1/models`, e.g. `claude-opus-5`. */
	readonly id: string;
	/** Human-readable name, e.g. `Claude Opus 5`. */
	readonly name: string;
	/** Resolved BYOK capabilities (limits, tooling, vision, effort levels). */
	readonly capabilities: BYOKModelCapabilities;
	/** Full context window (input + output) in tokens. */
	readonly contextWindow: number;
	/** Raw catalog parameter schema (drives the UI effort/context labels). */
	readonly parameters: readonly CursorWireParameter[];
	/**
	 * Precomputed catalog variants; agent creation sends one variant's
	 * params verbatim (the API rejects unlisted id+params combinations).
	 */
	readonly variants: readonly CursorModelVariant[];
}

function parseParameters(entry: unknown): CursorWireParameter[] {
	const raw = entry as { parameters?: unknown };
	if (!Array.isArray(raw.parameters)) {
		return [];
	}
	const parameters: CursorWireParameter[] = [];
	for (const item of raw.parameters) {
		if (!item || typeof item !== 'object' || !('id' in item)) {
			continue;
		}
		const id = String((item as { id?: unknown }).id ?? '');
		if (!id) {
			continue;
		}
		const values: CursorWireParameter['values'] = [];
		const rawValues = (item as { values?: unknown }).values;
		if (Array.isArray(rawValues)) {
			for (const valueEntry of rawValues) {
				if (!valueEntry || typeof valueEntry !== 'object' || !('value' in valueEntry)) {
					continue;
				}
				const value = String((valueEntry as { value?: unknown }).value ?? '');
				if (!value) {
					continue;
				}
				const displayName = (valueEntry as { displayName?: unknown }).displayName;
				values.push({ value, ...(typeof displayName === 'string' && displayName ? { displayName } : {}) });
			}
		}
		if (values.length > 0) {
			parameters.push({ id, values });
		}
	}
	return parameters;
}

function parseVariants(entry: unknown): CursorModelVariant[] {
	const raw = entry as { variants?: unknown };
	if (!Array.isArray(raw.variants)) {
		return [];
	}
	const variants: CursorModelVariant[] = [];
	for (const item of raw.variants) {
		if (!item || typeof item !== 'object' || !('params' in item)) {
			continue;
		}
		const rawParams = (item as { params?: unknown }).params;
		if (!Array.isArray(rawParams)) {
			continue;
		}
		const params: { id: string; value: string }[] = [];
		for (const param of rawParams) {
			if (!param || typeof param !== 'object' || !('id' in param) || !('value' in param)) {
				continue;
			}
			const id = String((param as { id?: unknown }).id ?? '');
			const value = String((param as { value?: unknown }).value ?? '');
			if (id && value) {
				params.push({ id, value });
			}
		}
		if (params.length > 0) {
			const isDefault = (item as { isDefault?: unknown }).isDefault;
			variants.push({ params, ...(typeof isDefault === 'boolean' && isDefault ? { isDefault: true } : {}) });
		}
	}
	return variants;
}

/**
 * Fetches and caches the model list of the Cursor Cloud Agents API for the
 * Nika provider group and hands out {@link CursorAgentEndpoint} instances
 * that speak the agent-run protocol (Cursor removed its chat-completions
 * route). Requests are authenticated with the account API key
 * (`Authorization: Bearer <key>`).
 */
export class NikaCursorProvider extends Disposable {
	private _catalogCache: { readonly key: string; readonly fetchedAt: number; readonly models: ReadonlyMap<string, NikaCursorCatalogModel> } | undefined;
	private readonly _agentRegistry: CursorAgentRegistry;

	constructor(
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._agentRegistry = this._register(new CursorAgentRegistry(fetcherService, logService));
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
	 * Builds a Cloud Agents endpoint for a raw Cursor model id. Capabilities
	 * and the catalog variants resolve from the (warm) catalog cache when
	 * available so the agent request matches the picker entry exactly;
	 * `sessionKey` binds the agent to one Nika chat conversation.
	 */
	createEndpoint(modelId: string, apiKey: string, sessionKey: string | undefined, variants?: readonly CursorModelVariant[]): CursorAgentEndpoint {
		const cached = this._catalogCache?.models.get(modelId);
		const capabilities = cached?.capabilities;
		const modelInfo = resolveModelInfo(modelId, NIKA_PROVIDER_NAME, undefined, capabilities);
		return this._instantiationService.createInstance(CursorAgentEndpoint, modelInfo, apiKey, sessionKey, variants ?? cached?.variants ?? [], this._agentRegistry);
	}

	/** Drop the cached model list and conversation agents (key changed). */
	invalidateCache(): void {
		this._catalogCache = undefined;
		this._agentRegistry.invalidate();
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
		// The catalog lives under `items`, not the OpenAI `data` key.
		const body = await response.json() as { items?: unknown[] };
		const models = new Map<string, NikaCursorCatalogModel>();
		for (const entry of body.items ?? []) {
			if (!entry || typeof entry !== 'object' || !('id' in entry)) {
				continue;
			}
			const id = String(entry.id);
			if (!id) {
				continue;
			}
			const raw = entry as { displayName?: unknown };
			const name = typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id;
			const parameters = parseParameters(entry);
			const variants = parseVariants(entry);
			// Context windows are advertised through the `context` parameter
			// (e.g. `200k`, `300k`, `1m`); models without one get the default.
			const windowValue = cursorContextWindowFromParameters(parameters) ?? FALLBACK_CONTEXT_WINDOW;
			const levels = cursorReasoningLevels(parameters);
			const hasThinkingSwitch = parameters.some(parameter => parameter.id === 'thinking');
			const limits = resolveModelTokenLimits({
				contextWindow: windowValue,
				maxInputTokens: windowValue,
				maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
			});
			const capabilities: BYOKModelCapabilities = {
				name,
				contextWindow: limits.contextWindow,
				maxInputTokens: limits.maxInputTokens,
				maxOutputTokens: limits.maxOutputTokens,
				// Cursor agents execute their own tools inside Cursor's cloud
				// sandbox; they are never surfaced as VS Code tool calls, so
				// the chat loop must not schedule tool rounds for them.
				toolCalling: false,
				// Frontier multimodal families accept images natively; the
				// other families (Kimi / GLM / Auto) keep images as text.
				vision: isCursorVisionModelId(id),
				thinking: !!levels || hasThinkingSwitch,
				// Per-model effort levels surfaced in the picker, e.g.
				// `['low','medium','high','max']` for Claude Opus 5.
				...(levels ? { supportsReasoningEffort: levels } : {}),
			};
			models.set(id, {
				id,
				name,
				capabilities,
				contextWindow: limits.contextWindow,
				parameters,
				variants,
			});
		}
		return models;
	}
}

/** The workbench-facing id of a raw Cursor model id under the Nika group. */
export function nikaCursorModelId(rawId: string): string {
	return `${NIKA_CURSOR_MODEL_PREFIX}${rawId}`;
}
