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
import { NIKA_OPENAI_MODEL_PREFIX, NIKA_PROVIDER_NAME, NikaTokenLimits } from './nikaModels';
import { OAIBYOKLMProvider, OpenAIProviderConfig } from './openAIProvider';
import { OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

/**
 * OpenAI base URL used for both the catalog and request endpoints.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * How long a fetched OpenAI catalog stays usable before it is refetched.
 * The catalog changes rarely (new models), so a short TTL keeps the picker
 * fresh without hammering the API on every chat start.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * A single OpenAI catalog entry as exposed through the Nika provider.
 * The workbench-facing id is `openai/<raw catalog id>`; the raw id is what
 * goes on the wire.
 */
export interface NikaOpenAICatalogModel {
	/** Raw OpenAI catalog id, e.g. `gpt-5`. */
	readonly id: string;
	readonly name: string;
	/** Resolved BYOK capabilities (limits, tooling, vision, effort). */
	readonly capabilities: BYOKModelCapabilities;
	/** Full context window (input + output) in tokens. */
	readonly contextWindow: number;
}

/** OpenAI model families that support reasoning effort levels. */
const OPENAI_REASONING_FAMILY = /^(gpt-5|gpt-5-codex|o[134](?:-|$))/i;

/** OpenAI model families that accept images natively. */
const OPENAI_VISION_FAMILY = /^(gpt-5|gpt-4o|gpt-4\.1|o4)/i;

/**
 * A human-friendly display name for a raw OpenAI model id. The catalog has no
 * display names, so the raw id is prettified (`gpt-5-codex` → `GPT-5 Codex`).
 */
function openAIModelDisplayName(rawId: string): string {
	return rawId
		.replace(/^gpt-/i, 'GPT-')
		.replace(/^o\d/i, match => match.toUpperCase())
		.replace(/-codex/i, ' Codex')
		.replace(/-mini/i, ' Mini')
		.replace(/-pro/i, ' Pro')
		.replace(/-preview/i, ' Preview')
		.replace(/-latest/i, '');
}

/**
 * Resolves the BYOK capabilities Nika exposes an OpenAI catalog model with.
 * OpenAI's catalog does not report limits, so the user-configured Nika token
 * limits apply uniformly; family heuristics decide vision and effort support.
 */
export function resolveOpenAIModelCapabilities(rawId: string, limits: NikaTokenLimits): BYOKModelCapabilities {
	const reasoning = OPENAI_REASONING_FAMILY.test(rawId);
	const responsesFamily = /^gpt-5/i.test(rawId);
	return {
		name: openAIModelDisplayName(rawId),
		contextWindow: limits.contextWindow,
		maxInputTokens: limits.maxInputTokens,
		maxOutputTokens: limits.maxOutputTokens,
		toolCalling: true,
		vision: OPENAI_VISION_FAMILY.test(rawId),
		thinking: false,
		...(reasoning
			? {
				supportsReasoningEffort: ['low', 'medium', 'high'] as const,
				defaultReasoningEffort: 'medium' as const,
				reasoningEffortFormat: responsesFamily ? 'responses' as const : 'chat-completions' as const,
			}
			: {}),
		supportedEndpoints: [ModelSupportedEndpoint.ChatCompletions, ModelSupportedEndpoint.Responses],
	};
}

/**
 * Fetches and caches the OpenAI model catalog for the Nika provider group and
 * delegates request handling to the upstream {@link OAIBYOKLMProvider} — the
 * same provider the upstream BYOK picker ships. The delegate honors
 * `model.configuration.apiKey` (`openAIProvider.ts` `createOpenAIEndPoint`),
 * so the Nika key reaches the wire without touching the global BYOK storage.
 */
export class NikaOpenAIProvider extends Disposable {
	private _catalogCache: { readonly key: string; readonly fetchedAt: number; readonly models: ReadonlyMap<string, NikaOpenAICatalogModel> } | undefined;
	private readonly _openAIProvider: OAIBYOKLMProvider;

	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		// `{}` known models: the delegate resolves wire capabilities from the
		// per-model Nika entry (spread into the delegate), and upstream itself
		// registers the OpenAI provider with an empty map (`byokContribution.ts`).
		this._openAIProvider = this._instantiationService.createInstance(OAIBYOKLMProvider, {}, byokStorageService);
	}

	/**
	 * The full catalog keyed by raw model id. Cached for
	 * {@link CATALOG_TTL_MS} per API key; a changed key (or an expired cache)
	 * triggers a refetch.
	 */
	async getCatalog(apiKey: string, limits: NikaTokenLimits): Promise<ReadonlyMap<string, NikaOpenAICatalogModel>> {
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
	 * Delegate a chat request to the upstream OpenAI provider. The Nika entry
	 * (`openai/<raw id>`) is rewritten to the raw wire id with the base URL and
	 * the Nika API key attached, so the upstream endpoint selection
	 * (Responses vs Chat Completions) and tooling apply unchanged.
	 */
	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		apiKey: string,
		messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>,
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const delegate: OpenAICompatibleLanguageModelChatInformation<OpenAIProviderConfig> = {
			...model,
			id: model.id.slice(NIKA_OPENAI_MODEL_PREFIX.length),
			url: OPENAI_BASE_URL,
			configuration: { apiKey },
		};
		return this._openAIProvider.provideLanguageModelChatResponse(delegate, messages, options, progress, token);
	}

	/** Delegate token counting to the upstream OpenAI provider. */
	async provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		apiKey: string,
		text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2,
		token: vscode.CancellationToken,
	): Promise<number> {
		const delegate: OpenAICompatibleLanguageModelChatInformation<OpenAIProviderConfig> = {
			...model,
			id: model.id.slice(NIKA_OPENAI_MODEL_PREFIX.length),
			url: OPENAI_BASE_URL,
			configuration: { apiKey },
		};
		return this._openAIProvider.provideTokenCount(delegate, text, token);
	}

	/** Drop the cached catalog (e.g. after the API key changed). */
	invalidateCache(): void {
		this._catalogCache = undefined;
	}

	private async _fetchCatalog(apiKey: string, limits: NikaTokenLimits): Promise<ReadonlyMap<string, NikaOpenAICatalogModel>> {
		const response = await this._fetcherService.fetch(`${OPENAI_BASE_URL}/models`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
			callSite: 'nika-openai-catalog',
		});
		if (!response.ok) {
			throw new Error(vscode.l10n.t('The OpenAI model catalog returned HTTP {0}.', response.status));
		}
		const body = await response.json() as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
		const models = new Map<string, NikaOpenAICatalogModel>();
		for (const entry of body.data ?? []) {
			if (typeof entry.id !== 'string' || entry.id.length === 0) {
				continue;
			}
			const capabilities = resolveOpenAIModelCapabilities(entry.id, limits);
			models.set(entry.id, {
				id: entry.id,
				name: capabilities.name,
				capabilities,
				contextWindow: (capabilities.maxInputTokens ?? 0) + (capabilities.maxOutputTokens ?? 0),
			});
		}
		return models;
	}
}

/** The workbench-facing id of a raw OpenAI catalog id under the Nika group. */
export function nikaOpenAIModelId(rawId: string): string {
	return `${NIKA_OPENAI_MODEL_PREFIX}${rawId}`;
}
