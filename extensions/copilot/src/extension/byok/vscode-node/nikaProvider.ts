/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKKnownModels, BYOKModelCapabilities, byokKnownModelToAPIInfo, resolveModelInfo, resolveModelTokenLimits } from '../common/byokProvider';
import { DeepSeekEndpoint } from '../node/deepSeekEndpoint';
import { ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';
import { byokKnownModelToAPIInfoWithEffort, byokKnownModelToAPIInfoWithEffortAndSpeed } from './byokModelInfo';
import { GeminiNativeBYOKLMProvider } from './geminiNativeProvider';
import { NikaIndexingStatus } from './nikaIndexingStatus';
import { NikaUsageStatus } from './nikaUsageStatus';
import {
	getNikaModelCapabilities,
	getNikaSelectedModels,
	getVisibleNikaModelIds,
	isNikaAnthropicModel,
	isNikaChatGptSubModel,
	isNikaClaudeSubModel,
	isNikaCursorModel,
	isNikaDeepSeekModel,
	isNikaDeepSeekVisionModel,
	isNikaDeepSeekWebModel,
	isNikaGeminiCatalogModel,
	isNikaGeminiModel,
	isNikaLlamaCppModel,
	isNikaModelId,
	isNikaOllamaModel,
	isNikaOpenAIModel,
	isNikaOpenRouterModel,
	isNikaThinkingEffort,
	NIKA_CURSOR_MODEL_PREFIX,
	NIKA_CURSOR_SECRET,
	NIKA_ANTHROPIC_MODEL_PREFIX,
	NIKA_ANTHROPIC_SECRET,
	NIKA_CHATGPT_MODEL_PREFIX,
	NIKA_CHATGPT_SUB_SECRET,
	NIKA_CLAUDE_SUB_MODEL_PREFIX,
	NIKA_CLAUDE_SUB_SECRET,
	NIKA_DEEPSEEK_SECRET,
	NIKA_DEEPSEEK_WEB_SECRET,
	NIKA_GEMINI_MODEL_IDS,
	NIKA_GEMINI_MODEL_PREFIX,
	NIKA_GEMINI_SECRET,
	NIKA_GEMMA_MODEL_ID,
	NIKA_LLAMACPP_MODEL_PREFIX,
	NIKA_LLAMACPP_SECRET,
	NIKA_OLLAMA_MODEL_PREFIX,
	NIKA_OPENAI_MODEL_PREFIX,
	NIKA_OPENAI_SECRET,
	NIKA_OPENROUTER_MODEL_PREFIX,
	NIKA_OPENROUTER_SECRET,
	NIKA_PROVIDER_ID,
	NIKA_PROVIDER_NAME,
	NIKA_RESPONSES_MODEL,
	NikaChatGptSubscriptionToken,
	NikaClaudeSubscriptionToken,
	NikaModelId,
	NikaProviderConfig,
	parseNikaChatGptSubscriptionToken,
	parseNikaClaudeSubscriptionToken,
	parseNikaProviderConfig,
	resolveNikaTokenLimits,
} from './nikaModels';
import { NikaOpenRouterProvider, nikaOpenRouterModelId } from './nikaOpenRouterProvider';
import { NikaOpenAIProvider, nikaOpenAIModelId, resolveOpenAIModelCapabilities } from './nikaOpenAIProvider';
import { NikaAnthropicProvider, nikaAnthropicModelId, resolveAnthropicModelCapabilities } from './nikaAnthropicProvider';
import { NikaChatGptSubProvider, nikaChatGptModelId, resolveChatGptSubModelCapabilities } from './nikaChatGptSubProvider';
import { NikaClaudeSubProvider, nikaClaudeModelId } from './nikaClaudeSubProvider';
import { LLAMACPP_DEFAULT_CONTEXT_WINDOW, LLAMACPP_DEFAULT_MAX_OUTPUT_TOKENS, NikaLlamaCppProvider, nikaLlamaCppModelId } from './nikaLlamaCppProvider';
import { NikaCursorProvider, nikaCursorModelId } from './nikaCursorProvider';
import { NikaGeminiProvider, nikaGeminiModelId } from './nikaGeminiProvider';
import { NikaDeepSeekWebProvider } from './nikaDeepSeekWebProvider';
import { NIKA_ANTHROPIC_PRICES, NIKA_OPENAI_PRICES, OpenRouterModelPricing } from './nikaPricing';
import { NikaSettingsEditor } from './nikaSettingsEditor';
import { NikaAttachmentProcessor } from './nikaAttachments';
import { NikaUsageTracker, TokenTrackingProgress } from './nikaUsageTracker';
import { OllamaConfig, OllamaLMProvider } from './ollamaProvider';

export interface NikaLanguageModelChatInformation extends vscode.LanguageModelChatInformation {
	readonly isBYOK: true;
}

/**
 * A model listed by a local Ollama host's `/api/tags` endpoint, with the
 * resolved capabilities Nika exposes it with.
 */
interface OllamaCatalogModel {
	readonly name: string;
	readonly capabilities: BYOKModelCapabilities;
}

/** How long a fetched Ollama model list stays usable before refetching. */
const OLLAMA_CATALOG_TTL_MS = 10 * 1000;

/**
 * Refresh the subscription access token when it expires within this window.
 * Mirrors the codex CLI's ChatGPT refresh window; Claude access tokens carry
 * a similar server-controlled lifetime.
 */
const SUB_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export class NikaLMProvider extends Disposable implements vscode.LanguageModelChatProvider<NikaLanguageModelChatInformation> {
	public static readonly providerId = NIKA_PROVIDER_ID;
	public static readonly providerName = NIKA_PROVIDER_NAME;

	private readonly _onDidChange = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	private readonly _lmWrapper: CopilotLanguageModelWrapper;
	private readonly _geminiProvider: GeminiNativeBYOKLMProvider;
	private readonly _ollamaProvider: OllamaLMProvider;
	private readonly _attachmentProcessor: NikaAttachmentProcessor;
	private readonly _openRouterProvider: NikaOpenRouterProvider;
	private readonly _llamaCppProvider: NikaLlamaCppProvider;
	private readonly _geminiCatalogProvider: NikaGeminiProvider;
	private readonly _cursorProvider: NikaCursorProvider;
	private readonly _deepSeekWebProvider: NikaDeepSeekWebProvider;
	private readonly _openAIProvider: NikaOpenAIProvider;
	private readonly _anthropicProvider: NikaAnthropicProvider;
	private readonly _chatGptSubProvider: NikaChatGptSubProvider;
	private readonly _claudeSubProvider: NikaClaudeSubProvider;
	private _ollamaCatalogCache: { readonly fetchedAt: number; readonly models: ReadonlyMap<string, OllamaCatalogModel> } | undefined;
	private _chatGptRefresh: Promise<NikaChatGptSubscriptionToken | undefined> | undefined;
	private _claudeRefresh: Promise<NikaClaudeSubscriptionToken | undefined> | undefined;
	readonly settingsEditor: NikaSettingsEditor;
	readonly usageTracker: NikaUsageTracker;

	constructor(
		byokStorageService: IBYOKStorageService,
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
		this._geminiProvider = this._instantiationService.createInstance(GeminiNativeBYOKLMProvider, this._geminiKnownModels(), byokStorageService);
		this._ollamaProvider = this._instantiationService.createInstance(OllamaLMProvider, byokStorageService);
		this._ollamaProvider.updateKnownModels(this._gemmaKnownModels());
		this._openRouterProvider = this._register(this._instantiationService.createInstance(NikaOpenRouterProvider));
		this._llamaCppProvider = this._register(this._instantiationService.createInstance(NikaLlamaCppProvider));
		this._geminiCatalogProvider = this._register(this._instantiationService.createInstance(NikaGeminiProvider));
		this._cursorProvider = this._register(this._instantiationService.createInstance(NikaCursorProvider));
		this._deepSeekWebProvider = this._register(this._instantiationService.createInstance(NikaDeepSeekWebProvider));
		this._openAIProvider = this._register(this._instantiationService.createInstance(NikaOpenAIProvider, byokStorageService));
		this._anthropicProvider = this._register(this._instantiationService.createInstance(NikaAnthropicProvider, byokStorageService));
		this._chatGptSubProvider = this._register(this._instantiationService.createInstance(NikaChatGptSubProvider));
		this._claudeSubProvider = this._register(this._instantiationService.createInstance(NikaClaudeSubProvider));
		this.usageTracker = this._register(this._instantiationService.createInstance(NikaUsageTracker));
		this.settingsEditor = this._register(this._instantiationService.createInstance(NikaSettingsEditor, this.usageTracker, this._openRouterProvider, this._llamaCppProvider, this._geminiCatalogProvider, this._cursorProvider, this._deepSeekWebProvider, this._openAIProvider, this._anthropicProvider, this._chatGptSubProvider, this._claudeSubProvider));
		this._attachmentProcessor = this._instantiationService.createInstance(NikaAttachmentProcessor, this.settingsEditor, this._deepSeekWebProvider);
		this._register(this._instantiationService.createInstance(NikaIndexingStatus, this.settingsEditor));
		this._register(this._instantiationService.createInstance(NikaUsageStatus, this.settingsEditor, this.usageTracker));

		this._register(this._context.secrets.onDidChange(event => {
			if (event.key === NIKA_DEEPSEEK_SECRET || event.key === NIKA_GEMINI_SECRET || event.key === NIKA_OPENROUTER_SECRET || event.key === NIKA_LLAMACPP_SECRET || event.key === NIKA_CURSOR_SECRET || event.key === NIKA_DEEPSEEK_WEB_SECRET || event.key === NIKA_OPENAI_SECRET || event.key === NIKA_ANTHROPIC_SECRET || event.key === NIKA_CHATGPT_SUB_SECRET || event.key === NIKA_CLAUDE_SUB_SECRET) {
				if (event.key === NIKA_OPENROUTER_SECRET || event.key === NIKA_LLAMACPP_SECRET || event.key === NIKA_CURSOR_SECRET) {
					// A changed key must never reuse a stale catalog fetch.
					this._openRouterProvider.invalidateCache();
					this._llamaCppProvider.invalidateCache();
					this._cursorProvider.invalidateCache();
				}
				if (event.key === NIKA_GEMINI_SECRET) {
					this._geminiCatalogProvider.invalidateCache();
				}
				if (event.key === NIKA_DEEPSEEK_WEB_SECRET) {
					// A changed token must never reuse stale clients or sessions.
					this._deepSeekWebProvider.invalidateCache();
				}
				if (event.key === NIKA_OPENAI_SECRET) {
					// A changed key must never reuse a stale catalog fetch.
					this._openAIProvider.invalidateCache();
				}
				if (event.key === NIKA_ANTHROPIC_SECRET) {
					// A changed key must never reuse a stale catalog fetch.
					this._anthropicProvider.invalidateCache();
				}
				this._onDidChange.fire();
			}
		}));
		this._register(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('nika.providers')) {
				this._onDidChange.fire();
			}
			if (event.affectsConfiguration('nika.outputTokens') || event.affectsConfiguration('nika.contextWindow') || event.affectsConfiguration('nika.thinkingEffort') || event.affectsConfiguration('nika.ollamaBaseUrl')) {
				this._ollamaCatalogCache = undefined;
				this._ollamaProvider.updateKnownModels(this._gemmaKnownModels());
				this._onDidChange.fire();
			}
			if (event.affectsConfiguration('nika.llamaCppBaseUrl')) {
				this._llamaCppProvider.invalidateCache();
				this._onDidChange.fire();
			}
		}));
	}

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): Promise<NikaLanguageModelChatInformation[]> {
		const [deepseekKey, geminiKey, openRouterKey, llamaCppKey, cursorKey, deepSeekWebToken, openAIKey, anthropicKey, chatGptSubToken, claudeSubToken] = await Promise.all([
			this._context.secrets.get(NIKA_DEEPSEEK_SECRET),
			this._context.secrets.get(NIKA_GEMINI_SECRET),
			this._context.secrets.get(NIKA_OPENROUTER_SECRET),
			this._context.secrets.get(NIKA_LLAMACPP_SECRET),
			this._context.secrets.get(NIKA_CURSOR_SECRET),
			this._context.secrets.get(NIKA_DEEPSEEK_WEB_SECRET),
			this._context.secrets.get(NIKA_OPENAI_SECRET),
			this._context.secrets.get(NIKA_ANTHROPIC_SECRET),
			this._context.secrets.get(NIKA_CHATGPT_SUB_SECRET),
			this._context.secrets.get(NIKA_CLAUDE_SUB_SECRET),
		]);
		const limits = this._limits();
		const providerConfig = parseNikaProviderConfig(vscode.workspace.getConfiguration('nika').get('providers'));
		const modelIds = getVisibleNikaModelIds(!!deepseekKey, !!geminiKey, providerConfig);
		const defaultModel = vscode.workspace.getConfiguration('nika').get<string>('defaultModel', NIKA_RESPONSES_MODEL).replace(/^nika\//, '');

		const entries = modelIds.map(id => {
			const capabilities = getNikaModelCapabilities(id, limits);
			if (isNikaDeepSeekModel(id)) {
				const configuredEffort = vscode.workspace.getConfiguration('nika').get<string>('thinkingEffort', 'high');
				capabilities.defaultReasoningEffort = capabilities.supportsReasoningEffort?.includes(configuredEffort) ? configuredEffort : 'high';
			}
			const base = isNikaDeepSeekModel(id)
				? byokKnownModelToAPIInfoWithEffort(NIKA_PROVIDER_NAME, id, capabilities)
				: byokKnownModelToAPIInfo(NIKA_PROVIDER_NAME, id, capabilities);
			return {
				...base,
				name: capabilities.name,
				detail: vscode.l10n.t('Nika'),
				tooltip: this._tooltipFor(id),
				isBYOK: true,
				isDefault: id === defaultModel,
				statusIcon: id === NIKA_GEMMA_MODEL_ID ? new vscode.ThemeIcon('server') : undefined,
			};
		});

		// Live Gemini catalog: managed mode exposes exactly the wizard-selected
		// catalog models (everything beyond the curated native lineup, which is
		// already part of `entries` above). Legacy mode never lists the catalog
		// — the classic two native ids are the whole classic Gemini surface.
		// A selection that contains only native ids skips the fetch entirely.
		if (geminiKey && providerConfig) {
			const selected = getNikaSelectedModels(providerConfig, 'gemini');
			if (selected && selected.some(id => isNikaGeminiCatalogModel(id))) {
				try {
					const catalog = await this._geminiCatalogProvider.getCatalog(geminiKey);
					for (const [rawId, model] of catalog) {
						const id = nikaGeminiModelId(rawId);
						if (!selected.includes(id)) {
							continue;
						}
						const base = byokKnownModelToAPIInfo(NIKA_PROVIDER_NAME, id, model.capabilities);
						entries.push({
							...base,
							name: model.name,
							detail: vscode.l10n.t('Nika'),
							tooltip: this._geminiCatalogTooltip(rawId),
							// Gemini accepts image and document parts natively.
							capabilities: {
								...base.capabilities,
								imageInput: true,
							},
							isBYOK: true,
							isDefault: id === defaultModel,
							statusIcon: undefined,
						});
					}
				} catch (error) {
					// A catalog failure must not hide the other Nika models.
					this.logGeminiCatalogError(error);
				}
			}
		}

		if (openRouterKey) {
			// Managed mode exposes exactly the wizard-selected catalog models;
			// legacy mode exposes the full catalog whenever a key is present.
			// A provider that was never added through the wizard (but has a
			// leftover key) must not leak its models into the picker.
			const selected = getNikaSelectedModels(providerConfig, 'openrouter');
			if (selected === undefined ? providerConfig === undefined : selected.length > 0) {				try {
					const catalog = await this._openRouterProvider.getCatalog(openRouterKey);
					for (const [rawId, model] of catalog) {
						const id = nikaOpenRouterModelId(rawId);
						if (selected && !selected.includes(id)) {
							continue;
						}
						const base = byokKnownModelToAPIInfoWithEffort(NIKA_PROVIDER_NAME, id, model.capabilities);
						entries.push({
							...base,
							name: model.name,
							detail: vscode.l10n.t('Nika'),
							tooltip: this._openRouterTooltip(rawId, model.capabilities.vision),
							// Nika preprocesses images and PDFs into text before
							// forwarding to OpenRouter (the same conversion it runs
							// for native DeepSeek). Advertise image input so the
							// workbench lets users attach images to text-only
							// OpenRouter models instead of blocking them.
							capabilities: {
								...base.capabilities,
								imageInput: true,
							},
							isBYOK: true,
							isDefault: id === defaultModel,
							statusIcon: undefined,
						});
					}
				} catch (error) {
					// A catalog failure must not hide the DeepSeek/Gemini/Gemma
					// models: log it and continue with what we have.
					this.logOpenRouterError(error);
				}
			}
		}

		// DeepSeek web chat: exposed whenever a web token exists. Managed mode
		// exposes exactly the wizard-selected model(s); legacy mode exposes
		// the single web chat model.
		if (deepSeekWebToken) {
			const selected = getNikaSelectedModels(providerConfig, 'deepseekweb');
			if (selected === undefined ? providerConfig === undefined : selected.length > 0) {
				for (const [id, capabilities] of Object.entries(this._deepSeekWebProvider.getKnownModels())) {
					if (selected && !selected.includes(id)) {
						continue;
					}
					const base = byokKnownModelToAPIInfo(NIKA_PROVIDER_NAME, id, capabilities);
					entries.push({
						...base,
						name: capabilities.name,
						detail: vscode.l10n.t('Nika'),
						tooltip: this._deepSeekWebTooltip(),
						// Images are uploaded to DeepSeek's servers and analyzed
						// natively; no vision-backend preprocessing is needed.
						capabilities: {
							...base.capabilities,
							imageInput: capabilities.vision ?? false,
						},
						isBYOK: true,
						isDefault: id === defaultModel,
						statusIcon: undefined,
					});
				}
			}
		}

		// OpenAI catalog: managed mode exposes exactly the wizard-selected
		// models; legacy mode exposes the full catalog whenever a key exists.
		if (openAIKey) {
			const selected = getNikaSelectedModels(providerConfig, 'openai');
			if (selected === undefined ? providerConfig === undefined : selected.length > 0) {
				try {
					const catalog = await this._openAIProvider.getCatalog(openAIKey, limits);
					for (const [rawId, model] of catalog) {
						const id = nikaOpenAIModelId(rawId);
						if (selected && !selected.includes(id)) {
							continue;
						}
						const base = byokKnownModelToAPIInfoWithEffort(NIKA_PROVIDER_NAME, id, model.capabilities);
						entries.push({
							...base,
							name: model.name,
							detail: vscode.l10n.t('Nika'),
							tooltip: this._openAITooltip(rawId, model.capabilities.vision),
							// Vision-capable OpenAI models pass images through natively;
							// text-only families are described by the Nika vision
							// backend first. Advertise image input so the workbench
							// lets users attach images either way.
							capabilities: {
								...base.capabilities,
								imageInput: true,
							},
							isBYOK: true,
							isDefault: id === defaultModel,
							statusIcon: undefined,
						});
					}
				} catch (error) {
					// A key that is invalid (or an API outage) must not hide the
					// other Nika models: log and continue.
					this.logOpenAIError(error);
				}
			}
		}

		// Anthropic catalog: managed mode exposes exactly the wizard-selected
		// models; legacy mode exposes the full catalog whenever a key exists.
		if (anthropicKey) {
			const selected = getNikaSelectedModels(providerConfig, 'anthropic');
			if (selected === undefined ? providerConfig === undefined : selected.length > 0) {
				try {
					const catalog = await this._anthropicProvider.getCatalog(anthropicKey, limits);
					for (const [rawId, model] of catalog) {
						const id = nikaAnthropicModelId(rawId);
						if (selected && !selected.includes(id)) {
							continue;
						}
						const base = byokKnownModelToAPIInfo(NIKA_PROVIDER_NAME, id, model.capabilities);
						entries.push({
							...base,
							name: model.name,
							detail: vscode.l10n.t('Nika'),
							tooltip: this._anthropicTooltip(rawId, model.capabilities.vision),
							// Claude models accept images natively (vision
							// families); the vision-preprocessing toggle still
							// decides whether images are described first.
							capabilities: {
								...base.capabilities,
								imageInput: true,
							},
							isBYOK: true,
							isDefault: id === defaultModel,
							statusIcon: undefined,
						});
					}
				} catch (error) {
					// A key that is invalid (or an API outage) must not hide the
					// other Nika models: log and continue.
					this.logAnthropicError(error);
				}
			}
		}

		// ChatGPT subscription catalog: the live backend catalog merged over
		// the bundled static one (a failed fetch degrades to static). Managed
		// mode exposes exactly the wizard-selected models; legacy mode exposes
		// the full lineup whenever a token exists. Entries carry the Thinking
		// Effort (codex `low`..`ultra`) and Speed (Standard / Fast) pickers.
		if (chatGptSubToken) {
			const selected = getNikaSelectedModels(providerConfig, 'chatgpt');
			if (selected === undefined ? providerConfig === undefined : selected.length > 0) {
				const knownModels = await this._chatGptSubProvider.getLiveKnownModels(chatGptSubToken, limits);
				for (const [rawId, capabilities] of Object.entries(knownModels)) {
					const id = nikaChatGptModelId(rawId);
					if (selected && !selected.includes(id)) {
						continue;
					}
					const base = byokKnownModelToAPIInfoWithEffortAndSpeed(NIKA_PROVIDER_NAME, id, capabilities);
					entries.push({
						...base,
						name: capabilities.name,
						detail: vscode.l10n.t('Nika'),
						tooltip: this._chatGptSubTooltip(rawId),
						// GPT-5 Codex models accept images natively; the vision-
						// preprocessing toggle still decides whether images are
						// described first.
						capabilities: {
							...base.capabilities,
							imageInput: true,
						},
						isBYOK: true,
						isDefault: id === defaultModel,
						statusIcon: undefined,
					});
				}
			}
		}

		// Claude subscription catalog: static (no fetch needed). Managed mode
		// exposes exactly the wizard-selected models; legacy mode exposes the
		// full lineup whenever a token exists.
		if (claudeSubToken) {
			const selected = getNikaSelectedModels(providerConfig, 'claude');
			if (selected === undefined ? providerConfig === undefined : selected.length > 0) {
				for (const [rawId, capabilities] of Object.entries(this._claudeSubProvider.getKnownModels(limits))) {
					const id = nikaClaudeModelId(rawId);
					if (selected && !selected.includes(id)) {
						continue;
					}
					const base = byokKnownModelToAPIInfo(NIKA_PROVIDER_NAME, id, capabilities);
					entries.push({
						...base,
						name: capabilities.name,
						detail: vscode.l10n.t('Nika'),
						tooltip: this._claudeSubTooltip(rawId),
						// Claude models accept images natively (vision families);
						// the vision-preprocessing toggle still decides whether
						// images are described first.
						capabilities: {
							...base.capabilities,
							imageInput: true,
						},
						isBYOK: true,
						isDefault: id === defaultModel,
						statusIcon: undefined,
					});
				}
			}
		}

		const llamaCppBaseUrl = this._llamaCppBaseUrl();
		if (llamaCppBaseUrl) {
			const selected = getNikaSelectedModels(providerConfig, 'llamacpp');
			if (selected === undefined ? providerConfig === undefined : selected.length > 0) {
				try {
					const catalog = await this._llamaCppProvider.getCatalog(llamaCppBaseUrl, llamaCppKey ?? undefined);
					for (const [rawId, model] of catalog) {
						const id = nikaLlamaCppModelId(rawId);
						if (selected && !selected.includes(id)) {
							continue;
						}
						const base = byokKnownModelToAPIInfo(NIKA_PROVIDER_NAME, id, model.capabilities);
						entries.push({
							...base,
							name: model.name,
							detail: vscode.l10n.t('Nika'),
							tooltip: this._llamaCppTooltip(rawId, llamaCppBaseUrl),
							// llama.cpp models are multimodal-capable: image parts ride
							// through natively as image_url data URIs with no vision
							// backend preprocessing.
							capabilities: {
								...base.capabilities,
								imageInput: true,
							},
							isBYOK: true,
							isDefault: id === defaultModel,
							statusIcon: new vscode.ThemeIcon('server'),
						});
					}
				} catch (error) {
					// A server that is unreachable (or a server without any loaded
					// models) must not hide the other Nika models: log and continue.
					this.logLlamaCppError(error);
				}
			}
		}

		// Cursor API catalog: managed mode exposes exactly the wizard-selected
		// models; legacy mode exposes the full catalog whenever a key exists.
		if (cursorKey) {
			const selected = getNikaSelectedModels(providerConfig, 'cursor');
			if (selected === undefined ? providerConfig === undefined : selected.length > 0) {
				try {
					const catalog = await this._cursorProvider.getCatalog(cursorKey);
					for (const [rawId, model] of catalog) {
						const id = nikaCursorModelId(rawId);
						if (selected && !selected.includes(id)) {
							continue;
						}
						const base = byokKnownModelToAPIInfo(NIKA_PROVIDER_NAME, id, model.capabilities);
						entries.push({
							...base,
							name: model.name,
							detail: vscode.l10n.t('Nika'),
							tooltip: this._cursorTooltip(rawId),
							// Cursor serves frontier multimodal models (Claude /
							// GPT / Gemini families): image parts ride through
							// natively with no vision-backend preprocessing.
							capabilities: {
								...base.capabilities,
								imageInput: true,
							},
							isBYOK: true,
							isDefault: id === defaultModel,
							statusIcon: new vscode.ThemeIcon('server'),
						});
					}
				} catch (error) {
					// A key that is invalid (or an API outage) must not hide the
					// other Nika models: log and continue.
					this.logCursorError(error);
				}
			}
		}

		// Dynamic Ollama catalog: managed mode exposes exactly the wizard-
		// selected models pulled on the configured host. Legacy mode needs no
		// catalog here — the classic Gemma id is already part of the native
		// entries above.
		if (providerConfig) {
			const selected = getNikaSelectedModels(providerConfig, 'ollama');
			if (selected && selected.length > 0) {
				const ollamaBaseUrl = this._ollamaBaseUrl();
				try {
					const catalog = await this._ollamaCatalog(ollamaBaseUrl);
					for (const [name, model] of catalog) {
						const id = `${NIKA_OLLAMA_MODEL_PREFIX}${name}`;
						if (!selected.includes(id)) {
							continue;
						}
						const base = byokKnownModelToAPIInfo(NIKA_PROVIDER_NAME, id, model.capabilities);
						entries.push({
							...base,
							name: model.name,
							detail: vscode.l10n.t('Nika'),
							tooltip: this._ollamaTooltip(name, ollamaBaseUrl),
							capabilities: {
								...base.capabilities,
								imageInput: true,
							},
							isBYOK: true,
							isDefault: id === defaultModel,
							statusIcon: new vscode.ThemeIcon('server'),
						});
					}
				} catch (error) {
					// An unreachable host must not hide the other Nika models.
					this.logOllamaError(error);
				}
			}
		}

		return entries as NikaLanguageModelChatInformation[];
	}

	private _openRouterTooltip(rawId: string, nativeVision: boolean): string {
		if (nativeVision) {
			return vscode.l10n.t('{0} via OpenRouter with catalog pricing and native image input.', rawId);
		}
		// Text-only OpenRouter models still accept images because Nika converts
		// them to a text description first (via the configured vision backend).
		return vscode.l10n.t('{0} via OpenRouter with catalog pricing. Images are described by your Nika vision backend first.', rawId);
	}

	private _openAITooltip(rawId: string, nativeVision: boolean): string {
		if (nativeVision) {
			return vscode.l10n.t('{0} via OpenAI with native image input and per-request pricing.', rawId);
		}
		// Text-only OpenAI models still accept images because Nika converts
		// them to a text description first (via the configured vision backend).
		return vscode.l10n.t('{0} via OpenAI. Images are described by your Nika vision backend first.', rawId);
	}

	private _anthropicTooltip(rawId: string, nativeVision: boolean): string {
		if (nativeVision) {
			return vscode.l10n.t('{0} via Anthropic with native image input and per-request pricing.', rawId);
		}
		// Text-only Anthropic models still accept images because Nika converts
		// them to a text description first (via the configured vision backend).
		return vscode.l10n.t('{0} via Anthropic. Images are described by your Nika vision backend first.', rawId);
	}

	private _chatGptSubTooltip(rawId: string): string {
		return vscode.l10n.t('{0} via your ChatGPT subscription (codex backend) with native image input. Uses your plan\'s quota.', rawId);
	}

	private _claudeSubTooltip(rawId: string): string {
		return vscode.l10n.t('{0} via your Claude subscription with native image input. Uses your plan\'s quota.', rawId);
	}

	/**
	 * The OpenRouter model id sent on the wire for a raw catalog id. When the
	 * `nika.openrouterFloor` toggle is on, the `:floor` variant suffix is
	 * appended so OpenRouter serves the request at the lowest-cost provider.
	 * The catalog lookup always uses the base id; only the wire id is suffixed.
	 */
	private _openRouterWireModelId(rawId: string): string {
		const floor = vscode.workspace.getConfiguration('nika').get<boolean>('openrouterFloor', false);
		if (floor && !rawId.endsWith(':floor')) {
			return `${rawId}:floor`;
		}
		return rawId;
	}

	private _llamaCppTooltip(rawId: string, baseUrl: string): string {
		return vscode.l10n.t('{0} served by llama.cpp at {1}. Images pass through natively (no vision backend).', rawId, baseUrl);
	}

	private _geminiCatalogTooltip(rawId: string): string {
		return vscode.l10n.t('{0} from the Google Gemini catalog with native image and document input.', rawId);
	}

	private _cursorTooltip(rawId: string): string {
		return vscode.l10n.t('{0} served by the Cursor API. Images pass through natively (no vision backend).', rawId);
	}

	private _ollamaTooltip(name: string, baseUrl: string): string {
		return vscode.l10n.t('{0} served by Ollama at {1}. Images pass through natively (no vision backend).', name, baseUrl);
	}

	private _llamaCppBaseUrl(): string {
		return vscode.workspace.getConfiguration('nika').get<string>('llamaCppBaseUrl', 'http://localhost:8080').replace(/\/$/, '');
	}

	private _ollamaBaseUrl(): string {
		return vscode.workspace.getConfiguration('nika').get<string>('ollamaBaseUrl', 'http://localhost:11434').replace(/\/$/, '');
	}

	/**
	 * The model list of the configured Ollama host, keyed by model name.
	 * Cached for {@link OLLAMA_CATALOG_TTL_MS}; a changed host (or an expired
	 * cache) triggers a refetch.
	 */
	private async _ollamaCatalog(baseUrl: string): Promise<ReadonlyMap<string, OllamaCatalogModel>> {
		const cache = this._ollamaCatalogCache;
		if (cache && Date.now() - cache.fetchedAt < OLLAMA_CATALOG_TTL_MS) {
			return cache.models;
		}
		const response = await this._fetcherService.fetch(`${baseUrl}/api/tags`, { method: 'GET', callSite: 'nika-ollama-tags' });
		if (!response.ok) {
			throw new Error(vscode.l10n.t('The Ollama host returned HTTP {0}.', response.status));
		}
		const body = await response.json() as { models?: unknown[] };
		const models = new Map<string, OllamaCatalogModel>();
		for (const entry of body.models ?? []) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			const name = String((entry as { name?: unknown }).name ?? '').trim();
			if (!name) {
				continue;
			}
			const limits = resolveModelTokenLimits({
				contextWindow: LLAMACPP_DEFAULT_CONTEXT_WINDOW,
				maxInputTokens: LLAMACPP_DEFAULT_CONTEXT_WINDOW,
				maxOutputTokens: LLAMACPP_DEFAULT_MAX_OUTPUT_TOKENS,
			});
			const capabilities: BYOKModelCapabilities = {
				name,
				contextWindow: limits.contextWindow,
				maxInputTokens: limits.maxInputTokens,
				maxOutputTokens: limits.maxOutputTokens,
				toolCalling: true,
				// The host decides whether a pulled model accepts images; a
				// text-only model rejects image parts with a clear error.
				vision: true,
				thinking: false,
			};
			models.set(name, { name, capabilities });
		}
		this._ollamaCatalogCache = { fetchedAt: Date.now(), models };
		return models;
	}

	private logOllamaError(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[Nika] Ollama model list failed: ${detail}`);
	}

	private logLlamaCppError(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[Nika] llama.cpp model list failed: ${detail}`);
	}

	private logOpenRouterError(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[Nika] OpenRouter catalog failed: ${detail}`);
	}

	private logGeminiCatalogError(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[Nika] Gemini catalog failed: ${detail}`);
	}

	private logCursorError(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[Nika] Cursor catalog failed: ${detail}`);
	}

	private logOpenAIError(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[Nika] OpenAI catalog failed: ${detail}`);
	}

	private logAnthropicError(error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[Nika] Anthropic catalog failed: ${detail}`);
	}

	/**
	 * Whether a request for the given (bare exposed) model id is allowed under
	 * the current provider config. Legacy mode (no `nika.providers` setting)
	 * allows everything that the provider can still serve. Managed mode only
	 * allows models the user selected in the Providers wizard, so a stale
	 * default-model reference fails fast with a clear error instead of
	 * silently round-tripping to a provider the user disabled.
	 */
	private _isNikaModelEnabledForRequest(id: string, providerConfig: NikaProviderConfig | undefined): boolean {
		if (!providerConfig) {
			return true;
		}
		if (isNikaDeepSeekModel(id)) {
			return getNikaSelectedModels(providerConfig, 'deepseek')?.includes(id) ?? false;
		}
		if (isNikaGeminiModel(id) || isNikaGeminiCatalogModel(id)) {
			return getNikaSelectedModels(providerConfig, 'gemini')?.includes(id) ?? false;
		}
		if (isNikaOpenRouterModel(id)) {
			return getNikaSelectedModels(providerConfig, 'openrouter')?.includes(id) ?? false;
		}
		if (isNikaLlamaCppModel(id)) {
			return getNikaSelectedModels(providerConfig, 'llamacpp')?.includes(id) ?? false;
		}
		if (isNikaOllamaModel(id)) {
			return getNikaSelectedModels(providerConfig, 'ollama')?.includes(id) ?? false;
		}
		if (isNikaCursorModel(id)) {
			return getNikaSelectedModels(providerConfig, 'cursor')?.includes(id) ?? false;
		}
		if (isNikaDeepSeekWebModel(id)) {
			return getNikaSelectedModels(providerConfig, 'deepseekweb')?.includes(id) ?? false;
		}
		if (isNikaOpenAIModel(id)) {
			return getNikaSelectedModels(providerConfig, 'openai')?.includes(id) ?? false;
		}
		if (isNikaAnthropicModel(id)) {
			return getNikaSelectedModels(providerConfig, 'anthropic')?.includes(id) ?? false;
		}
		if (isNikaChatGptSubModel(id)) {
			return getNikaSelectedModels(providerConfig, 'chatgpt')?.includes(id) ?? false;
		}
		if (isNikaClaudeSubModel(id)) {
			return getNikaSelectedModels(providerConfig, 'claude')?.includes(id) ?? false;
		}
		// The legacy bare Gemma id is not part of managed mode (Ollama models
		// are exposed as `ollama/<name>` there), so it is rejected.
		return false;
	}

	private _providerConfig(): NikaProviderConfig | undefined {
		return parseNikaProviderConfig(vscode.workspace.getConfiguration('nika').get('providers'));
	}

	async provideLanguageModelChatResponse(model: NikaLanguageModelChatInformation, messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>, options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart2>, token: vscode.CancellationToken): Promise<void> {
		if (!isNikaModelId(model.id)) {
			throw new Error(vscode.l10n.t('Unknown Nika model: {0}', model.id));
		}
		if (!this._isNikaModelEnabledForRequest(model.id, this._providerConfig())) {
			throw new Error(vscode.l10n.t('The Nika model {0} is not enabled. Select it in the Providers page of Nika Settings first.', model.id));
		}
		this._warnVisionConflict(model.id);
		if (isNikaDeepSeekModel(model.id)) {
			const key = await this._context.secrets.get(NIKA_DEEPSEEK_SECRET);
			if (!key) {
				throw new Error(vscode.l10n.t('Configure a DeepSeek API key in Nika Settings before using this model.'));
			}
			// Wrap the progress reporter to track live output tokens and capture
			// the exact server-reported usage at the end of the stream.
			const trackedProgress = new TokenTrackingProgress(progress, () => this.usageTracker.notifyLiveChange());
			const disposeStream = this.usageTracker.trackStream(trackedProgress);
			const sessionId = typeof options.modelOptions?._nikaSessionId === 'string' ? options.modelOptions._nikaSessionId : undefined;
			const title = extractPromptTitle(messages);
			const workspace = currentWorkspaceName();
			try {
				const endpoint = this._createDeepSeekEndpoint(model.id, key);
				const processed = await this._attachmentProcessor.process(messages, token);
				const requestedEffort = options.modelOptions?._nikaThinkingEffort;
				const effectiveOptions = isNikaThinkingEffort(requestedEffort)
					? { ...options, modelConfiguration: { ...options.modelConfiguration, reasoningEffort: requestedEffort } }
					: options;
				for (const marker of processed.replayMarkers) { trackedProgress.report(marker); }
				await this._lmWrapper.provideLanguageModelResponse(endpoint, processed.messages, effectiveOptions, options.requestInitiator, trackedProgress, token);
				this._recordUsage(model.id, trackedProgress, { sessionId, title, workspace, initiator: options.requestInitiator });
			} catch (error) {
				this.usageTracker.record({
					model: model.id,
					sessionId,
					initiator: options.requestInitiator,
					title,
					workspace,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					reasoningTokens: 0,
					error: true,
				});
				if (model.id.endsWith('-responses') && !token.isCancellationRequested) {
					const chatModel = model.id.slice(0, -'-responses'.length);
					const chatModelLabel = chatModel === 'deepseek-v4-pro'
						? 'DeepSeek V4 Pro'
						: chatModel === 'deepseek-v4-flash-vision-exp'
							? 'DeepSeek V4 Flash Vision (Exp)'
							: 'DeepSeek V4 Flash';
					const switchAction = vscode.l10n.t('Use {0} Chat Completions', chatModelLabel);
					const selected = await vscode.window.showErrorMessage(
						vscode.l10n.t('The DeepSeek Responses request failed. Nika did not fall back automatically.'),
						switchAction,
					);
					if (selected === switchAction) {
						const qualified = `nika/${chatModel}`;
						await vscode.workspace.getConfiguration('chat').update('defaultModel', qualified, vscode.ConfigurationTarget.Global);
						await vscode.workspace.getConfiguration('nika').update('defaultModel', qualified, vscode.ConfigurationTarget.Global);
					}
				}
				throw error;
			} finally {
				disposeStream();
			}
			// Must return here: otherwise execution falls through to the Ollama
			// fallback branch below, which would fire a second request for this
			// DeepSeek model id against the local Ollama host and surface its
			// "model not found" error, masking the successful DeepSeek response.
			return;
		}

		if (isNikaGeminiModel(model.id) || isNikaGeminiCatalogModel(model.id)) {
			const key = await this._context.secrets.get(NIKA_GEMINI_SECRET);
			if (!key) {
				throw new Error(vscode.l10n.t('Configure a Gemini API key in Nika Settings before using this model.'));
			}
			// Catalog ids carry the `gemini/` group prefix; the delegate sends
			// the raw Google id (e.g. `gemini-2.5-pro`) on the wire.
			const wireId = isNikaGeminiCatalogModel(model.id)
				? model.id.slice(NIKA_GEMINI_MODEL_PREFIX.length)
				: model.id;
			const delegate: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration> = {
				...model,
				id: wireId,
				configuration: { apiKey: key },
			};
			return this._geminiProvider.provideLanguageModelChatResponse(delegate, messages, options, progress, token);
		}

		if (isNikaOpenRouterModel(model.id)) {
			const key = await this._context.secrets.get(NIKA_OPENROUTER_SECRET);
			if (!key) {
				throw new Error(vscode.l10n.t('Configure an OpenRouter API key in Nika Settings before using this model.'));
			}
			// Refresh the catalog first so endpoint capabilities and the pricing
			// snapshot (used for cost accounting) are warm.
			const catalog = await this._openRouterProvider.getCatalog(key);
			const rawId = model.id.slice(NIKA_OPENROUTER_MODEL_PREFIX.length);
			const entry = catalog.get(rawId);
			const pricing = entry?.pricing;
			const supportsReasoningEffort = entry?.capabilities.supportsReasoningEffort;

			const trackedProgress = new TokenTrackingProgress(progress, () => this.usageTracker.notifyLiveChange());
			const disposeStream = this.usageTracker.trackStream(trackedProgress);
			const sessionId = typeof options.modelOptions?._nikaSessionId === 'string' ? options.modelOptions._nikaSessionId : undefined;
			const title = extractPromptTitle(messages);
			const workspace = currentWorkspaceName();
			try {
				const endpoint = this._openRouterProvider.createEndpoint(this._openRouterWireModelId(rawId), key);
				const processed = await this._attachmentProcessor.process(messages, token);
				const requestedEffort = options.modelOptions?._nikaThinkingEffort;
				// OpenRouter models accept `low`/`medium`/`high` effort only; drop
				// agent-requested efforts the model does not support instead of
				// letting the request fail at the API.
				const effectiveOptions = isNikaThinkingEffort(requestedEffort) && supportsReasoningEffort?.includes(requestedEffort)
					? { ...options, modelConfiguration: { ...options.modelConfiguration, reasoningEffort: requestedEffort } }
					: options;
				for (const marker of processed.replayMarkers) { trackedProgress.report(marker); }
				await this._lmWrapper.provideLanguageModelResponse(endpoint, processed.messages, effectiveOptions, options.requestInitiator, trackedProgress, token);
				this._recordUsage(model.id, trackedProgress, { sessionId, title, workspace, initiator: options.requestInitiator }, pricing);
			} catch (error) {
				this.usageTracker.record({
					model: model.id,
					sessionId,
					initiator: options.requestInitiator,
					title,
					workspace,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					reasoningTokens: 0,
					provider: 'openrouter',
					pricing,
					error: true,
				});
				throw error;
			} finally {
				disposeStream();
			}
			return;
		}

		if (isNikaOpenAIModel(model.id)) {
			const key = await this._context.secrets.get(NIKA_OPENAI_SECRET);
			if (!key) {
				throw new Error(vscode.l10n.t('Configure an OpenAI API key in Nika Settings before using this model.'));
			}
			const rawId = model.id.slice(NIKA_OPENAI_MODEL_PREFIX.length);
			// Capabilities are deterministic for OpenAI ids (family heuristics),
			// so the request path never needs to fetch the catalog.
			const capabilities = this._openAIProvider.getCachedCapabilities(rawId) ?? resolveOpenAIModelCapabilities(rawId, this._limits());
			const pricing = NIKA_OPENAI_PRICES[rawId];

			const trackedProgress = new TokenTrackingProgress(progress, () => this.usageTracker.notifyLiveChange());
			const disposeStream = this.usageTracker.trackStream(trackedProgress);
			const sessionId = typeof options.modelOptions?._nikaSessionId === 'string' ? options.modelOptions._nikaSessionId : undefined;
			const title = extractPromptTitle(messages);
			const workspace = currentWorkspaceName();
			try {
				// The vision preprocessing toggle decides whether images are
				// described by the vision backend (default) or passed through
				// natively; PDFs are always converted to text.
				const processed = await this._attachmentProcessor.process(messages, token);
				const requestedEffort = options.modelOptions?._nikaThinkingEffort;
				// OpenAI models accept `low`/`medium`/`high` effort only; drop
				// agent-requested efforts the model does not support instead of
				// letting the request fail at the API.
				const effectiveOptions = isNikaThinkingEffort(requestedEffort) && capabilities.supportsReasoningEffort?.includes(requestedEffort)
					? { ...options, modelConfiguration: { ...options.modelConfiguration, reasoningEffort: requestedEffort } }
					: options;
				for (const marker of processed.replayMarkers) { trackedProgress.report(marker); }
				await this._openAIProvider.provideLanguageModelChatResponse(model, key, processed.messages, effectiveOptions, trackedProgress, token);
				this._recordUsage(model.id, trackedProgress, { sessionId, title, workspace, initiator: options.requestInitiator }, pricing);
			} catch (error) {
				this.usageTracker.record({
					model: model.id,
					sessionId,
					initiator: options.requestInitiator,
					title,
					workspace,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					reasoningTokens: 0,
					provider: 'openai',
					pricing,
					error: true,
				});
				throw error;
			} finally {
				disposeStream();
			}
			return;
		}

		if (isNikaAnthropicModel(model.id)) {
			const key = await this._context.secrets.get(NIKA_ANTHROPIC_SECRET);
			if (!key) {
				throw new Error(vscode.l10n.t('Configure an Anthropic API key in Nika Settings before using this model.'));
			}
			const rawId = model.id.slice(NIKA_ANTHROPIC_MODEL_PREFIX.length);
			const pricing = NIKA_ANTHROPIC_PRICES[rawId];

			const trackedProgress = new TokenTrackingProgress(progress, () => this.usageTracker.notifyLiveChange());
			const disposeStream = this.usageTracker.trackStream(trackedProgress);
			const sessionId = typeof options.modelOptions?._nikaSessionId === 'string' ? options.modelOptions._nikaSessionId : undefined;
			const title = extractPromptTitle(messages);
			const workspace = currentWorkspaceName();
			try {
				// The vision preprocessing toggle decides whether images
				// are described by the vision backend (default) or passed
				// through natively; PDFs are always converted to text.
				const processed = await this._attachmentProcessor.process(messages, token);
				for (const marker of processed.replayMarkers) { trackedProgress.report(marker); }
				// Claude has no reasoning-effort control (extended thinking
				// is a budget handled by the delegate), so `options` pass
				// through unchanged.
				await this._anthropicProvider.provideLanguageModelChatResponse(model, key, processed.messages, options, trackedProgress, token);
				this._recordUsage(model.id, trackedProgress, { sessionId, title, workspace, initiator: options.requestInitiator }, pricing);
			} catch (error) {
				this.usageTracker.record({
					model: model.id,
					sessionId,
					initiator: options.requestInitiator,
					title,
					workspace,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					reasoningTokens: 0,
					provider: 'anthropic',
					pricing,
					error: true,
				});
				throw error;
			} finally {
				disposeStream();
			}
			return;
		}

		if (isNikaChatGptSubModel(model.id)) {
			const subToken = await this._ensureChatGptToken();
			if (!subToken) {
				throw new Error(vscode.l10n.t('Sign in to ChatGPT in Nika Settings before using this model.'));
			}
			const rawId = model.id.slice(NIKA_CHATGPT_MODEL_PREFIX.length);
			// Capabilities are deterministic for the codex family, so the
			// request path never needs a catalog fetch.
			const capabilities = resolveChatGptSubModelCapabilities(rawId, this._limits());

			const trackedProgress = new TokenTrackingProgress(progress, () => this.usageTracker.notifyLiveChange());
			const disposeStream = this.usageTracker.trackStream(trackedProgress);
			const sessionId = typeof options.modelOptions?._nikaSessionId === 'string' ? options.modelOptions._nikaSessionId : undefined;
			const title = extractPromptTitle(messages);
			const workspace = currentWorkspaceName();
			try {
				// GPT-5 Codex accepts images natively; only PDFs are converted.
				const processed = await this._attachmentProcessor.process(messages, token, { preserveImages: true });
				const requestedEffort = options.modelOptions?._nikaThinkingEffort;
				// Codex models accept `low`..`ultra` effort; drop agent-requested
				// efforts the model does not support instead of letting the
				// request fail at the API.
				const effectiveOptions = isNikaThinkingEffort(requestedEffort) && capabilities.supportsReasoningEffort?.includes(requestedEffort)
					? { ...options, modelConfiguration: { ...options.modelConfiguration, reasoningEffort: requestedEffort } }
					: options;
				for (const marker of processed.replayMarkers) { trackedProgress.report(marker); }
				const endpoint = this._chatGptSubProvider.createEndpoint(rawId, subToken, this._limits());
				await this._lmWrapper.provideLanguageModelResponse(endpoint, processed.messages, effectiveOptions, options.requestInitiator, trackedProgress, token);
				this._recordUsage(model.id, trackedProgress, { sessionId, title, workspace, initiator: options.requestInitiator });
			} catch (error) {
				this.usageTracker.record({
					model: model.id,
					sessionId,
					initiator: options.requestInitiator,
					title,
					workspace,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					reasoningTokens: 0,
					provider: 'chatgpt',
					error: true,
				});
				throw error;
			} finally {
				disposeStream();
			}
			return;
		}

		if (isNikaClaudeSubModel(model.id)) {
			const subToken = await this._ensureClaudeToken();
			if (!subToken) {
				throw new Error(vscode.l10n.t('Sign in to Claude in Nika Settings before using this model.'));
			}
			const rawId = model.id.slice(NIKA_CLAUDE_SUB_MODEL_PREFIX.length);

			const trackedProgress = new TokenTrackingProgress(progress, () => this.usageTracker.notifyLiveChange());
			const disposeStream = this.usageTracker.trackStream(trackedProgress);
			const sessionId = typeof options.modelOptions?._nikaSessionId === 'string' ? options.modelOptions._nikaSessionId : undefined;
			const title = extractPromptTitle(messages);
			const workspace = currentWorkspaceName();
			try {
				// Claude models accept images natively; only PDFs are converted.
				const processed = await this._attachmentProcessor.process(messages, token, { preserveImages: true });
				for (const marker of processed.replayMarkers) { trackedProgress.report(marker); }
				// Claude has no reasoning-effort control (extended thinking is a
				// budget the agent host manages), so `options` pass through
				// unchanged.
				const endpoint = this._claudeSubProvider.createEndpoint(rawId, subToken, this._limits());
				await this._lmWrapper.provideLanguageModelResponse(endpoint, processed.messages, options, options.requestInitiator, trackedProgress, token);
				this._recordUsage(model.id, trackedProgress, { sessionId, title, workspace, initiator: options.requestInitiator });
			} catch (error) {
				this.usageTracker.record({
					model: model.id,
					sessionId,
					initiator: options.requestInitiator,
					title,
					workspace,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					reasoningTokens: 0,
					provider: 'claude',
					error: true,
				});
				throw error;
			} finally {
				disposeStream();
			}
			return;
		}

		if (isNikaLlamaCppModel(model.id)) {
			const baseUrl = this._llamaCppBaseUrl();
			const key = await this._context.secrets.get(NIKA_LLAMACPP_SECRET) ?? undefined;
			const rawId = model.id.slice(NIKA_LLAMACPP_MODEL_PREFIX.length);

			const trackedProgress = new TokenTrackingProgress(progress, () => this.usageTracker.notifyLiveChange());
			const disposeStream = this.usageTracker.trackStream(trackedProgress);
			const sessionId = typeof options.modelOptions?._nikaSessionId === 'string' ? options.modelOptions._nikaSessionId : undefined;
			const title = extractPromptTitle(messages);
			const workspace = currentWorkspaceName();
			try {
				const endpoint = this._llamaCppProvider.createEndpoint(rawId, baseUrl, key);
				// Native multimodal pass-through: llama.cpp models accept image
				// parts directly (as image_url data URIs), so only PDFs are
				// converted to text.
				const processed = await this._attachmentProcessor.process(messages, token, { preserveImages: true });
				for (const marker of processed.replayMarkers) { trackedProgress.report(marker); }
				await this._lmWrapper.provideLanguageModelResponse(endpoint, processed.messages, options, options.requestInitiator, trackedProgress, token);
				this._recordUsage(model.id, trackedProgress, { sessionId, title, workspace, initiator: options.requestInitiator });
			} catch (error) {
				this.usageTracker.record({
					model: model.id,
					sessionId,
					initiator: options.requestInitiator,
					title,
					workspace,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					reasoningTokens: 0,
					provider: 'llamacpp',
					error: true,
				});
				throw error;
			} finally {
				disposeStream();
			}
			return;
		}

		if (isNikaCursorModel(model.id)) {
			const key = await this._context.secrets.get(NIKA_CURSOR_SECRET);
			if (!key) {
				throw new Error(vscode.l10n.t('Configure a Cursor API key in Nika Settings before using this model.'));
			}
			const rawId = model.id.slice(NIKA_CURSOR_MODEL_PREFIX.length);

			const trackedProgress = new TokenTrackingProgress(progress, () => this.usageTracker.notifyLiveChange());
			const disposeStream = this.usageTracker.trackStream(trackedProgress);
			const sessionId = typeof options.modelOptions?._nikaSessionId === 'string' ? options.modelOptions._nikaSessionId : undefined;
			const title = extractPromptTitle(messages);
			const workspace = currentWorkspaceName();
			try {
				const endpoint = this._cursorProvider.createEndpoint(rawId, key);
				// Native multimodal pass-through: Cursor serves frontier
				// Claude/GPT/Gemini models that accept image parts directly.
				const processed = await this._attachmentProcessor.process(messages, token, { preserveImages: true });
				for (const marker of processed.replayMarkers) { trackedProgress.report(marker); }
				await this._lmWrapper.provideLanguageModelResponse(endpoint, processed.messages, options, options.requestInitiator, trackedProgress, token);
				this._recordUsage(model.id, trackedProgress, { sessionId, title, workspace, initiator: options.requestInitiator });
			} catch (error) {
				this.usageTracker.record({
					model: model.id,
					sessionId,
					initiator: options.requestInitiator,
					title,
					workspace,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					reasoningTokens: 0,
					provider: 'cursor',
					error: true,
				});
				throw error;
			} finally {
				disposeStream();
			}
			return;
		}

		if (isNikaDeepSeekWebModel(model.id)) {
			const webToken = await this._context.secrets.get(NIKA_DEEPSEEK_WEB_SECRET);
			if (!webToken) {
				throw new Error(vscode.l10n.t('Configure a DeepSeek web token in Nika Settings before using this model.'));
			}

			const trackedProgress = new TokenTrackingProgress(progress, () => this.usageTracker.notifyLiveChange());
			const disposeStream = this.usageTracker.trackStream(trackedProgress);
			const sessionId = typeof options.modelOptions?._nikaSessionId === 'string' ? options.modelOptions._nikaSessionId : undefined;
			const title = extractPromptTitle(messages);
			const workspace = currentWorkspaceName();
			try {
				const endpoint = this._deepSeekWebProvider.createEndpoint(model.id, webToken, sessionId);
				// Images ride through natively: they are uploaded to DeepSeek's
				// servers and analyzed there, so the vision backend must not
				// preprocess them into text.
				const processed = await this._attachmentProcessor.process(messages, token, { preserveImages: true });
				for (const marker of processed.replayMarkers) { trackedProgress.report(marker); }
				await this._lmWrapper.provideLanguageModelResponse(endpoint, processed.messages, options, options.requestInitiator, trackedProgress, token);
				this._recordUsage(model.id, trackedProgress, { sessionId, title, workspace, initiator: options.requestInitiator });
			} catch (error) {
				this.usageTracker.record({
					model: model.id,
					sessionId,
					initiator: options.requestInitiator,
					title,
					workspace,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					reasoningTokens: 0,
					provider: 'deepseekweb',
					error: true,
				});
				throw error;
			} finally {
				disposeStream();
			}
			return;
		}

		const url = vscode.workspace.getConfiguration('nika').get<string>('ollamaBaseUrl', 'http://localhost:11434').replace(/\/$/, '');
		const delegate: OpenAICompatibleLanguageModelChatInformation<OllamaConfig> = {
			...model,
			url,
			configuration: { url },
		};
		return this._ollamaProvider.provideLanguageModelChatResponse(delegate, messages, options, progress, token);
	}

	async provideTokenCount(model: NikaLanguageModelChatInformation, text: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2, token: vscode.CancellationToken): Promise<number> {
		if (!isNikaModelId(model.id)) {
			throw new Error(vscode.l10n.t('Unknown Nika model: {0}', model.id));
		}
		if (!this._isNikaModelEnabledForRequest(model.id, this._providerConfig())) {
			throw new Error(vscode.l10n.t('The Nika model {0} is not enabled. Select it in the Providers page of Nika Settings first.', model.id));
		}
		if (isNikaDeepSeekModel(model.id)) {
			const endpoint = this._createDeepSeekEndpoint(model.id, await this._context.secrets.get(NIKA_DEEPSEEK_SECRET) ?? '');
			return this._lmWrapper.provideTokenCount(endpoint, text);
		}
		if (isNikaGeminiModel(model.id) || isNikaGeminiCatalogModel(model.id)) {
			const wireId = isNikaGeminiCatalogModel(model.id)
				? model.id.slice(NIKA_GEMINI_MODEL_PREFIX.length)
				: model.id;
			const delegate: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration> = {
				...model,
				id: wireId,
				configuration: { apiKey: await this._context.secrets.get(NIKA_GEMINI_SECRET) ?? '' },
			};
			return this._geminiProvider.provideTokenCount(delegate, text, token);
		}
		if (isNikaOpenAIModel(model.id)) {
			return this._openAIProvider.provideTokenCount(model, await this._context.secrets.get(NIKA_OPENAI_SECRET) ?? '', text, token);
		}
		if (isNikaAnthropicModel(model.id)) {
			return this._anthropicProvider.provideTokenCount(model, await this._context.secrets.get(NIKA_ANTHROPIC_SECRET) ?? '', text, token);
		}
		if (isNikaChatGptSubModel(model.id)) {
			const subToken = await this._ensureChatGptToken();
			if (!subToken) {
				throw new Error(vscode.l10n.t('Sign in to ChatGPT in Nika Settings before using this model.'));
			}
			const endpoint = this._chatGptSubProvider.createEndpoint(model.id.slice(NIKA_CHATGPT_MODEL_PREFIX.length), subToken, this._limits());
			return this._lmWrapper.provideTokenCount(endpoint, text);
		}
		if (isNikaClaudeSubModel(model.id)) {
			const subToken = await this._ensureClaudeToken();
			if (!subToken) {
				throw new Error(vscode.l10n.t('Sign in to Claude in Nika Settings before using this model.'));
			}
			const endpoint = this._claudeSubProvider.createEndpoint(model.id.slice(NIKA_CLAUDE_SUB_MODEL_PREFIX.length), subToken, this._limits());
			return this._lmWrapper.provideTokenCount(endpoint, text);
		}
		if (isNikaOpenRouterModel(model.id)) {
			const endpoint = this._openRouterProvider.createEndpoint(this._openRouterWireModelId(model.id.slice(NIKA_OPENROUTER_MODEL_PREFIX.length)), await this._context.secrets.get(NIKA_OPENROUTER_SECRET) ?? '');
			return this._lmWrapper.provideTokenCount(endpoint, text);
		}
		if (isNikaLlamaCppModel(model.id)) {
			const endpoint = this._llamaCppProvider.createEndpoint(model.id.slice(NIKA_LLAMACPP_MODEL_PREFIX.length), this._llamaCppBaseUrl(), await this._context.secrets.get(NIKA_LLAMACPP_SECRET) ?? undefined);
			return this._lmWrapper.provideTokenCount(endpoint, text);
		}
		if (isNikaCursorModel(model.id)) {
			const endpoint = this._cursorProvider.createEndpoint(model.id.slice(NIKA_CURSOR_MODEL_PREFIX.length), await this._context.secrets.get(NIKA_CURSOR_SECRET) ?? '');
			return this._lmWrapper.provideTokenCount(endpoint, text);
		}
		if (isNikaDeepSeekWebModel(model.id)) {
			const token = await this._context.secrets.get(NIKA_DEEPSEEK_WEB_SECRET);
			if (!token) {
				throw new Error(vscode.l10n.t('Configure a DeepSeek web token in Nika Settings before using this model.'));
			}
			const endpoint = this._deepSeekWebProvider.createEndpoint(model.id, token, undefined);
			return this._lmWrapper.provideTokenCount(endpoint, text);
		}
		const url = vscode.workspace.getConfiguration('nika').get<string>('ollamaBaseUrl', 'http://localhost:11434').replace(/\/$/, '');
		return this._ollamaProvider.provideTokenCount({ ...model, url, configuration: { url } }, text, token);
	}

	private _createDeepSeekEndpoint(id: string, apiKey: string): DeepSeekEndpoint {
		// Normalize defensively: the provider is normally handed the bare model
		// id, but a provider-qualified id (`nika/...`) would break capabilities
		// resolution and leak the `-responses` suffix to the wire if it reached
		// the endpoint verbatim.
		const normalizedId = id.replace(/^nika\//, '') as NikaModelId;
		const capabilities = getNikaModelCapabilities(normalizedId, this._limits());
		const modelInfo = resolveModelInfo(normalizedId, NIKA_PROVIDER_NAME, { [normalizedId]: capabilities });
		const url = normalizedId.endsWith('-responses')
			? 'https://api.deepseek.com/responses'
			: 'https://api.deepseek.com/chat/completions';
		return this._instantiationService.createInstance(DeepSeekEndpoint, modelInfo, apiKey, url);
	}

	private _recordUsage(modelId: string, tracked: TokenTrackingProgress, meta: { sessionId?: string; title?: string; workspace?: string; initiator?: string }, pricing?: OpenRouterModelPricing): void {
		const provider = isNikaOpenRouterModel(modelId) ? 'openrouter' as const
			: isNikaLlamaCppModel(modelId) ? 'llamacpp' as const
				: isNikaOllamaModel(modelId) ? 'ollama' as const
					: isNikaCursorModel(modelId) ? 'cursor' as const
						: isNikaDeepSeekWebModel(modelId) ? 'deepseekweb' as const
							: isNikaOpenAIModel(modelId) ? 'openai' as const
								: isNikaAnthropicModel(modelId) ? 'anthropic' as const
									: isNikaChatGptSubModel(modelId) ? 'chatgpt' as const
										: isNikaClaudeSubModel(modelId) ? 'claude' as const
											: 'deepseek' as const;
		const usage = tracked.exactUsage;
		if (usage) {
			this.usageTracker.record({
				model: modelId,
				sessionId: meta.sessionId,
				initiator: meta.initiator,
				title: meta.title,
				workspace: meta.workspace,
				promptTokens: usage.prompt_tokens,
				completionTokens: usage.completion_tokens,
				totalTokens: usage.total_tokens,
				cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
				reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
				provider,
				pricing,
			});
			return;
		}
		// No server-reported usage (e.g. a stream that ended without one):
		// fall back to the live estimate so the request is still accounted for.
		const estimate = tracked.liveEstimateTokens;
		if (estimate > 0) {
			this.usageTracker.record({
				model: modelId,
				sessionId: meta.sessionId,
				initiator: meta.initiator,
				title: meta.title,
				workspace: meta.workspace,
				promptTokens: 0,
				completionTokens: estimate,
				totalTokens: estimate,
				cachedTokens: 0,
				reasoningTokens: 0,
				provider,
				pricing,
			});
		}
	}

	private _limits() {
		const config = vscode.workspace.getConfiguration('nika');
		return resolveNikaTokenLimits(
			config.get<string>('contextWindow', '128K'),
			config.get<string>('outputTokens', '8K'),
		);
	}

	/**
	 * Reads the ChatGPT subscription token, refreshing it proactively when it
	 * is close to expiry (mirroring the codex CLI's refresh window). A failed
	 * refresh logs and returns the stale token — the request may still go
	 * through, and a hard 401 surfaces as the request error. Concurrent calls
	 * share a single in-flight refresh.
	 */
	private async _ensureChatGptToken(): Promise<NikaChatGptSubscriptionToken | undefined> {
		const token = parseNikaChatGptSubscriptionToken(await this._context.secrets.get(NIKA_CHATGPT_SUB_SECRET));
		if (!token) {
			return undefined;
		}
		const expiresAt = token.expiresAt;
		if (expiresAt === undefined || expiresAt - Date.now() > SUB_TOKEN_REFRESH_WINDOW_MS) {
			return token;
		}
		if (!this._chatGptRefresh) {
			this._chatGptRefresh = this._refreshChatGptToken(token).finally(() => { this._chatGptRefresh = undefined; });
		}
		return this._chatGptRefresh;
	}

	private async _refreshChatGptToken(current: NikaChatGptSubscriptionToken): Promise<NikaChatGptSubscriptionToken | undefined> {
		try {
			const refreshed = await this._chatGptSubProvider.refreshToken(current);
			await this._context.secrets.store(NIKA_CHATGPT_SUB_SECRET, JSON.stringify(refreshed));
			return refreshed;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[Nika] ChatGPT token refresh failed: ${detail}`);
			return current;
		}
	}

	/**
	 * Reads the Claude subscription token, refreshing it proactively when it
	 * is close to expiry. A failed refresh logs and returns the stale token;
	 * concurrent calls share a single in-flight refresh.
	 */
	private async _ensureClaudeToken(): Promise<NikaClaudeSubscriptionToken | undefined> {
		const token = parseNikaClaudeSubscriptionToken(await this._context.secrets.get(NIKA_CLAUDE_SUB_SECRET));
		if (!token) {
			return undefined;
		}
		const expiresAt = token.expiresAt;
		if (expiresAt === undefined || expiresAt - Date.now() > SUB_TOKEN_REFRESH_WINDOW_MS) {
			return token;
		}
		if (!this._claudeRefresh) {
			this._claudeRefresh = this._refreshClaudeToken(token).finally(() => { this._claudeRefresh = undefined; });
		}
		return this._claudeRefresh;
	}

	private async _refreshClaudeToken(current: NikaClaudeSubscriptionToken): Promise<NikaClaudeSubscriptionToken | undefined> {
		try {
			const refreshed = await this._claudeSubProvider.refreshToken(current);
			await this._context.secrets.store(NIKA_CLAUDE_SUB_SECRET, JSON.stringify(refreshed));
			return refreshed;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[Nika] Claude token refresh failed: ${detail}`);
			return current;
		}
	}

	/**
	 * Set of `modelId:on|off` keys for which the vision-conflict warning has
	 * already been shown, so a user is not nagged on every request.
	 */
	private readonly _visionWarningsShown = new Set<string>();

	/**
	 * Warn once per (model, toggle-state) when the master
	 * `nika.visionPreprocessingEnabled` toggle conflicts with the model's
	 * image handling:
	 * - Toggle ON + a natively vision-capable model routed through the
	 *   describe path (the DeepSeek vision model, vision-capable OpenRouter /
	 *   OpenAI / Anthropic models): images will be described by the vision
	 *   backend instead of sent natively.
	 * - Toggle OFF + a text-only model (text-only DeepSeek, OpenRouter,
	 *   OpenAI, Anthropic models): the model may reject raw image parts.
	 * The warning offers an action that flips the toggle directly, plus one
	 * that opens Nika Settings on the Vision page. Only the models affected
	 * by the toggle are considered (models that always pass images through
	 * natively are skipped entirely).
	 */
	private _warnVisionConflict(modelId: string): void {
		const config = vscode.workspace.getConfiguration('nika');
		const enabled = config.get<boolean>('visionPreprocessingEnabled', true);
		const key = `${modelId}:${enabled ? 'on' : 'off'}`;
		if (this._visionWarningsShown.has(key)) {
			return;
		}
		this._visionWarningsShown.add(key);

		let nativeVision: boolean | undefined;
		if (isNikaDeepSeekModel(modelId)) {
			// Only the vision model sees images natively; the text-only
			// DeepSeek models advertise media input only so Copilot preserves
			// attachments for Nika's text conversion.
			nativeVision = isNikaDeepSeekVisionModel(modelId);
		} else if (isNikaOpenRouterModel(modelId)) {
			// Consult the cached catalog only: fetching here would add latency
			// to the request path, and the request branch fetches it anyway.
			nativeVision = this._openRouterProvider.getCachedCapabilities(modelId.slice(NIKA_OPENROUTER_MODEL_PREFIX.length))?.vision ?? undefined;
		} else if (isNikaOpenAIModel(modelId)) {
			// OpenAI capabilities are deterministic (family heuristics); the
			// cached catalog is preferred when warm, the heuristic otherwise.
			const rawId = modelId.slice(NIKA_OPENAI_MODEL_PREFIX.length);
			nativeVision = this._openAIProvider.getCachedCapabilities(rawId)?.vision ?? resolveOpenAIModelCapabilities(rawId, this._limits()).vision;
		} else if (isNikaAnthropicModel(modelId)) {
			// Anthropic capabilities are deterministic (family heuristics); the
			// cached catalog is preferred when warm, the heuristic otherwise.
			const rawId = modelId.slice(NIKA_ANTHROPIC_MODEL_PREFIX.length);
			nativeVision = this._anthropicProvider.getCachedCapabilities(rawId)?.vision ?? resolveAnthropicModelCapabilities(rawId, this._limits()).vision;
		}
		// Unknown capability (catalog not fetched yet) or a model that always
		// preserves images natively: nothing to warn about.
		if (nativeVision === undefined) {
			return;
		}

		const openVisionAction = vscode.l10n.t('Open Vision Settings');
		const flipToggle = async (value: boolean): Promise<void> => {
			await vscode.workspace.getConfiguration('nika').update('visionPreprocessingEnabled', value, vscode.ConfigurationTarget.Global);
		};
		if (enabled && nativeVision) {
			const turnOffAction = vscode.l10n.t('Turn preprocessing off');
			void vscode.window.showWarningMessage(
				vscode.l10n.t('Vision preprocessing is on, so images sent to {0} are described by the vision backend first — even though this model supports them natively.', modelId),
				turnOffAction,
				openVisionAction,
			).then(async action => {
				if (action === turnOffAction) {
					await flipToggle(false);
				} else if (action === openVisionAction) {
					this.settingsEditor.open('vision');
				}
			});
		} else if (!enabled && !nativeVision) {
			const turnOnAction = vscode.l10n.t('Turn preprocessing on');
			void vscode.window.showWarningMessage(
				vscode.l10n.t('Vision preprocessing is off, and {0} is a text-only model — it may not support image attachments.', modelId),
				turnOnAction,
				openVisionAction,
			).then(async action => {
				if (action === turnOnAction) {
					await flipToggle(true);
				} else if (action === openVisionAction) {
					this.settingsEditor.open('vision');
				}
			});
		}
	}

	private _geminiKnownModels(): BYOKKnownModels {
		const limits = this._limits();
		return Object.fromEntries(NIKA_GEMINI_MODEL_IDS.map(id => [id, getNikaModelCapabilities(id, limits)]));
	}

	private _gemmaKnownModels(): BYOKKnownModels {
		return { [NIKA_GEMMA_MODEL_ID]: getNikaModelCapabilities(NIKA_GEMMA_MODEL_ID, this._limits()) };
	}

	private _tooltipFor(id: string): string {
		if (id.endsWith('-responses')) {
			return vscode.l10n.t('DeepSeek Responses API model. It never falls back silently to Chat Completions.');
		}
		if (isNikaDeepSeekVisionModel(id)) {
			return vscode.l10n.t('DeepSeek V4 Flash Vision (Exp) with native image input through the Nika provider. Images are sent directly when vision preprocessing is off; PDFs are always converted to text.');
		}
		if (isNikaDeepSeekModel(id)) {
			return vscode.l10n.t('DeepSeek V4 through the native Nika provider. Images and PDFs are converted to text first.');
		}
		if (isNikaGeminiModel(id) || isNikaGeminiCatalogModel(id)) {
			return vscode.l10n.t('Native Gemini model with image and document input.');
		}
		if (isNikaOpenRouterModel(id)) {
			return vscode.l10n.t('OpenRouter model with catalog pricing.');
		}
		if (isNikaLlamaCppModel(id)) {
			return vscode.l10n.t('Model served by the configured llama.cpp server with native image input.');
		}
		if (isNikaOllamaModel(id)) {
			return vscode.l10n.t('Model served by the configured Ollama host with native image input.');
		}
		if (isNikaCursorModel(id)) {
			return vscode.l10n.t('Model served by the Cursor API with native image input.');
		}
		if (isNikaDeepSeekWebModel(id)) {
			return this._deepSeekWebTooltip();
		}
		if (isNikaChatGptSubModel(id)) {
			return this._chatGptSubTooltip(id.slice(NIKA_CHATGPT_MODEL_PREFIX.length));
		}
		if (isNikaClaudeSubModel(id)) {
			return this._claudeSubTooltip(id.slice(NIKA_CLAUDE_SUB_MODEL_PREFIX.length));
		}
		return vscode.l10n.t('Gemma 4 31B through the configured Ollama host.');
	}

	private _deepSeekWebTooltip(): string {
		return vscode.l10n.t('DeepSeek Chat through the unofficial web API (chat.deepseek.com). Images are uploaded and analyzed natively.');
	}
}

/**
 * Extract a short title (first user text) from the message list, used to label
 * a token-usage session in the Nika Settings dashboard.
 */
function extractPromptTitle(messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const content = (messages[i] as { content?: string | unknown[] }).content;
		if (typeof content === 'string' && content.trim()) {
			return content.trim().slice(0, 80);
		}
		if (Array.isArray(content)) {
			for (const part of content) {
				if (part instanceof vscode.LanguageModelTextPart && part.value.trim()) {
					return part.value.trim().slice(0, 80);
				}
			}
		}
	}
	return undefined;
}

/**
 * Best-effort current workspace folder name for token-usage attribution.
 * Falls back to the folder of the active text editor, then to `undefined`.
 */
function currentWorkspaceName(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (folders && folders.length > 0) {
		return folders[0].name;
	}
	const editor = vscode.window.activeTextEditor;
	if (editor && editor.document.uri.scheme === 'file') {
		const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
		return relative.split(/[\\/]/)[0];
	}
	return undefined;
}
