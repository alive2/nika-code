/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IIndexingSchemeManager } from '../../../platform/workspaceChunkSearch/common/indexingScheme';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { getNikaEffortOptionsForModel, getNikaModelCapabilities, getNikaModelProvider, getNikaSelectedModels, getVisibleNikaModelIds, isNikaThinkingEffort, NIKA_AGENT_DEFAULTS, NIKA_CURSOR_MODEL_PREFIX, NIKA_CURSOR_SECRET, NIKA_DEEPSEEK_MODEL_IDS, NIKA_DEEPSEEK_SECRET, NIKA_DEEPSEEK_WEB_SECRET, NIKA_GEMINI_MODEL_IDS, NIKA_GEMINI_MODEL_PREFIX, NIKA_GEMINI_SECRET, NIKA_GEMMA_MODEL_ID, NIKA_LLAMACPP_MODEL_PREFIX, NIKA_LLAMACPP_SECRET, NIKA_OLLAMA_MODEL_PREFIX, NIKA_OPENROUTER_MODEL_PREFIX, NIKA_OPENROUTER_SECRET, NIKA_RESPONSES_MODEL, NikaModelId, NikaProviderConfig, NikaProviderId, parseNikaProviderConfig, resolveNikaTokenLimits } from './nikaModels';
import { formatOpenRouterPriceLabel, getDeepSeekRatePeriod, isDeepSeekPeakHour } from './nikaPricing';
import { NikaOpenRouterProvider, nikaOpenRouterModelId } from './nikaOpenRouterProvider';
import { LLAMACPP_DEFAULT_CONTEXT_WINDOW, NikaLlamaCppProvider } from './nikaLlamaCppProvider';
import { NikaCursorProvider } from './nikaCursorProvider';
import { NikaGeminiProvider } from './nikaGeminiProvider';
import { NikaDeepSeekWebProvider } from './nikaDeepSeekWebProvider';
import { DeepSeekWebClient } from '../node/deepSeekWebClient';
import { NikaUsageTracker } from './nikaUsageTracker';

type NikaConnection = NikaProviderId;
type NikaSettingsSection = 'overview' | 'providers' | 'models' | 'vision' | 'pdf' | 'agents' | 'indexing' | 'usage' | 'diagnostics';
type ConnectionResult = { readonly ok: boolean; readonly message: string; readonly checkedAt: string };

const SETTINGS = new Set([
	'defaultModel', 'outputTokens', 'contextWindow', 'temperature', 'thinkingEffort', 'openrouterFloor',
	'visionModel', 'visionVSCodeModel', 'visionOpenRouterModel', 'ollamaBaseUrl', 'llamaCppBaseUrl',
	'pdfMaxFileSizeMB', 'pdfMaxPages', 'pdfPageNotice', 'pdfSparseFallback', 'pdfSparseThreshold',
	'agent.plan', 'agent.explore', 'agent.utility', 'agent.utilitySmall', 'agent.inlineChat',
	'agent.planThinkingEffort', 'agent.exploreThinkingEffort', 'agent.utilityThinkingEffort', 'agent.utilitySmallThinkingEffort', 'agent.inlineChatThinkingEffort',
	'logLevel', 'releaseCheckEnabled', 'safetyRules.enabled', 'github.enabled', 'indexing.scheme', 'usage.enabled',
]);

const DEEP_SEEK_WEB_URL = 'https://chat.deepseek.com/';

const SECRET_KEYS: Record<'deepseek' | 'gemini' | 'openrouter' | 'llamacpp' | 'cursor' | 'deepseekweb', string> = {
	deepseek: NIKA_DEEPSEEK_SECRET,
	gemini: NIKA_GEMINI_SECRET,
	openrouter: NIKA_OPENROUTER_SECRET,
	llamacpp: NIKA_LLAMACPP_SECRET,
	cursor: NIKA_CURSOR_SECRET,
	deepseekweb: NIKA_DEEPSEEK_WEB_SECRET,
};

function providerDisplayName(provider: NikaConnection): string {
	switch (provider) {
		case 'deepseek': return 'DeepSeek';
		case 'gemini': return 'Gemini';
		case 'ollama': return 'Ollama';
		case 'openrouter': return 'OpenRouter';
		case 'llamacpp': return 'llama.cpp';
		case 'cursor': return 'Cursor';
		case 'deepseekweb': return 'DeepSeek Web';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNikaSettingsSection(value: unknown): value is NikaSettingsSection {
	return value === 'overview' || value === 'providers' || value === 'models' || value === 'vision' || value === 'pdf' || value === 'agents' || value === 'indexing' || value === 'usage' || value === 'diagnostics';
}

function nonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 32; i++) {
		result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return result;
}

function normalizeVersion(version: string): number[] {
	return version.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(value => Number.parseInt(value, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
	const left = normalizeVersion(a);
	const right = normalizeVersion(b);
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) {
			return left[i] > right[i] ? 1 : -1;
		}
	}
	return 0;
}

export class NikaSettingsEditor extends Disposable {
	private _panel: vscode.WebviewPanel | undefined;
	private _activeSection: NikaSettingsSection = 'overview';
	private _deepSeekKey: string | undefined;
	private _geminiKey: string | undefined;
	private readonly _output = this._register(vscode.window.createOutputChannel(vscode.l10n.t('Nika')));
	private readonly _connections = new Map<NikaConnection, ConnectionResult>();

	constructor(
		private readonly _usageTracker: NikaUsageTracker,
		private readonly _openRouterProvider: NikaOpenRouterProvider,
		private readonly _llamaCppProvider: NikaLlamaCppProvider,
		private readonly _geminiCatalogProvider: NikaGeminiProvider,
		private readonly _cursorProvider: NikaCursorProvider,
		private readonly _deepSeekWebProvider: NikaDeepSeekWebProvider,
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IIndexingSchemeManager private readonly _indexingSchemeManager: IIndexingSchemeManager,
	) {
		super();
		this._register(vscode.commands.registerCommand('nika.openSettings', () => this.open()));
		this._register(vscode.commands.registerCommand('nika.checkForUpdates', () => this.checkForUpdates(true)));
		this._register(vscode.commands.registerCommand('nika.openLogs', () => this._output.show(true)));
		this._register(vscode.commands.registerCommand('nika.exportDiagnostics', () => this.exportDiagnostics()));
		this._register(vscode.commands.registerCommand('nika.deepseekWeb.signIn', () => this._deepSeekWebSignIn()));
		this._register(vscode.commands.registerCommand('nika.deepseekWeb.importToken', () => this._deepSeekWebImportToken()));
		this._register(this._indexingSchemeManager.onDidChangeState(() => {
			void this._render(this._activeSection);
		}));
		this._register(this._usageTracker.onDidChange(() => {
			if (this._activeSection === 'usage') {
				void this._render(this._activeSection);
			}
		}));
		this._register(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('nika')) {
				void this._render(this._activeSection);
			}
		}));
		this._register(this._context.secrets.onDidChange(event => {
			if (event.key === NIKA_DEEPSEEK_SECRET || event.key === NIKA_GEMINI_SECRET || event.key === NIKA_OPENROUTER_SECRET || event.key === NIKA_LLAMACPP_SECRET || event.key === NIKA_CURSOR_SECRET || event.key === NIKA_DEEPSEEK_WEB_SECRET) {
				void this._render(this._activeSection);
			}
		}));
		void this._initialize();
	}

	private async _initialize(): Promise<void> {
		await this._migrateLegacyModelSetting();
		await this._migrateAgentDefaults();
		await this._warnAboutExternalExtension();

		if (!this._context.globalState.get<boolean>('nika.firstRunPromptShown')) {
			await this._context.globalState.update('nika.firstRunPromptShown', true);
			const [deepseekKey, geminiKey, openRouterKey, cursorKey] = await Promise.all([
				this._context.secrets.get(NIKA_DEEPSEEK_SECRET),
				this._context.secrets.get(NIKA_GEMINI_SECRET),
				this._context.secrets.get(NIKA_OPENROUTER_SECRET),
				this._context.secrets.get(NIKA_CURSOR_SECRET),
			]);
			if (!deepseekKey && !geminiKey && !openRouterKey && !cursorKey) {
				this.open('providers');
				void vscode.window.showInformationMessage(vscode.l10n.t('Welcome to NikaCode. Nika Settings is open: add and test a DeepSeek key to start chatting. Gemini and OpenRouter keys are optional for more models and vision features.'));
			} else {
				void vscode.window.showInformationMessage(vscode.l10n.t('Nika is ready to use. Open Nika Settings at any time to manage providers, models, vision, and PDF features.'));
			}
		}

		if (vscode.workspace.getConfiguration('nika').get<boolean>('releaseCheckEnabled', true)) {
			void this.checkForUpdates(false);
		}
	}

	private async _migrateAgentDefaults(): Promise<void> {
		if (this._context.globalState.get<number>('nika.agentDefaultsVersion', 0) >= 2) {
			return;
		}

		const config = vscode.workspace.getConfiguration('nika');
		const legacyModels: Record<keyof typeof NIKA_AGENT_DEFAULTS, string> = {
			plan: 'nika/deepseek-v4-pro',
			explore: 'nika/deepseek-v4-flash',
			utility: 'nika/deepseek-v4-flash',
			utilitySmall: 'nika/gemini-2.5-flash-lite',
			inlineChat: 'nika/deepseek-v4-flash',
		};
		for (const [role, defaults] of Object.entries(NIKA_AGENT_DEFAULTS) as Array<[keyof typeof NIKA_AGENT_DEFAULTS, (typeof NIKA_AGENT_DEFAULTS)[keyof typeof NIKA_AGENT_DEFAULTS]]>) {
			const modelKey = `agent.${role}`;
			const currentModel = config.inspect<string>(modelKey)?.globalValue;
			if (currentModel === undefined || currentModel === legacyModels[role]) {
				await config.update(modelKey, defaults.model, vscode.ConfigurationTarget.Global);
			}
			const effortKey = `agent.${role}ThinkingEffort`;
			if (config.inspect<string>(effortKey)?.globalValue === undefined) {
				await config.update(effortKey, defaults.effort, vscode.ConfigurationTarget.Global);
			}
		}

		const currentDefaultModel = config.inspect<string>('defaultModel')?.globalValue;
		if (currentDefaultModel === undefined || currentDefaultModel === 'nika/deepseek-v4-flash') {
			await config.update('defaultModel', NIKA_RESPONSES_MODEL, vscode.ConfigurationTarget.Global);
		}
		const chatDefaultModel = vscode.workspace.getConfiguration('chat').inspect<string>('defaultModel')?.globalValue;
		if (chatDefaultModel === undefined || chatDefaultModel === 'nika/deepseek-v4-flash') {
			await vscode.workspace.getConfiguration('chat').update('defaultModel', NIKA_RESPONSES_MODEL, vscode.ConfigurationTarget.Global);
		}
		const assignments = Object.fromEntries(Object.keys(NIKA_AGENT_DEFAULTS).flatMap(role => [
			[`agent.${role}`, config.get<string>(`agent.${role}`, NIKA_RESPONSES_MODEL)],
			[`agent.${role}ThinkingEffort`, config.get<string>(`agent.${role}ThinkingEffort`, NIKA_AGENT_DEFAULTS[role as keyof typeof NIKA_AGENT_DEFAULTS].effort)],
		])) as Record<string, string>;
		await this._applyNativeAgentMappings(assignments);
		await this._context.globalState.update('nika.agentDefaultsVersion', 2);
		this.log('INFO', vscode.l10n.t('Migrated Nika agent defaults to DeepSeek V4 Flash Responses.'));
	}

	private async _migrateLegacyModelSetting(): Promise<void> {
		const nikaConfig = vscode.workspace.getConfiguration('nika');
		const legacy = nikaConfig.get<string>('selectedModel');
		if (!legacy) {
			return;
		}
		const defaultModel = vscode.workspace.getConfiguration('chat').inspect<string>('defaultModel');
		if (defaultModel?.globalValue === undefined) {
			const qualified = legacy.startsWith('nika/') ? legacy : `nika/${legacy}`;
			await vscode.workspace.getConfiguration('chat').update('defaultModel', qualified, vscode.ConfigurationTarget.Global);
		}
		await nikaConfig.update('selectedModel', undefined, vscode.ConfigurationTarget.Global);
		this.log('INFO', vscode.l10n.t('Migrated nika.selectedModel to chat.defaultModel.'));
	}

	private async _warnAboutExternalExtension(): Promise<void> {
		if (!vscode.extensions.getExtension('nika.nika') || this._context.globalState.get<boolean>('nika.externalExtensionWarningShown')) {
			return;
		}
		await this._context.globalState.update('nika.externalExtensionWarningShown', true);
		const open = vscode.l10n.t('Open Extension');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('The external Nika extension conflicts with the built-in Nika provider. Disable or uninstall it, then re-enter its keys in Nika Settings.'),
			open,
		);
		if (choice === open) {
			await vscode.commands.executeCommand('workbench.extensions.search', '@id:nika.nika');
		}
	}

	open(initialSection?: NikaSettingsSection): void {
		if (this._panel) {
			this._panel.reveal(vscode.ViewColumn.Active);
			if (initialSection) {
				void this._render(initialSection);
			}
			return;
		}
		this._activeSection = initialSection ?? this._activeSection;
		this._panel = vscode.window.createWebviewPanel(
			'nika.settings',
			vscode.l10n.t('Nika Settings'),
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this._register(this._panel.webview.onDidReceiveMessage(message => this._onMessage(message)));
		this._panel.onDidDispose(() => { this._panel = undefined; });
		void this._render(this._activeSection);
	}

	private async _render(initialSection: NikaSettingsSection = this._activeSection): Promise<void> {
		if (!this._panel) {
			return;
		}
		this._activeSection = initialSection;
		const state = { ...await this._state(), initialSection };
		this._panel.webview.html = this._html(this._panel.webview, state);
	}

	private async _state(): Promise<Record<string, unknown>> {
		const config = vscode.workspace.getConfiguration('nika');
		const [deepseekKey, geminiKey, openRouterKey, llamaCppKey, cursorKey, deepSeekWebToken] = await Promise.all([
			this._context.secrets.get(NIKA_DEEPSEEK_SECRET),
			this._context.secrets.get(NIKA_GEMINI_SECRET),
			this._context.secrets.get(NIKA_OPENROUTER_SECRET),
			this._context.secrets.get(NIKA_LLAMACPP_SECRET),
			this._context.secrets.get(NIKA_CURSOR_SECRET),
			this._context.secrets.get(NIKA_DEEPSEEK_WEB_SECRET),
		]);
		// Cache the key presence so view-model helpers (modelChoices) can gate
		// model visibility without re-reading secrets for every dropdown.
		this._deepSeekKey = deepseekKey;
		this._geminiKey = geminiKey;
		const value = <T>(key: string, fallback: T): T => config.get<T>(key, fallback);
		const openRouterCatalog = openRouterKey ? await this._openRouterCatalogState(openRouterKey) : [];
		const llamaCppBaseUrl = this._llamaCppBaseUrl();
		const llamaCppCatalog = llamaCppBaseUrl ? await this._llamaCppCatalogState(llamaCppBaseUrl, llamaCppKey ?? undefined) : [];
		const ollamaCatalog = await this._ollamaCatalogState(value('ollamaBaseUrl', 'http://localhost:11434'));
		const geminiCatalog = geminiKey ? await this._geminiCatalogState(geminiKey) : [];
		const cursorCatalog = cursorKey ? await this._cursorCatalogState(cursorKey) : [];
		// Wizard-driven provider selection. Absent = legacy mode (classic
		// key-based visibility); present = managed mode (only the selected
		// models of added providers are visible anywhere).
		const providers = parseNikaProviderConfig(config.get('providers'));
		const providersManaged = providers !== undefined;
		const limits = resolveNikaTokenLimits(
			config.get<string>('contextWindow', '128K'),
			config.get<string>('outputTokens', '8K'),
		);
		const nativeModelEntry = (id: NikaModelId, provider: NikaProviderId): Record<string, unknown> => {
			const capabilities = getNikaModelCapabilities(id, limits);
			return {
				id,
				name: capabilities.name,
				provider,
				vision: capabilities.vision ?? false,
				toolCalling: capabilities.toolCalling ?? false,
				reasoning: (capabilities.supportsReasoningEffort?.length ?? 0) > 0,
				efforts: getNikaEffortOptionsForModel(id),
			};
		};
		// Wizard entries must carry the full exposed id (with the provider
		// prefix for catalog families) because `_saveProviderConfig` persists
		// them verbatim and the chat picker gates on the prefixed form.
		const prefixCatalog = (catalog: unknown[], prefix: string): Record<string, unknown>[] =>
			(catalog as { id: string }[]).map(model => ({ ...model, id: `${prefix}${model.id}` }));
		return {
			deepseekConfigured: !!deepseekKey,
			geminiConfigured: !!geminiKey,
			openrouterConfigured: !!openRouterKey,
			openrouterModels: openRouterCatalog,
			llamacppConfigured: !!llamaCppKey,
			llamacppModels: llamaCppCatalog,
			cursorConfigured: !!cursorKey,
			deepseekwebConfigured: !!deepSeekWebToken,
			providers,
			providersManaged,
			// Per-provider configured flag for status pills. Legacy mode keeps
			// the classic rules; managed mode reflects the added providers.
			providersConfigured: providersManaged
				? { deepseek: !!providers.deepseek, gemini: !!providers.gemini, ollama: !!providers.ollama, openrouter: !!providers.openrouter, llamacpp: !!providers.llamacpp, cursor: !!providers.cursor, deepseekweb: !!providers.deepseekweb }
				: { deepseek: !!deepseekKey, gemini: !!geminiKey, ollama: true, openrouter: !!openRouterKey, llamacpp: !!llamaCppBaseUrl, cursor: !!cursorKey, deepseekweb: !!deepSeekWebToken },
			// Available models per provider for the wizard's selection step.
			// Native entries are bare ids; catalog families carry their prefix
			// so the wizard stores exactly what the picker gates on.
			providerModels: {
				deepseek: NIKA_DEEPSEEK_MODEL_IDS.map(id => nativeModelEntry(id, 'deepseek')),
				gemini: [
					...NIKA_GEMINI_MODEL_IDS.map(id => nativeModelEntry(id, 'gemini')),
					// The catalog excludes the native lineup (see
					// `_geminiCatalogState`), so no dedup is needed here.
					...prefixCatalog(geminiCatalog, NIKA_GEMINI_MODEL_PREFIX),
				],
				ollama: prefixCatalog(ollamaCatalog, NIKA_OLLAMA_MODEL_PREFIX),
				openrouter: prefixCatalog(openRouterCatalog, NIKA_OPENROUTER_MODEL_PREFIX),
				llamacpp: prefixCatalog(llamaCppCatalog, NIKA_LLAMACPP_MODEL_PREFIX),
				cursor: prefixCatalog(cursorCatalog, NIKA_CURSOR_MODEL_PREFIX),
				// The web model ids already carry their `deepseekweb/` prefix
				// (see NikaDeepSeekWebProvider.getKnownModels), so they persist
				// verbatim — exactly what the picker gates on.
				deepseekweb: Object.entries(this._deepSeekWebProvider.getKnownModels()).map(([id, capabilities]) => ({
					id,
					name: capabilities.name,
					provider: 'deepseekweb',
					vision: capabilities.vision ?? false,
					toolCalling: capabilities.toolCalling ?? false,
					reasoning: (capabilities.supportsReasoningEffort?.length ?? 0) > 0,
					efforts: getNikaEffortOptionsForModel(id),
				})),
			},
			// Flattened, selection-gated model list for the Models / Agents /
			// Vision dropdowns (native + Ollama + OpenRouter + llama.cpp +
			// Gemini catalog + Cursor).
			modelChoices: await this._modelChoicesState(config, openRouterCatalog, llamaCppCatalog, ollamaCatalog, geminiCatalog, cursorCatalog, providers),
			hasOllama: true,
			ollamaBaseUrl: value('ollamaBaseUrl', 'http://localhost:11434'),
			llamaCppBaseUrl,
			appVersion: vscode.version,
			extensionVersion: String((this._context.extension.packageJSON as { version?: string }).version ?? 'unknown'),
			connections: Object.fromEntries(this._connections),
			settings: {
				defaultModel: value('defaultModel', NIKA_RESPONSES_MODEL),
				outputTokens: value('outputTokens', '8K'),
				contextWindow: value('contextWindow', '128K'),
				temperature: value('temperature', 0.7),
				thinkingEffort: value('thinkingEffort', 'high'),
				openrouterFloor: value('openrouterFloor', false),
				visionModel: value('visionModel', 'gemini-2.5-flash'),
				visionVSCodeModel: value('visionVSCodeModel', ''),
				visionOpenRouterModel: value('visionOpenRouterModel', ''),
				ollamaBaseUrl: value('ollamaBaseUrl', 'http://localhost:11434'),
				pdfMaxFileSizeMB: value('pdfMaxFileSizeMB', 100),
				pdfMaxPages: value('pdfMaxPages', 60),
				pdfPageNotice: value('pdfPageNotice', true),
				pdfSparseFallback: value('pdfSparseFallback', true),
				pdfSparseThreshold: value('pdfSparseThreshold', 3000),
				'agent.plan': value('agent.plan', NIKA_AGENT_DEFAULTS.plan.model),
				'agent.explore': value('agent.explore', NIKA_AGENT_DEFAULTS.explore.model),
				'agent.utility': value('agent.utility', NIKA_AGENT_DEFAULTS.utility.model),
				'agent.utilitySmall': value('agent.utilitySmall', NIKA_AGENT_DEFAULTS.utilitySmall.model),
				'agent.inlineChat': value('agent.inlineChat', NIKA_AGENT_DEFAULTS.inlineChat.model),
				'agent.planThinkingEffort': value('agent.planThinkingEffort', NIKA_AGENT_DEFAULTS.plan.effort),
				'agent.exploreThinkingEffort': value('agent.exploreThinkingEffort', NIKA_AGENT_DEFAULTS.explore.effort),
				'agent.utilityThinkingEffort': value('agent.utilityThinkingEffort', NIKA_AGENT_DEFAULTS.utility.effort),
				'agent.utilitySmallThinkingEffort': value('agent.utilitySmallThinkingEffort', NIKA_AGENT_DEFAULTS.utilitySmall.effort),
				'agent.inlineChatThinkingEffort': value('agent.inlineChatThinkingEffort', NIKA_AGENT_DEFAULTS.inlineChat.effort),
				logLevel: value('logLevel', 'INFO'),
				releaseCheckEnabled: value('releaseCheckEnabled', true),
				'safetyRules.enabled': value('safetyRules.enabled', true),
				'github.enabled': value('github.enabled', false),
				'indexing.scheme': value('indexing.scheme', 'off'),
				'usage.enabled': value('usage.enabled', true),
			},
			indexing: {
				workspaceOverride: config.inspect<string>('indexing.scheme')?.workspaceValue !== undefined,
				...(await this._indexingState()),
			},
			usage: this._usageState(),
		};
	}

	/**
	 * Serialized OpenRouter catalog for the Models section. The webview CSP
	 * forbids fetch calls, so the catalog travels through state. A catalog
	 * failure (e.g. offline) degrades to an empty list rather than breaking
	 * the whole settings page.
	 */
	private async _openRouterCatalogState(apiKey: string): Promise<unknown[]> {
		try {
			const catalog = await this._openRouterProvider.getCatalog(apiKey);
			return [...catalog.values()].map(model => ({
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				vision: model.capabilities.vision,
				toolCalling: model.capabilities.toolCalling,
				reasoning: (model.capabilities.supportsReasoningEffort?.length ?? 0) > 0,
				// Per-model reasoning-effort levels from the catalog (e.g.
				// `['low','medium','high']`); empty when the model has none.
				efforts: model.capabilities.supportsReasoningEffort ?? [],
				provider: 'openrouter',
				// The vendor segment of the catalog id (e.g. `anthropic`).
				vendor: model.id.split('/')[0] ?? '',
				priceLabel: model.pricing ? formatOpenRouterPriceLabel(model.pricing) : '',
				free: !!model.pricing?.free,
			}));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.log('WARN', vscode.l10n.t('OpenRouter catalog unavailable: {0}', detail));
			return [];
		}
	}

	/**
	 * Serialized llama.cpp model list for the Models section. Mirrors
	 * {@link _openRouterCatalogState}: the list travels through state because
	 * the webview CSP forbids fetch calls. A server that is unreachable (or
	 * has no loaded models) degrades to an empty list rather than breaking
	 * the whole settings page.
	 */
	private async _llamaCppCatalogState(baseUrl: string, apiKey: string | undefined): Promise<unknown[]> {
		try {
			const catalog = await this._llamaCppProvider.getCatalog(baseUrl, apiKey);
			return [...catalog.values()].map(model => ({
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				vision: model.capabilities.vision,
				toolCalling: model.capabilities.toolCalling,
				reasoning: (model.capabilities.supportsReasoningEffort?.length ?? 0) > 0,
				// llama.cpp models have no reasoning-effort control.
				efforts: [],
				provider: 'llamacpp',
				// Local inference is free: no price label.
				priceLabel: '',
				free: true,
			}));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.log('WARN', vscode.l10n.t('llama.cpp model list unavailable: {0}', detail));
			return [];
		}
	}

	/**
	 * Serialized Ollama model list for the wizard and the Models section.
	 * Mirrors {@link _openRouterCatalogState}: the list travels through state
	 * because the webview CSP forbids fetch calls. A host that is unreachable
	 * (or has no pulled models) degrades to an empty list rather than
	 * breaking the whole settings page.
	 */
	private async _ollamaCatalogState(baseUrl: string): Promise<unknown[]> {
		try {
			const response = await this._fetcherService.fetch(`${baseUrl}/api/tags`, { method: 'GET', callSite: 'nika-ollama-tags' });
			if (!response.ok) {
				throw new Error(vscode.l10n.t('The Ollama host returned HTTP {0}.', response.status));
			}
			const body = await response.json() as { models?: unknown[] };
			const entries: unknown[] = (body.models ?? []).map(entry => {
				if (!entry || typeof entry !== 'object') {
					return undefined;
				}
				const name = String((entry as { name?: unknown }).name ?? '').trim();
				if (!name) {
					return undefined;
				}
				return {
					id: name,
					name,
					contextWindow: LLAMACPP_DEFAULT_CONTEXT_WINDOW,
					vision: true,
					toolCalling: true,
					reasoning: false,
					// Ollama models have no reasoning-effort control.
					efforts: [],
					provider: 'ollama',
					// Local inference is free: no price label.
					priceLabel: '',
					free: true,
				};
			});
			return entries.filter((entry): entry is Record<string, unknown> => entry !== undefined);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.log('WARN', vscode.l10n.t('Ollama model list unavailable: {0}', detail));
			return [];
		}
	}

	/**
	 * Serialized Gemini catalog for the wizard and the Models section.
	 * Mirrors {@link _openRouterCatalogState}: the list travels through state
	 * because the webview CSP forbids fetch calls. The curated native lineup
	 * is excluded (those ids are contributed as bare native entries); a key
	 * that is invalid (or an API outage) degrades to an empty list rather
	 * than breaking the whole settings page.
	 */
	private async _geminiCatalogState(apiKey: string): Promise<unknown[]> {
		try {
			const catalog = await this._geminiCatalogProvider.getCatalog(apiKey);
			return [...catalog.values()].map(model => ({
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				vision: model.capabilities.vision,
				toolCalling: model.capabilities.toolCalling,
				reasoning: (model.capabilities.supportsReasoningEffort?.length ?? 0) > 0,
				// Gemini catalog models accept `none`/`low`/`high`.
				efforts: model.capabilities.supportsReasoningEffort ?? [],
				provider: 'gemini',
				priceLabel: '',
				free: true,
			}));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.log('WARN', vscode.l10n.t('Gemini catalog unavailable: {0}', detail));
			return [];
		}
	}

	/**
	 * Serialized Cursor model list for the wizard and the Models section.
	 * Mirrors {@link _openRouterCatalogState}: the list travels through state
	 * because the webview CSP forbids fetch calls. A key that is invalid (or
	 * an API outage) degrades to an empty list rather than breaking the whole
	 * settings page.
	 */
	private async _cursorCatalogState(apiKey: string): Promise<unknown[]> {
		try {
			const catalog = await this._cursorProvider.getCatalog(apiKey);
			return [...catalog.values()].map(model => ({
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				vision: model.capabilities.vision,
				toolCalling: model.capabilities.toolCalling,
				reasoning: (model.capabilities.supportsReasoningEffort?.length ?? 0) > 0,
				// Cursor models have no reasoning-effort control.
				efforts: [],
				provider: 'cursor',
				priceLabel: '',
				free: false,
			}));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.log('WARN', vscode.l10n.t('Cursor model list unavailable: {0}', detail));
			return [];
		}
	}

	/**
	 * Flattened, selection-gated model list for the settings dropdowns (Models
	 * page, Agents page, vision defaults). Mirrors the chat model picker's
	 * visibility rules in `nikaProvider.provideLanguageModelChatInformation`:
	 * legacy mode (no `nika.providers`) keeps the classic key-based rules,
	 * while managed mode exposes exactly the wizard-selected models of the
	 * added providers. Each entry carries the id (as stored in
	 * `nika.defaultModel`, i.e. `nika/…`), a display name, the provider
	 * family, capabilities (vision, effort levels), and optional
	 * context/pricing for the catalog rows.
	 */
	private async _modelChoicesState(config: vscode.WorkspaceConfiguration, openRouterCatalog: unknown[], llamaCppCatalog: unknown[], ollamaCatalog: unknown[], geminiCatalog: unknown[], cursorCatalog: unknown[], providerConfig: NikaProviderConfig | undefined): Promise<unknown[]> {
		const limits = resolveNikaTokenLimits(
			config.get<string>('contextWindow', '128K'),
			config.get<string>('outputTokens', '8K'),
		);
		const nativeChoices = getVisibleNikaModelIds(!!this._deepSeekKey, !!this._geminiKey, providerConfig).map(id => {
			const capabilities = getNikaModelCapabilities(id, limits);
			return {
				id: `nika/${id}`,
				displayName: capabilities.name,
				provider: getNikaModelProvider(id),
				vision: capabilities.vision ?? false,
				efforts: getNikaEffortOptionsForModel(id),
			};
		});
		const openRouterSelected = getNikaSelectedModels(providerConfig, 'openrouter');
		const catalogChoices = (openRouterCatalog as unknown[])
			.filter(model => {
				if (openRouterSelected === undefined) {
					// Legacy: the full catalog shows whenever a key is present.
					return providerConfig === undefined;
				}
				return openRouterSelected.includes(`${NIKA_OPENROUTER_MODEL_PREFIX}${(model as { id: string }).id}`);
			})
			.map(model => {
				const entry = model as { id: string; name: string; vision: boolean; efforts: string[]; vendor: string; contextWindow: number; priceLabel: string; free: boolean };
				return {
					id: `nika/${NIKA_OPENROUTER_MODEL_PREFIX}${entry.id}`,
					displayName: entry.name,
					provider: 'openrouter',
					vendor: entry.vendor,
					vision: entry.vision,
					efforts: entry.efforts,
					contextWindow: entry.contextWindow,
					priceLabel: entry.priceLabel,
					free: entry.free,
				};
			});
		const llamaCppSelected = getNikaSelectedModels(providerConfig, 'llamacpp');
		const llamaCppChoices = (llamaCppCatalog as unknown[])
			.filter(model => {
				if (llamaCppSelected === undefined) {
					return providerConfig === undefined;
				}
				return llamaCppSelected.includes(`${NIKA_LLAMACPP_MODEL_PREFIX}${(model as { id: string }).id}`);
			})
			.map(model => {
				const entry = model as { id: string; name: string; vision: boolean; efforts: string[]; contextWindow: number };
				return {
					id: `nika/${NIKA_LLAMACPP_MODEL_PREFIX}${entry.id}`,
					displayName: entry.name,
					provider: 'llamacpp',
					vision: entry.vision,
					efforts: entry.efforts,
					contextWindow: entry.contextWindow,
				};
			});
		const ollamaSelected = getNikaSelectedModels(providerConfig, 'ollama');
		const ollamaChoices = (ollamaCatalog as unknown[])
			.filter(model => {
				if (ollamaSelected === undefined) {
					return providerConfig === undefined;
				}
				return ollamaSelected.includes(`${NIKA_OLLAMA_MODEL_PREFIX}${(model as { id: string }).id}`);
			})
			.map(model => {
				const entry = model as { id: string; name: string; vision: boolean; efforts: string[]; contextWindow: number };
				return {
					id: `nika/${NIKA_OLLAMA_MODEL_PREFIX}${entry.id}`,
					displayName: entry.name,
					provider: 'ollama',
					vision: entry.vision,
					efforts: entry.efforts,
					contextWindow: entry.contextWindow,
				};
			});
		// The Gemini catalog only ever appears in managed mode: legacy mode
		// surfaces exactly the curated native lineup.
		const geminiSelected = getNikaSelectedModels(providerConfig, 'gemini');
		const geminiChoices = (geminiCatalog as unknown[])
			.filter(model => geminiSelected !== undefined && geminiSelected.includes(`${NIKA_GEMINI_MODEL_PREFIX}${(model as { id: string }).id}`))
			.map(model => {
				const entry = model as { id: string; name: string; vision: boolean; efforts: string[]; contextWindow: number };
				return {
					id: `nika/${NIKA_GEMINI_MODEL_PREFIX}${entry.id}`,
					displayName: entry.name,
					provider: 'gemini',
					vision: entry.vision,
					efforts: entry.efforts,
					contextWindow: entry.contextWindow,
				};
			});
		const cursorSelected = getNikaSelectedModels(providerConfig, 'cursor');
		const cursorChoices = (cursorCatalog as unknown[])
			.filter(model => {
				if (cursorSelected === undefined) {
					return providerConfig === undefined;
				}
				return cursorSelected.includes(`${NIKA_CURSOR_MODEL_PREFIX}${(model as { id: string }).id}`);
			})
			.map(model => {
				const entry = model as { id: string; name: string; vision: boolean; efforts: string[]; contextWindow: number };
				return {
					id: `nika/${NIKA_CURSOR_MODEL_PREFIX}${entry.id}`,
					displayName: entry.name,
					provider: 'cursor',
					vision: entry.vision,
					efforts: entry.efforts,
					contextWindow: entry.contextWindow,
				};
			});
		// The web model is static: no catalog fetch needed. Managed mode gates
		// on the wizard selection; legacy mode shows it whenever a token
		// exists (mirroring the classic key-based visibility rules).
		const deepSeekWebSelected = getNikaSelectedModels(providerConfig, 'deepseekweb');
		const deepSeekWebChoices = Object.entries(this._deepSeekWebProvider.getKnownModels())
			.filter(([id]) => deepSeekWebSelected === undefined ? providerConfig === undefined : deepSeekWebSelected.includes(id))
			.map(([id, capabilities]) => ({
				id: `nika/${id}`,
				displayName: capabilities.name,
				provider: 'deepseekweb',
				vision: capabilities.vision ?? false,
				efforts: getNikaEffortOptionsForModel(id),
			}));
		return [...nativeChoices, ...ollamaChoices, ...catalogChoices, ...llamaCppChoices, ...geminiChoices, ...cursorChoices, ...deepSeekWebChoices];
	}

	private _llamaCppBaseUrl(): string {
		return vscode.workspace.getConfiguration('nika').get<string>('llamaCppBaseUrl', 'http://localhost:8080').replace(/\/$/, '');
	}

	private _usageState(): Record<string, unknown> {
		const daily = this._usageTracker.getDailySummary(14);
		const today = daily.length > 0 ? daily[daily.length - 1] : undefined;
		const rate = getDeepSeekRatePeriod();
		const events = this._usageTracker.events;
		// The last successful event decides which provider the rate card
		// describes. Legacy events default to `deepseek`.
		const lastEvent = [...events].reverse().find(event => !event.error);
		const lastProvider = lastEvent?.provider ?? 'deepseek';
		// OpenRouter used models with their pricing snapshots, most-used first.
		const openRouterByModel = new Map<string, { model: string; requests: number; totalTokens: number; cost: number; priceLabel: string }>();
		for (const event of events) {
			if (event.provider !== 'openrouter' || !event.pricing) {
				continue;
			}
			let summary = openRouterByModel.get(event.model);
			if (!summary) {
				summary = { model: event.model, requests: 0, totalTokens: 0, cost: 0, priceLabel: formatOpenRouterPriceLabel(event.pricing) };
				openRouterByModel.set(event.model, summary);
			}
			summary.requests += 1;
			summary.totalTokens += event.totalTokens;
			summary.cost += event.cost;
		}
		return {
			enabled: this._usageTracker.enabled,
			peak: isDeepSeekPeakHour(),
			peakHoursLabel: '01:00–04:00 & 06:00–10:00 UTC',
			rate: { peak: rate.peak, endsAt: rate.endsAt, nextIsPeak: rate.nextIsPeak },
			daily,
			sessions: this._usageTracker.getSessionSummaries(10),
			workspaces: this._usageTracker.getWorkspaceSummaries(),
			messages: this._usageTracker.getMessageHistory(20),
			todayTokens: today?.totalTokens ?? 0,
			todayCost: today?.cost ?? 0,
			totalTokens: daily.reduce((sum, day) => sum + day.totalTokens, 0),
			totalCost: daily.reduce((sum, day) => sum + day.cost, 0),
			lastProvider,
			openRouterModels: [...openRouterByModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
		};
	}

	private async _indexingState(): Promise<Record<string, unknown>> {
		try {
			const [state, available] = await Promise.all([
				this._indexingSchemeManager.getState(),
				this._indexingSchemeManager.isAvailable(),
			]);
			return {
				scheme: this._indexingSchemeManager.id,
				available,
				status: state.status,
				indexedFileCount: state.indexedFileCount,
				totalFileCount: state.totalFileCount,
				lastError: state.lastError,
				message: state.message,
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return {
				scheme: this._indexingSchemeManager.id,
				available: false,
				status: 'error',
				indexedFileCount: 0,
				totalFileCount: 0,
				lastError: detail,
			};
		}
	}

	private async _onMessage(message: unknown): Promise<void> {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}
		if (isNikaSettingsSection(message.activeSection)) {
			this._activeSection = message.activeSection;
		}
		try {
			switch (message.type) {
				case 'saveSetting':
					if (typeof message.key === 'string' && SETTINGS.has(message.key)) {
						await this._saveSetting(message.key, message.value);
					}
					break;
				case 'saveSecret':
					if ((message.provider === 'deepseek' || message.provider === 'gemini' || message.provider === 'openrouter' || message.provider === 'llamacpp' || message.provider === 'cursor' || message.provider === 'deepseekweb') && typeof message.value === 'string') {
						await this._saveSecret(message.provider, message.value);
					}
					break;
				case 'removeSecret':
					if (message.provider === 'deepseek' || message.provider === 'gemini' || message.provider === 'openrouter' || message.provider === 'llamacpp' || message.provider === 'cursor' || message.provider === 'deepseekweb') {
						await this._context.secrets.delete(SECRET_KEYS[message.provider]);
						this._connections.delete(message.provider);
						void vscode.window.showInformationMessage(vscode.l10n.t('{0} key removed.', providerDisplayName(message.provider)));
					}
					break;
				case 'testConnection':
					if (message.provider === 'deepseek' || message.provider === 'gemini' || message.provider === 'ollama' || message.provider === 'openrouter' || message.provider === 'llamacpp' || message.provider === 'cursor' || message.provider === 'deepseekweb') {
						await this.testConnection(message.provider);
					}
					break;
				case 'deepSeekWebSignIn':
					await this._deepSeekWebSignIn();
					break;
				case 'deepSeekWebImportToken':
					await this._deepSeekWebImportToken();
					break;
				case 'saveProviderConfig':
					if (typeof message.provider === 'string' && Array.isArray(message.models)) {
						await this._saveProviderConfig(message.provider as NikaProviderId, message.models);
					}
					break;
				case 'removeProvider':
					if (typeof message.provider === 'string') {
						await this._removeProvider(message.provider as NikaProviderId);
					}
					break;
				case 'setOpenRouterDefault':
					if (typeof message.model === 'string' && message.model.includes('/')) {
						const qualified = `nika/${nikaOpenRouterModelId(message.model)}`;
						await vscode.workspace.getConfiguration('nika').update('defaultModel', qualified, vscode.ConfigurationTarget.Global);
						await vscode.workspace.getConfiguration('chat').update('defaultModel', qualified, vscode.ConfigurationTarget.Global);
						void vscode.window.showInformationMessage(vscode.l10n.t('OpenRouter model {0} set as the default chat model.', message.model));
					}
					break;
				case 'recommendedAgents':
					await this._applyRecommendedAgents();
					break;
				case 'checkUpdates':
					await this.checkForUpdates(true);
					break;
				case 'openLogs':
					this._output.show(true);
					break;
				case 'exportDiagnostics':
					await this.exportDiagnostics();
					break;
				case 'setIndexingWorkspace':
					await this._setIndexingWorkspace(true);
					break;
				case 'clearIndexingWorkspace':
					await this._setIndexingWorkspace(false);
					break;
				case 'rebuildIndex':
					await this._rebuildIndex();
					break;
				case 'clearIndex':
					await this._clearIndex();
					break;
				case 'clearModelCache':
					await this._indexingSchemeManager.clearModelCache();
					break;
				case 'clearUsage':
					await this._usageTracker.clear();
					void vscode.window.showInformationMessage(vscode.l10n.t('Nika usage data cleared.'));
					break;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.log('ERROR', detail);
			void vscode.window.showErrorMessage(vscode.l10n.t('Nika Settings could not apply the change: {0}', detail));
		} finally {
			await this._render(this._activeSection);
		}
	}

	private async _saveSetting(key: string, value: unknown): Promise<void> {
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
			throw new Error(vscode.l10n.t('Invalid setting value.'));
		}
		if (key === 'temperature' && (typeof value !== 'number' || value < 0 || value > 2)) {
			throw new Error(vscode.l10n.t('Temperature must be between 0 and 2.'));
		}
		if ((key === 'thinkingEffort' || key.endsWith('ThinkingEffort')) && !isNikaThinkingEffort(value)) {
			throw new Error(vscode.l10n.t('Thinking effort must be None, Low, Medium, High, or Max.'));
		}
		// Clamp an effort value that the associated model does not support to
		// the nearest supported level (e.g. `max` → `high` for OpenRouter /
		// Gemini, or `medium` → `high` for DeepSeek). This keeps the stored
		// value valid for the model that will actually run the request.
		if ((key === 'thinkingEffort' || key.endsWith('ThinkingEffort')) && typeof value === 'string') {
			const modelId = key === 'thinkingEffort'
				? vscode.workspace.getConfiguration('nika').get<string>('defaultModel', NIKA_RESPONSES_MODEL)
				: vscode.workspace.getConfiguration('nika').get<string>(`agent.${key.slice('agent.'.length, -'ThinkingEffort'.length)}`, NIKA_RESPONSES_MODEL);
			const supported = getNikaEffortOptionsForModel(modelId);
			if (supported.length > 0 && !(supported as readonly string[]).includes(value)) {
				value = this._clampEffort(value, supported);
			}
		}
		if ((key === 'pdfMaxFileSizeMB' || key === 'pdfMaxPages' || key === 'pdfSparseThreshold') && (typeof value !== 'number' || !Number.isFinite(value) || value < 1)) {
			throw new Error(vscode.l10n.t('PDF limits must be positive numbers.'));
		}
		await vscode.workspace.getConfiguration('nika').update(key, value, vscode.ConfigurationTarget.Global);
		if (key === 'defaultModel' && typeof value === 'string') {
			await vscode.workspace.getConfiguration('chat').update('defaultModel', value, vscode.ConfigurationTarget.Global);
		}
		if (key === 'agent.inlineChat' && typeof value === 'string') {
			await vscode.workspace.getConfiguration('inlineChat').update('defaultModel', this._qualifiedAgentModel(value), vscode.ConfigurationTarget.Global);
		}
		if (key === 'agent.inlineChatThinkingEffort' && typeof value === 'string') {
			await vscode.workspace.getConfiguration('github.copilot.chat.inlineChat').update('reasoningEffort', value, vscode.ConfigurationTarget.Global);
		}
		if (key === 'agent.plan' && typeof value === 'string') {
			await vscode.workspace.getConfiguration('chat').update('planAgent.defaultModel', this._qualifiedAgentModel(value), vscode.ConfigurationTarget.Global);
		}
		if (key === 'agent.explore' && typeof value === 'string') {
			await vscode.workspace.getConfiguration('chat').update('exploreAgent.defaultModel', this._qualifiedAgentModel(value), vscode.ConfigurationTarget.Global);
		}
		if (key === 'agent.utility' && typeof value === 'string') {
			await vscode.workspace.getConfiguration('chat').update('utilityModel', value, vscode.ConfigurationTarget.Global);
		}
		if (key === 'agent.utilitySmall' && typeof value === 'string') {
			await vscode.workspace.getConfiguration('chat').update('utilitySmallModel', value, vscode.ConfigurationTarget.Global);
		}
		this.log('INFO', vscode.l10n.t('Updated {0}.', `nika.${key}`));
	}

	private async _setIndexingWorkspace(useWorkspace: boolean): Promise<void> {
		const config = vscode.workspace.getConfiguration('nika');
		const scheme = config.get<string>('indexing.scheme', 'off');
		if (useWorkspace) {
			await config.update('indexing.scheme', scheme, vscode.ConfigurationTarget.Workspace);
			void vscode.window.showInformationMessage(vscode.l10n.t('Indexing scheme set for this workspace.'));
		} else {
			await config.update('indexing.scheme', undefined, vscode.ConfigurationTarget.Workspace);
			void vscode.window.showInformationMessage(vscode.l10n.t('Removed the workspace-specific indexing scheme.'));
		}
	}

	private async _rebuildIndex(): Promise<void> {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Nika: Building local index') }, async progress => {
			await this._indexingSchemeManager.rebuild(message => progress.report({ message }));
		});
	}

	private async _clearIndex(): Promise<void> {
		await this._indexingSchemeManager.clear();
	}

	private async _saveSecret(provider: 'deepseek' | 'gemini' | 'openrouter' | 'llamacpp' | 'cursor' | 'deepseekweb', value: string): Promise<void> {
		const trimmed = value.trim();
		// Local llama.cpp servers often use short tokens; any non-empty value
		// is accepted there. Cloud providers need a real key.
		if (trimmed.length < (provider === 'llamacpp' ? 1 : 8)) {
			throw new Error(vscode.l10n.t('Enter a valid API key before saving.'));
		}
		await this._context.secrets.store(SECRET_KEYS[provider], trimmed);
		this._connections.delete(provider);
		void vscode.window.showInformationMessage(vscode.l10n.t('{0} key saved securely.', providerDisplayName(provider)));
	}

	/**
	 * Persists the wizard's model selection for a provider in the
	 * `nika.providers` setting. The first save migrates an existing classic
	 * setup (keys + hosts) into the managed config so nothing the user had
	 * visible silently disappears.
	 */
	private async _saveProviderConfig(provider: NikaProviderId, models: unknown[]): Promise<void> {
		const config = vscode.workspace.getConfiguration('nika');
		const current = parseNikaProviderConfig(config.get('providers'));
		const merged: NikaProviderConfig = current ?? await this._legacyProviderSeed();
		merged[provider] = {
			models: [...new Set(models.filter((model): model is string => typeof model === 'string' && model.length > 0))],
		};
		await config.update('providers', merged, vscode.ConfigurationTarget.Global);
		this._connections.delete(provider);
		this.log('INFO', vscode.l10n.t('Saved the {0} provider selection.', providerDisplayName(provider)));
	}

	/**
	 * Seeds the managed `nika.providers` config from the classic setup so the
	 * first wizard save never hides providers the user already had visible
	 * (DeepSeek/Gemini keys, the always-visible Gemma model, an OpenRouter
	 * key, or a llama.cpp host). Catalog failures degrade gracefully: the
	 * provider is still seeded from whatever could be fetched.
	 */
	private async _legacyProviderSeed(): Promise<NikaProviderConfig> {
		const seed: NikaProviderConfig = {};
		const [deepseekKey, geminiKey, openRouterKey, llamaCppKey, cursorKey, deepSeekWebToken] = await Promise.all([
			this._context.secrets.get(NIKA_DEEPSEEK_SECRET),
			this._context.secrets.get(NIKA_GEMINI_SECRET),
			this._context.secrets.get(NIKA_OPENROUTER_SECRET),
			this._context.secrets.get(NIKA_LLAMACPP_SECRET),
			this._context.secrets.get(NIKA_CURSOR_SECRET),
			this._context.secrets.get(NIKA_DEEPSEEK_WEB_SECRET),
		]);
		if (deepseekKey) {
			seed.deepseek = { models: [...NIKA_DEEPSEEK_MODEL_IDS] };
		}
		if (geminiKey) {
			seed.gemini = { models: [...NIKA_GEMINI_MODEL_IDS] };
		}
		if (openRouterKey) {
			const catalog = await this._openRouterCatalogState(openRouterKey);
			seed.openrouter = { models: (catalog as { id: string }[]).map(model => `${NIKA_OPENROUTER_MODEL_PREFIX}${model.id}`) };
		}
		const llamaCppBaseUrl = this._llamaCppBaseUrl();
		if (llamaCppBaseUrl) {
			const catalog = await this._llamaCppCatalogState(llamaCppBaseUrl, llamaCppKey ?? undefined);
			seed.llamacpp = { models: (catalog as { id: string }[]).map(model => `${NIKA_LLAMACPP_MODEL_PREFIX}${model.id}`) };
		}
		const ollamaBaseUrl = vscode.workspace.getConfiguration('nika').get<string>('ollamaBaseUrl', 'http://localhost:11434').replace(/\/$/, '');
		const ollamaCatalog = await this._ollamaCatalogState(ollamaBaseUrl);
		// The classic setup always exposed Gemma; seed at least that, and all
		// pulled models when the host is reachable.
		const ollamaModels = (ollamaCatalog as { id: string }[]).length > 0
			? (ollamaCatalog as { id: string }[]).map(model => `${NIKA_OLLAMA_MODEL_PREFIX}${model.id}`)
			: [`${NIKA_OLLAMA_MODEL_PREFIX}${NIKA_GEMMA_MODEL_ID}`];
		seed.ollama = { models: ollamaModels };
		if (cursorKey) {
			const catalog = await this._cursorCatalogState(cursorKey);
			seed.cursor = { models: (catalog as { id: string }[]).map(model => `${NIKA_CURSOR_MODEL_PREFIX}${model.id}`) };
		}
		if (deepSeekWebToken) {
			seed.deepseekweb = { models: Object.keys(this._deepSeekWebProvider.getKnownModels()) };
		}
		return seed;
	}

	/**
	 * Opens chat.deepseek.com in the integrated browser (falling back to the
	 * system browser) so the user can sign in and get a fresh `userToken`.
	 */
	private async _deepSeekWebSignIn(): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.action.browser.open', {
				url: DEEP_SEEK_WEB_URL,
				reuseUrlFilter: 'https://chat.deepseek.com/**',
			});
			void vscode.window.showInformationMessage(vscode.l10n.t('DeepSeek opened in the integrated browser. Log in, then run “Nika: DeepSeek Web — Import Token”.'));
		} catch {
			await vscode.env.openExternal(vscode.Uri.parse(DEEP_SEEK_WEB_URL));
			void vscode.window.showInformationMessage(vscode.l10n.t('DeepSeek opened in your browser. Log in, then run “Nika: DeepSeek Web — Import Token”.'));
		}
	}

	/**
	 * Reads `localStorage.userToken` from the user's chat.deepseek.com tab in
	 * the integrated browser and stores it as the DeepSeek Web secret. The
	 * token is the webapp's auth value (`{ value, __version }` in storage);
	 * no part of it is logged or shown beyond a masked preview.
	 */
	private async _deepSeekWebImportToken(): Promise<void> {
		const result = await vscode.commands.executeCommand<{ matched: boolean; value?: unknown; error?: string }>(
			'workbench.action.browser.evaluateJavascript',
			{
				urlPrefix: 'chat.deepseek.com',
				expression: `(() => { const raw = localStorage.getItem('userToken'); if (!raw) { return null; } try { return JSON.parse(raw)?.value ?? raw; } catch { return raw; } })()`,
			},
		);
		if (!result?.matched) {
			throw new Error(vscode.l10n.t('No chat.deepseek.com tab is open in the integrated browser. Run “Nika: DeepSeek Web — Sign In” first.'));
		}
		if (result.error) {
			throw new Error(vscode.l10n.t('Could not read the DeepSeek token from the browser page: {0}', result.error));
		}
		const token = typeof result.value === 'string' && result.value.length > 0 ? result.value : undefined;
		if (!token) {
			throw new Error(vscode.l10n.t('No userToken was found on the page. Sign in at chat.deepseek.com in the integrated browser and try again.'));
		}
		await this._context.secrets.store(NIKA_DEEPSEEK_WEB_SECRET, token);
		this._deepSeekWebProvider.invalidateCache();
		this._connections.delete('deepseekweb');
		void vscode.window.showInformationMessage(vscode.l10n.t('DeepSeek Web token imported ({0}…{1}).', token.slice(0, 6), token.slice(-4)));
	}

	/**
	 * Removes a provider from the managed `nika.providers` config. Its models
	 * stop appearing in chat, Agents, and the dropdowns immediately. The API
	 * key (if any) is kept in Secret Storage so re-adding the provider does
	 * not require re-entering it.
	 */
	private async _removeProvider(provider: NikaProviderId): Promise<void> {
		const config = vscode.workspace.getConfiguration('nika');
		const current = parseNikaProviderConfig(config.get('providers'));
		if (!current) {
			return;
		}
		const { [provider]: _removed, ...rest } = current;
		await config.update('providers', rest, vscode.ConfigurationTarget.Global);
		this._connections.delete(provider);
		void vscode.window.showInformationMessage(vscode.l10n.t('{0} removed. Its models no longer appear in chat or agents.', providerDisplayName(provider)));
	}

	async testConnection(provider: NikaConnection): Promise<boolean> {
		let result: ConnectionResult;
		try {
			let response: { ok: boolean; status: number } | undefined;
			if (provider === 'deepseekweb') {				const token = await this._context.secrets.get(NIKA_DEEPSEEK_WEB_SECRET);
				if (!token) { throw new Error(vscode.l10n.t('No DeepSeek web token is configured.')); }
				// A chat-session round trip proves the token and the PoW path
				// work end to end. The orphan session is harmless.
				const client = new DeepSeekWebClient(token, this._fetcherService);
				await client.createChatSession();
				response = { ok: true, status: 200 };
			} else if (provider === 'deepseek') {
				const key = await this._context.secrets.get(NIKA_DEEPSEEK_SECRET);
				if (!key) { throw new Error(vscode.l10n.t('No DeepSeek key is configured.')); }
				response = await this._fetcherService.fetch('https://api.deepseek.com/models', { method: 'GET', headers: { Authorization: `Bearer ${key}` }, callSite: 'nika-deepseek-test' });
			} else if (provider === 'gemini') {
				const key = await this._context.secrets.get(NIKA_GEMINI_SECRET);
				if (!key) { throw new Error(vscode.l10n.t('No Gemini key is configured.')); }
				response = await this._fetcherService.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { method: 'GET', headers: { 'x-goog-api-key': key }, callSite: 'nika-gemini-test' });
			} else if (provider === 'openrouter') {
				const key = await this._context.secrets.get(NIKA_OPENROUTER_SECRET);
				if (!key) { throw new Error(vscode.l10n.t('No OpenRouter key is configured.')); }
				response = await this._fetcherService.fetch('https://openrouter.ai/api/v1/models', { method: 'GET', headers: { Authorization: `Bearer ${key}` }, callSite: 'nika-openrouter-test' });
			} else if (provider === 'llamacpp') {
				const url = this._llamaCppBaseUrl();
				const key = await this._context.secrets.get(NIKA_LLAMACPP_SECRET);
				response = await this._fetcherService.fetch(`${url}/v1/models`, { method: 'GET', headers: key ? { Authorization: `Bearer ${key}` } : undefined, callSite: 'nika-llamacpp-test' });
			} else if (provider === 'cursor') {
				const key = await this._context.secrets.get(NIKA_CURSOR_SECRET);
				if (!key) { throw new Error(vscode.l10n.t('No Cursor key is configured.')); }
				response = await this._fetcherService.fetch('https://api.cursor.com/v1/models', { method: 'GET', headers: { Authorization: `Bearer ${key}` }, callSite: 'nika-cursor-test' });
			} else {
				const url = vscode.workspace.getConfiguration('nika').get<string>('ollamaBaseUrl', 'http://localhost:11434').replace(/\/$/, '');
				response = await this._fetcherService.fetch(`${url}/api/version`, { method: 'GET', callSite: 'nika-ollama-test' });
			}
			if (!response.ok) {
				throw new Error(vscode.l10n.t('Connection returned HTTP {0}.', response.status));
			}
			result = { ok: true, message: vscode.l10n.t('Connection successful'), checkedAt: new Date().toISOString() };
		} catch (error) {
			result = { ok: false, message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
		}
		this._connections.set(provider, result);
		this.log(result.ok ? 'INFO' : 'ERROR', `${provider}: ${result.message}`);
		void vscode.window.showInformationMessage(result.ok
			? vscode.l10n.t('{0} connection successful.', providerDisplayName(provider))
			: vscode.l10n.t('{0} connection failed: {1}', providerDisplayName(provider), result.message));
		await this._render();
		return result.ok;
	}

	private async _applyRecommendedAgents(showMessage = true): Promise<void> {
		const config = vscode.workspace.getConfiguration('nika');
		const recommended: Record<string, string> = {
			'agent.plan': NIKA_AGENT_DEFAULTS.plan.model,
			'agent.explore': NIKA_AGENT_DEFAULTS.explore.model,
			'agent.utility': NIKA_AGENT_DEFAULTS.utility.model,
			'agent.utilitySmall': NIKA_AGENT_DEFAULTS.utilitySmall.model,
			'agent.inlineChat': NIKA_AGENT_DEFAULTS.inlineChat.model,
			'agent.planThinkingEffort': NIKA_AGENT_DEFAULTS.plan.effort,
			'agent.exploreThinkingEffort': NIKA_AGENT_DEFAULTS.explore.effort,
			'agent.utilityThinkingEffort': NIKA_AGENT_DEFAULTS.utility.effort,
			'agent.utilitySmallThinkingEffort': NIKA_AGENT_DEFAULTS.utilitySmall.effort,
			'agent.inlineChatThinkingEffort': NIKA_AGENT_DEFAULTS.inlineChat.effort,
		};
		await Promise.all(Object.entries(recommended).map(([key, value]) => config.update(key, value, vscode.ConfigurationTarget.Global)));
		await this._applyNativeAgentMappings(recommended);
		if (showMessage) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Applied the recommended Nika agent mappings.'));
		}
	}

	private async _applyNativeAgentMappings(assignments: Record<string, string>): Promise<void> {
		await Promise.all([
			vscode.workspace.getConfiguration('chat').update('planAgent.defaultModel', this._qualifiedAgentModel(assignments['agent.plan']), vscode.ConfigurationTarget.Global),
			vscode.workspace.getConfiguration('chat').update('exploreAgent.defaultModel', this._qualifiedAgentModel(assignments['agent.explore']), vscode.ConfigurationTarget.Global),
			vscode.workspace.getConfiguration('chat').update('utilityModel', assignments['agent.utility'], vscode.ConfigurationTarget.Global),
			vscode.workspace.getConfiguration('chat').update('utilitySmallModel', assignments['agent.utilitySmall'], vscode.ConfigurationTarget.Global),
			vscode.workspace.getConfiguration('inlineChat').update('defaultModel', this._qualifiedAgentModel(assignments['agent.inlineChat']), vscode.ConfigurationTarget.Global),
			vscode.workspace.getConfiguration('github.copilot.chat.inlineChat').update('reasoningEffort', assignments['agent.inlineChatThinkingEffort'], vscode.ConfigurationTarget.Global),
		]);
	}

	private _qualifiedAgentModel(value: string): string {
		const id = value.replace(/^nika\//, '');
		const names: Record<string, string> = {
			'deepseek-v4-flash': 'DeepSeek V4 Flash',
			'deepseek-v4-pro': 'DeepSeek V4 Pro',
			'deepseek-v4-flash-responses': 'DeepSeek V4 Flash (Responses, Experimental)',
			'deepseek-v4-pro-responses': 'DeepSeek V4 Pro (Responses, Experimental)',
			'gemini-2.5-flash': 'Gemini 2.5 Flash',
			'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
			'gemma4:31b': 'Gemma 4 31B (Ollama)',
		};
		return names[id] ? `${names[id]} (nika)` : value;
	}

	async checkForUpdates(showNoUpdate: boolean): Promise<void> {
		try {
			const response = await this._fetcherService.fetch('https://api.github.com/repos/alive2/nika-code/releases/latest', {
				method: 'GET',
				headers: { Accept: 'application/vnd.github+json' },
				callSite: 'nika-release-check',
			});
			if (response.status === 404) {
				if (showNoUpdate) { void vscode.window.showInformationMessage(vscode.l10n.t('No published releases yet.')); }
				return;
			}
			if (!response.ok) {
				throw new Error(vscode.l10n.t('Release check returned HTTP {0}.', response.status));
			}
			const release = await response.json() as { tag_name?: string; html_url?: string };
			if (!release.tag_name) {
				throw new Error(vscode.l10n.t('The release response did not include a version.'));
			}
			const current = vscode.version;
			if (compareVersions(release.tag_name, current) > 0) {
				const view = vscode.l10n.t('View Release');
				const choice = await vscode.window.showInformationMessage(vscode.l10n.t('NikaCode {0} is available. You have {1}.', release.tag_name, current), view);
				if (choice === view && release.html_url) {
					await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
				}
			} else if (showNoUpdate) {
				void vscode.window.showInformationMessage(vscode.l10n.t('NikaCode is up to date.'));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log('ERROR', vscode.l10n.t('Release check failed: {0}', message));
			if (showNoUpdate) { void vscode.window.showErrorMessage(vscode.l10n.t('Could not check for NikaCode updates: {0}', message)); }
		}
	}

	async exportDiagnostics(): Promise<void> {
		const target = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file('nika-diagnostics.json'),
			filters: { [vscode.l10n.t('JSON files')]: ['json'] },
			saveLabel: vscode.l10n.t('Export Nika Diagnostics'),
		});
		if (!target) {
			return;
		}
		const state = await this._state();
		const diagnostics = {
			generatedAt: new Date().toISOString(),
			appVersion: state.appVersion,
			extensionVersion: state.extensionVersion,
			deepseekConfigured: state.deepseekConfigured,
			geminiConfigured: state.geminiConfigured,
			openrouterConfigured: state.openrouterConfigured,
			llamacppConfigured: state.llamacppConfigured,
			providersManaged: state.providersManaged,
			providers: state.providers,
			openrouterModelCount: (state.openrouterModels as unknown[]).length,
			llamacppModelCount: (state.llamacppModels as unknown[]).length,
			connections: state.connections,
			settings: state.settings,
		};
		await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(diagnostics, undefined, 2)));
		void vscode.window.showInformationMessage(vscode.l10n.t('Nika diagnostics exported.'));
	}

	log(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string): void {
		const configured = vscode.workspace.getConfiguration('nika').get<string>('logLevel', 'INFO');
		const rank = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const;
		if (rank[level] < (rank[configured as keyof typeof rank] ?? rank.INFO)) {
			return;
		}
		const line = `${new Date().toISOString()} [${level}] ${message}`;
		this._output.appendLine(line);
		if (level === 'ERROR') { this._logService.error(`[Nika] ${message}`); }
		else if (level === 'WARN') { this._logService.warn(`[Nika] ${message}`); }
		else if (level === 'DEBUG') { this._logService.debug(`[Nika] ${message}`); }
		else { this._logService.info(`[Nika] ${message}`); }
	}

	private _html(webview: vscode.Webview, state: Record<string, unknown>): string {
		const token = nonce();
		const encoded = JSON.stringify(state).replace(/</g, '\\u003c');
		return `<!DOCTYPE html>
<html lang="${vscode.env.language}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${token}';">
<title>${vscode.l10n.t('Nika Settings')}</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family)}
.shell{display:grid;grid-template-columns:210px minmax(0,760px);max-width:1040px;margin:0 auto;min-height:100vh}.side{position:sticky;top:0;height:100vh;padding:34px 18px;border-right:1px solid var(--vscode-panel-border)}
.brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:650;margin:0 8px 28px}.mark{width:26px;height:26px;border-radius:6px;overflow:hidden;flex:none}
nav button{display:block;width:100%;border:0;border-radius:6px;background:transparent;color:var(--vscode-foreground);padding:9px 10px;text-align:left;cursor:pointer}nav button:hover,nav button.active{background:var(--vscode-list-hoverBackground)}
main{padding:38px 46px 80px}section{display:none}section.active{display:block}h1{font-size:26px;margin:0 0 8px}h2{font-size:16px;margin:30px 0 8px}.lead{color:var(--vscode-descriptionForeground);margin:0 0 28px;line-height:1.55}
.card{padding:18px;border:1px solid var(--vscode-panel-border);border-radius:10px;margin:12px 0;background:color-mix(in srgb,var(--vscode-editor-background) 94%,var(--vscode-sideBar-background))}.row{display:grid;grid-template-columns:minmax(190px,1fr) minmax(210px,1fr);gap:22px;align-items:center;padding:11px 0}.row+.row{border-top:1px solid color-mix(in srgb,var(--vscode-panel-border) 65%,transparent)}label strong{display:block;margin-bottom:4px}.hint,.status{color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.4}.agent-controls{display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:8px}
input,select{width:100%;min-height:30px;padding:5px 8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px}input:focus,select:focus,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}input[type="checkbox"]{width:auto;min-height:auto;accent-color:var(--vscode-button-background)}.controls{display:flex;gap:7px;align-items:center}.controls.wrap{flex-wrap:wrap}.controls input{flex:1}.controls input[type="checkbox"]{flex:0}.controls button,.action{white-space:nowrap;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;padding:6px 11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}.secondary{background:var(--vscode-button-secondaryBackground)!important;color:var(--vscode-button-secondaryForeground)!important}.danger{background:transparent!important;color:var(--vscode-errorForeground)!important;border-color:var(--vscode-errorForeground)!important}.pill{display:inline-flex;gap:6px;align-items:center;padding:3px 8px;border-radius:999px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px}.dot{width:7px;height:7px;border-radius:50%;background:#ef4444}.ok .dot{background:#22c55e}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.chart{margin:8px 0 4px}.chart svg{display:block;width:100%;height:auto}.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0 4px}.kpi .k{color:var(--vscode-descriptionForeground);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.kpi .v{font-size:21px;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums}table.usage{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;table-layout:fixed}table.usage th,table.usage td{text-align:left;padding:6px 10px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 65%,transparent);vertical-align:top;overflow-wrap:break-word;word-break:break-word}table.usage th{color:var(--vscode-descriptionForeground);font-weight:600;white-space:nowrap}table.usage td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}table.usage tr:last-child td{border-bottom:0}table.usage [data-openrouter-default]{white-space:normal;text-align:left;word-break:break-word}.peak-badge{display:inline-flex;gap:6px;align-items:center;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;background:color-mix(in srgb,var(--vscode-badge-background) 55%,transparent)}.peak-badge .dot{background:#22c55e}.peak-badge.peak .dot{background:#ef4444}.empty{color:var(--vscode-descriptionForeground);font-style:italic;padding:10px 0}@media(max-width:720px){.shell{display:block}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}nav{display:flex;overflow:auto}.brand{margin-bottom:14px}main{padding:28px 20px}.row{grid-template-columns:1fr;gap:8px}}
</style></head><body><div class="shell"><aside class="side"><div class="brand"><svg class="mark" viewBox="0 0 1024 1024" aria-hidden="true"><rect width="1024" height="1024" fill="#000"/><path fill="#fff" d="M510 650 163 894V670c0-18 9-35 24-45l139-92 184 117Z"/><path fill="#fff" d="M163 197 330 92v416c0 21 11 40 29 51l151 96-27 18-298-190c-14-9-22-24-22-41V197Z"/><path fill="#fff" d="m710 530 151 91v209L710 932V530Z"/><path fill="#fff" d="M330 303 710 530v252L359 568c-18-11-29-30-29-51V303Z"/><path fill="#fff" d="m601 270 260 148c0 17-9 33-24 42l-127 70-109-64V270Z"/><path fill="#fff" d="M601 270c0-7 4-14 10-18l250-144v310L601 270Z"/></svg>NikaCode</div><nav>
${[['overview', vscode.l10n.t('Overview')], ['providers', vscode.l10n.t('Providers')], ['models', vscode.l10n.t('Models')], ['vision', vscode.l10n.t('Vision')], ['pdf', vscode.l10n.t('PDF')], ['agents', vscode.l10n.t('Agents')], ['indexing', vscode.l10n.t('Indexing')], ['usage', vscode.l10n.t('Usage')], ['diagnostics', vscode.l10n.t('Diagnostics')]].map(([id, label], i) => `<button class="${i === 0 ? 'active' : ''}" data-section="${id}">${label}</button>`).join('')}
</nav></aside><main>
<section id="overview" class="active"><h1>${vscode.l10n.t('Nika Settings')}</h1><p class="lead">${vscode.l10n.t('Native DeepSeek, Gemini, Gemma, OpenRouter, Cursor, llama.cpp, vision, and PDF support for NikaCode.')}</p>
<div class="card"><h2>${vscode.l10n.t('Get started')}</h2><p class="hint">${vscode.l10n.t('Add the providers you use; only the models you select will appear in chat and agents.')}</p><ol><li><strong>${vscode.l10n.t('Open the Providers page')}</strong> — ${vscode.l10n.t('Choose Add Provider and pick DeepSeek, Gemini, Ollama, OpenRouter, Cursor, or llama.cpp.')}</li><li><strong>${vscode.l10n.t('Enter your key or host')}</strong> — ${vscode.l10n.t('API keys are stored securely; local hosts need just a URL.')}</li><li><strong>${vscode.l10n.t('Select the models you want')}</strong> — ${vscode.l10n.t('Only selected models appear in chat, Agents, and the model dropdowns. You can change this later.')}</li><li><strong>${vscode.l10n.t('Test and finish')}</strong> — ${vscode.l10n.t('The wizard verifies the connection before saving.')}</li></ol><button class="action" data-section="providers">${vscode.l10n.t('Set up providers')}</button></div>
<div class="card"><h2>${vscode.l10n.t('Providers')}</h2>${this._overviewProviderRows(state)}</div>
<div class="card"><div class="row"><label><strong>${vscode.l10n.t('NikaCode version')}</strong></label><span id="app-version"></span></div><div class="row"><label><strong>${vscode.l10n.t('Bundled Copilot version')}</strong></label><span id="extension-version"></span></div></div>
<div class="card"><h2>${vscode.l10n.t('Safety')}</h2><p class="hint">${vscode.l10n.t('Controls the guardrails added to prompts sent to Nika models.')}</p>${this._checkboxRow('safetyRules.enabled', vscode.l10n.t('Enable safety rules'))}<div class="row"><label><strong>${vscode.l10n.t('What this controls')}</strong><span class="hint">${vscode.l10n.t('When on, prompts include Microsoft content policies, copyright, and harmful-content restrictions. Turn off to omit them — you are responsible for what the models produce.')}</span></label></div></div>
<div class="card"><h2>${vscode.l10n.t('GitHub')}</h2><p class="hint">${vscode.l10n.t('NikaCode runs fully on your own models without a GitHub account. Turn GitHub on to restore Copilot integration.')}</p>${this._checkboxRow('github.enabled', vscode.l10n.t('Enable GitHub Copilot integration'))}<div class="row"><label><strong>${vscode.l10n.t('What this controls')}</strong><span class="hint">${vscode.l10n.t('When off (default), no GitHub sign-in is required anywhere: chat, agent mode, inline chat, and the Agents window all use your Nika models. When on, GitHub sign-in prompts, Copilot utility models, and the GitHub MCP server are restored.')}</span></label></div></div></section>
<section id="providers"><h1>${vscode.l10n.t('Providers')}</h1><p class="lead">${vscode.l10n.t('Add only the providers you use. The models you select are the only ones that appear in chat, Agents, and the model dropdowns.')}</p>
<div data-provider-cards></div>
<div class="actions"><button class="action" data-wizard-add>${vscode.l10n.t('Add Provider')}</button></div>
<div data-wizard></div>
</section>
<section id="models"><h1>${vscode.l10n.t('Models')}</h1><p class="lead">${vscode.l10n.t('Choose defaults and request budgets. A conversation-level picker selection always wins.')}</p><div class="card">
${this._modelSelectRow('defaultModel', vscode.l10n.t('Default model for new chats'), state, String((state.settings as Record<string, unknown>).defaultModel ?? NIKA_RESPONSES_MODEL))}
${this._selectRow('outputTokens', vscode.l10n.t('Maximum output'), ['4K', '8K', '16K', '32K', '64K', '128K', '384K'].map(v => [v, v]))}${this._selectRow('contextWindow', vscode.l10n.t('Input context preset'), ['32K', '64K', '128K', '256K', '512K', '1M'].map(v => [v, v]))}${this._numberRow('temperature', vscode.l10n.t('Temperature'), '0', '2', '0.1')}${this._effortSelectRow('thinkingEffort', vscode.l10n.t('Default thinking effort'), state, String((state.settings as Record<string, unknown>).defaultModel ?? NIKA_RESPONSES_MODEL), String((state.settings as Record<string, unknown>).thinkingEffort ?? 'high'))}${this._checkboxRow('openrouterFloor', vscode.l10n.t('Use floor pricing for OpenRouter models'))}</div>
${(state.openrouterModels as unknown[]).length > 0 ? `<div class="card" style="min-width:0"><h2>${vscode.l10n.t('OpenRouter catalog')}</h2><p class="hint">${vscode.l10n.t('Search the full catalog and pick a default. The chat model picker always shows the complete list with live prices.')}</p><div class="controls"><input type="text" data-openrouter-filter placeholder="${vscode.l10n.t('Filter by model id or name…')}"></div><div data-openrouter-catalog style="min-width:0"></div></div>` : ''}</section>
<section id="vision"><h1>${vscode.l10n.t('Vision')}</h1><p class="lead">${vscode.l10n.t('Choose the image-description backend used for text-only models. Provider credentials are managed on the Providers page.')}</p><div class="card">
${this._visionBackendRow(state, String((state.settings as Record<string, unknown>).visionModel ?? 'gemini-2.5-flash'))}${this._textRow('visionVSCodeModel', vscode.l10n.t('VS Code vision model identifier'))}
<div class="row"><label for="visionOpenRouterModel"><strong>${vscode.l10n.t('OpenRouter vision model')}</strong><span class="hint">${vscode.l10n.t('A vision-capable OpenRouter model id, e.g. google/gemini-2.5-flash.')}</span></label><input id="visionOpenRouterModel" data-setting="visionOpenRouterModel" type="text" list="openrouter-vision-models"></div><datalist id="openrouter-vision-models"></datalist>
</div></section>
<section id="pdf"><h1>${vscode.l10n.t('PDF')}</h1><p class="lead">${vscode.l10n.t('PDF limits apply only to PDF reads. Page ranges can be requested in English or Hebrew.')}</p><div class="card">${this._numberRow('pdfMaxFileSizeMB', vscode.l10n.t('Maximum PDF size (MB)'), '1', '1024', '1')}${this._numberRow('pdfMaxPages', vscode.l10n.t('Pages without an explicit range'), '1', '1000', '1')}${this._checkboxRow('pdfPageNotice', vscode.l10n.t('Show truncation notice'))}${this._checkboxRow('pdfSparseFallback', vscode.l10n.t('Use Gemini for sparse or scanned PDFs'))}${this._numberRow('pdfSparseThreshold', vscode.l10n.t('Sparse-document character threshold'), '1', '100000', '100')}</div></section>
<section id="agents"><h1>${vscode.l10n.t('Agents')}</h1><p class="lead">${vscode.l10n.t('Assign a model and thinking effort to each built-in role. The recommended profile uses DeepSeek V4 Flash Responses for every role.')}</p><div class="card">${(['plan', 'explore', 'utility', 'utilitySmall', 'inlineChat'] as const).map(id => this._agentRow(id, ({ plan: vscode.l10n.t('Plan'), explore: vscode.l10n.t('Explore'), utility: vscode.l10n.t('Utility'), utilitySmall: vscode.l10n.t('Utility Small'), inlineChat: vscode.l10n.t('Inline Chat') } as Record<string, string>)[id], state)).join('')}</div><div class="actions"><button class="action" data-action="recommendedAgents">${vscode.l10n.t('Apply recommended mappings')}</button></div></section>
<section id="indexing"><h1>${vscode.l10n.t('Indexing')}</h1><p class="lead">${vscode.l10n.t('Choose how Nika indexes this workspace. The default applies everywhere; a workspace-specific scheme overrides it here.')}</p><div class="card">
${this._selectRow('indexing.scheme', vscode.l10n.t('Indexing scheme'), [['off', vscode.l10n.t('Off (ripgrep only)')], ['github-remote', vscode.l10n.t('GitHub remote')], ['local', vscode.l10n.t('Local (ONNX)')], ['cloud', vscode.l10n.t('Cloud')]])}
<div class="row"><label><strong>${vscode.l10n.t('Scope')}</strong><span class="hint">${vscode.l10n.t('Apply the scheme to every workspace or only this one.')}</span></label><div class="controls wrap"><button class="action secondary" data-action="setIndexingWorkspace">${vscode.l10n.t('Use for this workspace')}</button><button class="action secondary" data-action="clearIndexingWorkspace">${vscode.l10n.t('Clear workspace override')}</button></div></div>
</div><div class="card"><h2>${vscode.l10n.t('Status')}</h2><div class="row"><label><strong>${vscode.l10n.t('State')}</strong></label><span data-indexing-status></span></div><div class="row"><label><strong>${vscode.l10n.t('Progress')}</strong></label><span data-indexing-progress></span></div><div class="row"><label><strong>${vscode.l10n.t('Activity')}</strong></label><span data-indexing-message></span></div><div class="row"><label><strong>${vscode.l10n.t('Last error')}</strong></label><span data-indexing-error></span></div><div class="row"><label><strong>${vscode.l10n.t('Scope')}</strong></label><span data-indexing-scope></span></div><div class="actions"><button class="action" data-action="rebuildIndex">${vscode.l10n.t('Build / Rebuild index')}</button><button class="action danger" data-action="clearIndex">${vscode.l10n.t('Clear index')}</button><button class="action secondary" data-action="clearModelCache">${vscode.l10n.t('Clear model cache')}</button></div></div></section>
<section id="usage"><h1>${vscode.l10n.t('Usage')}</h1><p class="lead">${vscode.l10n.t('Token usage and cost on this machine. DeepSeek requests use the current peak / off-peak pricing; OpenRouter requests use the OpenRouter catalog price — there is no peak / off-peak split.')}</p>
<div class="card">${this._checkboxRow('usage.enabled', vscode.l10n.t('Track token usage'))}<div class="row"><label><strong>${vscode.l10n.t('Rate period')}</strong><span class="hint">${vscode.l10n.t('DeepSeek bills peak hours {0} and off-peak at half price. OpenRouter and other providers bill at their own catalog rates at all hours.', '01:00–04:00 & 06:00–10:00 UTC')}</span></label><span id="usage-peak-badge"></span></div><div class="row"><label><strong>${vscode.l10n.t('Next rate change')}</strong><span class="hint">${vscode.l10n.t('Counts down live until the DeepSeek billing rate flips.')}</span></label><span id="usage-rate-countdown"></span></div></div>
<div class="card"><div class="kpi"><div><div class="k">${vscode.l10n.t('Today')}</div><div class="v" id="usage-today-tokens"></div></div><div><div class="k">${vscode.l10n.t('Today cost')}</div><div class="v" id="usage-today-cost"></div></div><div><div class="k">${vscode.l10n.t('Last 14 days')}</div><div class="v" id="usage-total-tokens"></div></div><div><div class="k">${vscode.l10n.t('Cost')}</div><div class="v" id="usage-total-cost"></div></div></div></div>
<div class="card"><h2>${vscode.l10n.t('OpenRouter pricing')}</h2><p class="hint">${vscode.l10n.t('OpenRouter bills at catalog rates — no peak or off-peak windows. Per-1M-token prices come from the catalog at request time.')}</p><div data-usage-openrouter></div></div>
<div class="card"><h2>${vscode.l10n.t('Tokens per day')}</h2><div class="chart" data-usage-chart></div></div>
<div class="card"><h2>${vscode.l10n.t('Sessions')}</h2><div data-usage-sessions></div></div>
<div class="card"><h2>${vscode.l10n.t('Workspaces')}</h2><div data-usage-workspaces></div></div>
<div class="card"><h2>${vscode.l10n.t('Recent requests')}</h2><div data-usage-messages></div></div>
<div class="actions"><button class="action danger" data-action="clearUsage">${vscode.l10n.t('Clear usage data')}</button></div></section>
<section id="diagnostics"><h1>${vscode.l10n.t('Diagnostics')}</h1><p class="lead">${vscode.l10n.t('Nika writes to a native output channel and never creates an automatic log file.')}</p><div class="card">${this._selectRow('logLevel', vscode.l10n.t('Log level'), ['DEBUG', 'INFO', 'WARN', 'ERROR'].map(v => [v, v]))}${this._checkboxRow('releaseCheckEnabled', vscode.l10n.t('Check for releases on startup'))}</div><div class="actions"><button class="action" data-action="openLogs">${vscode.l10n.t('Open Nika Output')}</button><button class="action secondary" data-action="exportDiagnostics">${vscode.l10n.t('Export Diagnostics')}</button><button class="action secondary" data-action="checkUpdates">${vscode.l10n.t('Check for Updates')}</button></div></section>
</main></div><script nonce="${token}">const vscode=acquireVsCodeApi();const state=${encoded};
const settings=state.settings;let activeSection;document.getElementById('app-version').textContent=state.appVersion;document.getElementById('extension-version').textContent=state.extensionVersion;
function status(id,configured){const result=state.connections[id];const text=result?(result.ok?${JSON.stringify(vscode.l10n.t('Connected'))}:result.message):(configured?${JSON.stringify(vscode.l10n.t('Configured'))}:${JSON.stringify(vscode.l10n.t('Not configured'))});const good=result?result.ok:configured;document.querySelectorAll('[data-provider-status="'+id+'"]').forEach(target=>{target.innerHTML='<span class="pill '+(good?'ok':'')+'"><span class="dot"></span></span> ';target.append(document.createTextNode(text));});}
// --- Provider wizard (Add Provider flow + provider cards) ---
const providerLabels={deepseek:'DeepSeek',gemini:'Gemini',ollama:'Ollama',openrouter:'OpenRouter',llamacpp:'llama.cpp',cursor:'Cursor',deepseekweb:'DeepSeek Web'};
const providerOrder=['deepseek','gemini','ollama','openrouter','llamacpp','cursor','deepseekweb'];
const providerHints={deepseek:'Flash, Pro, and experimental Responses',gemini:'Every Gemini model on the Google catalog',ollama:'Models pulled on the configured Ollama host (ollama pull <name> to add more)',openrouter:'The full catalog at OpenRouter prices',llamacpp:'Models loaded on the configured llama.cpp server',cursor:'Cursor API models billed to your Cursor account',deepseekweb:'DeepSeek chat via the web API; images upload automatically'};
const providerModels=state.providerModels||{};
const providerConfig=state.providers||{};
const providersManaged=!!state.providersManaged;
const providersConfigured=state.providersConfigured||{};
providerOrder.forEach(id=>status(id,!!providersConfigured[id]));
function wizardState(){return (vscode.getState()||{}).wizard||null;}
function setWizard(w){const saved=vscode.getState()||{};vscode.setState({...saved,wizard:w});}
function modelNameFor(provider,id){
  let key=id;
  ['deepseekweb/','gemini/','cursor/','openrouter/','ollama/','llamacpp/'].forEach(p=>{if(key.indexOf(p)===0){key=key.slice(p.length);}});
  const list=providerModels[provider]||[];
  const entry=list.find(m=>m.id===key)||list.find(m=>m.id===id);
  return entry?(entry.name||key):id;
}
function renderProviderCards(){
  document.querySelectorAll('[data-provider-cards]').forEach(host=>{
    if(!providersManaged){host.innerHTML='';return;}
    const ids=providerOrder.filter(id=>providerConfig[id]);
    if(!ids.length){host.innerHTML='<div class="empty">'+esc('No providers added yet. Use Add Provider to bring in the models you want.')+'</div>';return;}
    host.innerHTML=ids.map(id=>{
      const models=providerConfig[id].models||[];
      const chips=models.map(m=>'<span class="pill">'+esc(modelNameFor(id,m))+'</span>').join('');
      const count=models.length===0?'0 models':(models.length===1?'1 model':models.length+' models');
      return '<div class="card"><div class="row"><label><strong>'+esc(providerLabels[id])+'</strong><span class="hint">'+count+' &middot; <span data-provider-status="'+id+'"></span></span></label><div class="controls wrap"><button class="action secondary" data-manage-models="'+id+'">'+esc('Manage models')+'</button><button class="action secondary" data-secret-test="'+id+'">'+esc('Test')+'</button><button class="action danger" data-remove-provider="'+id+'">'+esc('Remove')+'</button></div></div>'+(chips?'<div class="controls wrap">'+chips+'</div>':'')+'</div>';
    }).join('');
    ids.forEach(id=>status(id,true));
  });
}
function wizardStepHtml(){
  const w=wizardState();if(!w){return '';}
  const label=providerLabels[w.provider]||'';
  let html='<h2>'+esc(w.step==='pick'?'Add Provider':(w.step==='models'?label+' &middot; Select models':label))+'</h2>';
  if(w.step==='pick'){
    const available=providerOrder.filter(id=>!providersManaged||!providerConfig[id]);
    html+=available.length?available.map(id=>'<div class="row"><label><strong>'+esc(providerLabels[id])+'</strong><span class="hint">'+esc(providerHints[id]||'')+'</span></label><div><button class="action secondary" data-wizard-pick="'+id+'">'+esc('Select')+'</button></div></div>').join(''):'<p class="hint">'+esc('All providers are already added.')+'</p>';
    return html;
  }
  if(w.step==='config'){
    if(w.provider==='ollama'){
      html+='<div class="row"><label for="wizardOllamaUrl"><strong>'+esc('Ollama host')+'</strong><span class="hint">'+esc('The host that runs Ollama.')+'</span></label><div class="controls"><input id="wizardOllamaUrl" type="text" value="'+esc(settings.ollamaBaseUrl||'http://localhost:11434')+'"><button class="action" data-wizard-next>'+esc('Save & Next')+'</button></div></div>';
    }else if(w.provider==='llamacpp'){
      html+='<div class="row"><label for="wizardLlamaCppUrl"><strong>'+esc('llama.cpp host')+'</strong><span class="hint">'+esc('The OpenAI-compatible llama.cpp server (default http://localhost:8080).')+'</span></label><div class="controls"><input id="wizardLlamaCppUrl" type="text" value="'+esc(state.llamaCppBaseUrl||'http://localhost:8080')+'"><button class="action" data-wizard-next>'+esc('Save & Next')+'</button></div></div>';
      html+='<div class="row"><label><strong>'+esc('llama.cpp API key (optional)')+'</strong><span class="hint">'+esc('Leave empty for no authentication.')+'</span></label><div class="controls"><input type="password" autocomplete="off" id="wizardLlamaCppKey" placeholder="'+esc('Paste your API key')+'"></div></div>';
    }else{
      html+='<div class="row"><label><strong>'+esc(providerLabels[w.provider]+' API key')+'</strong><span class="hint">'+esc(w.provider==='cursor'?'Create a Cursor API key at cursor.com/settings/api-keys. Stored securely; never read back into this page.':(w.provider==='deepseekweb'?'Sign in at chat.deepseek.com, then import your userToken: on desktop use “Import token from browser”; on web paste the value from the browser console (JSON.parse(localStorage.getItem("userToken")).value). Stored securely; never read back into this page.':'Stored securely in Secret Storage; never read back into this page.'))+'</span></label><div class="controls"><input type="password" autocomplete="off" id="wizardKey" placeholder="'+esc(w.provider==='deepseekweb'?'Paste your userToken':'Paste your API key')+'"><button class="action" data-wizard-next>'+esc('Save & Next')+'</button></div></div>';
      if(w.provider==='deepseekweb'){
        html+='<div class="actions"><button class="action secondary" data-wizard-web-signin>'+esc('Sign in in browser')+'</button><button class="action secondary" data-wizard-web-import>'+esc('Import token from browser')+'</button></div>';
      }
    }
    html+='<div class="actions"><button class="action secondary" data-wizard-back>'+esc('Back')+'</button></div>';
    return html;
  }
  const list=providerModels[w.provider]||[];
  if((w.provider==='openrouter'||w.provider==='gemini'||w.provider==='cursor')&&list.length>0){html+='<div class="controls"><input type="text" data-wizard-filter placeholder="'+esc('Filter models…')+'"></div>';}
  if(!list.length&&w.provider==='openrouter'){html+='<p class="hint">'+esc('No catalog models available. Check that the OpenRouter key is valid.')+'</p>';}
  if(!list.length&&w.provider==='gemini'){html+='<p class="hint">'+esc('No catalog models available. Check that the Gemini API key is valid.')+'</p>';}
  if(!list.length&&w.provider==='cursor'){html+='<p class="hint">'+esc('No catalog models available. Check that the Cursor API key is valid.')+'</p>';}
  if(!list.length&&(w.provider==='ollama'||w.provider==='llamacpp')){html+='<p class="hint">'+esc('No models found. Is the server running with models loaded? For Ollama, run ollama pull <model> to add one.')+'</p>';}
  html+='<div data-wizard-model-list></div>';
  html+='<div class="actions"><button class="action secondary" data-wizard-back>'+esc('Back')+'</button><button class="action secondary" data-wizard-test>'+esc('Test connection')+'</button><button class="action" data-wizard-done>'+esc('Done')+'</button></div>';
  return html;
}
function renderWizardModelList(filterValue){
  const w=wizardState();if(!w){return;}
  const list=providerModels[w.provider]||[];
  const q=((filterValue||'').toLowerCase());
  const shown=list.filter(m=>!q||String(m.id||'').toLowerCase().indexOf(q)>=0||String(m.name||'').toLowerCase().indexOf(q)>=0);
  const selected=w.models||[];
  const boxes=shown.map(m=>'<label class="row" style="cursor:pointer"><span><strong>'+esc(m.name||m.id)+'</strong><span class="hint">'+esc(m.id)+'</span></span><input type="checkbox" data-wizard-model="'+esc(m.id)+'"'+(selected.indexOf(m.id)>=0?' checked':'')+'></label>').join('');
  document.querySelectorAll('[data-wizard-model-list]').forEach(el=>{el.innerHTML=boxes?boxes:'<div class="empty">'+esc('No models match the filter.')+'</div>';});
}
function renderWizard(){
  document.querySelectorAll('[data-wizard]').forEach(host=>{
    const w=wizardState();
    host.innerHTML=w?wizardStepHtml():'';
    if(w&&w.step==='models'){renderWizardModelList('');}
  });
}
renderProviderCards();renderWizard();
document.querySelectorAll('[data-wizard-add]').forEach(btn=>btn.addEventListener('click',()=>{setWizard({step:'pick'});renderWizard();}));
document.addEventListener('click',e=>{
  const pick=e.target.closest('[data-wizard-pick]');
  if(pick){setWizard({provider:pick.dataset.wizardPick,step:'config'});renderWizard();return;}
  const back=e.target.closest('[data-wizard-back]');
  if(back){const w=wizardState();if(!w)return;setWizard({provider:w.provider,step:w.step==='config'?'pick':'config',models:w.models||[]});renderWizard();return;}
  const next=e.target.closest('[data-wizard-next]');
  if(next){const w=wizardState();if(!w)return;
    if(w.provider==='ollama'){const input=document.getElementById('wizardOllamaUrl');post({type:'saveSetting',key:'ollamaBaseUrl',value:input?input.value:'http://localhost:11434'});}
    else if(w.provider==='llamacpp'){const host=document.getElementById('wizardLlamaCppUrl');post({type:'saveSetting',key:'llamaCppBaseUrl',value:host?host.value:'http://localhost:8080'});const key=document.getElementById('wizardLlamaCppKey');if(key&&key.value.trim()){post({type:'saveSecret',provider:'llamacpp',value:key.value});}}
    else{const input=document.getElementById('wizardKey');post({type:'saveSecret',provider:w.provider,value:input?input.value:''});}
    setWizard({provider:w.provider,step:'models',models:[]});
    return;
  }
  const test=e.target.closest('[data-wizard-test]');
  if(test){const w=wizardState();if(w){post({type:'testConnection',provider:w.provider});}return;}
  const signin=e.target.closest('[data-wizard-web-signin]');
  if(signin){post({type:'deepSeekWebSignIn'});return;}
  const webimport=e.target.closest('[data-wizard-web-import]');
  if(webimport){post({type:'deepSeekWebImportToken'});return;}
  const done=e.target.closest('[data-wizard-done]');
  if(done){const w=wizardState();if(!w)return;
    const boxes=document.querySelectorAll('[data-wizard-model]:checked');
    const models=Array.prototype.map.call(boxes,b=>b.dataset.wizardModel);
    setWizard(null);
    post({type:'saveProviderConfig',provider:w.provider,models:models});
    return;
  }
  const manage=e.target.closest('[data-manage-models]');
  if(manage){const id=manage.dataset.manageModels;const existing=providerConfig[id]?providerConfig[id].models:[];setWizard({provider:id,step:'models',models:existing.slice()});renderWizard();renderWizardModelList('');return;}
  const remove=e.target.closest('[data-remove-provider]');
  if(remove){post({type:'removeProvider',provider:remove.dataset.removeProvider});}
});
document.addEventListener('change',e=>{
  const box=e.target.closest('[data-wizard-model]');
  if(!box){return;}
  const w=wizardState();if(!w){return;}
  const models=w.models||[];
  const idx=models.indexOf(box.dataset.wizardModel);
  if(box.checked&&idx<0){models.push(box.dataset.wizardModel);}
  if(!box.checked&&idx>=0){models.splice(idx,1);}
  setWizard({provider:w.provider,step:'models',models:models});
});
document.addEventListener('input',e=>{
  const f=e.target.closest('[data-wizard-filter]');
  if(f){renderWizardModelList(f.value);}
});
function renderIndexing(){const i=state.indexing||{};const labels={idle:'Idle',building:'Building',indexing:'Indexing',synced:'Synced',error:'Error'};const s=i.status||'idle';document.querySelectorAll('[data-indexing-status]').forEach(el=>el.textContent=labels[s]||s);document.querySelectorAll('[data-indexing-progress]').forEach(el=>{el.textContent=(typeof i.indexedFileCount==='number'&&typeof i.totalFileCount==='number')?i.indexedFileCount+' / '+i.totalFileCount:'';});document.querySelectorAll('[data-indexing-error]').forEach(el=>{el.textContent=i.lastError||'';});document.querySelectorAll('[data-indexing-message]').forEach(el=>{el.textContent=i.message||'';});document.querySelectorAll('[data-indexing-scope]').forEach(el=>{el.textContent=i.workspaceOverride?'Workspace':'Default';});}renderIndexing();
document.querySelectorAll('[data-setting]').forEach(el=>{const key=el.dataset.setting;if(el.type==='checkbox')el.checked=Boolean(settings[key]);else el.value=String(settings[key]??'');el.addEventListener('change',()=>{let value=el.type==='checkbox'?el.checked:(el.type==='number'?Number(el.value):el.value);post({type:'saveSetting',key,value});});});
const effortLabels={none:'None',low:'Low',medium:'Medium',high:'High',max:'Max'};
function modelEfforts(modelId){const m=(state.modelChoices||[]).find(x=>x.id===modelId);return (m&&m.efforts)||[];}
function refreshEffortSelect(select,modelId,currentValue){const efforts=modelEfforts(modelId);const hasCurrent=efforts.includes(currentValue);const fallback=hasCurrent?'':'<option value="'+esc(currentValue)+'">'+esc(currentValue)+'</option>';select.innerHTML=fallback+efforts.map(e=>'<option value="'+e+'">'+(effortLabels[e]||e)+'</option>').join('');select.disabled=efforts.length===0;select.value=hasCurrent?currentValue:(efforts[0]||currentValue);}
// When the default model changes, refresh the default thinking-effort options
// client-side so they always match the selected model's capabilities.
const defaultModelSelect=document.getElementById('defaultModel');
const thinkingEffortSelect=document.getElementById('thinkingEffort');
if(defaultModelSelect&&thinkingEffortSelect){defaultModelSelect.addEventListener('change',()=>{refreshEffortSelect(thinkingEffortSelect,defaultModelSelect.value,settings.thinkingEffort||'high');});}
// Agent rows: refresh each role's effort select when its model select changes.
document.querySelectorAll('[data-setting^="agent."]').forEach(el=>{const key=el.dataset.setting;if(key.endsWith('ThinkingEffort'))return;const role=key.slice('agent.'.length);const effortEl=document.getElementById('agent.'+role+'ThinkingEffort');if(effortEl){el.addEventListener('change',()=>{refreshEffortSelect(effortEl,el.value,settings['agent.'+role+'ThinkingEffort']||'high');});}});
function activateSection(id){const button=document.querySelector('nav button[data-section="'+id+'"]');const section=document.getElementById(id);if(!button||!section)return;document.querySelectorAll('nav button,section').forEach(el=>el.classList.remove('active'));button.classList.add('active');section.classList.add('active');activeSection=id;const saved=vscode.getState()||{};vscode.setState({...saved,activeSection:id});}
const restoredSection=(vscode.getState()||{}).activeSection;activateSection(restoredSection||state.initialSection||'overview');document.querySelectorAll('[data-section]').forEach(button=>button.addEventListener('click',()=>activateSection(button.dataset.section)));
function post(message){vscode.postMessage({...message,activeSection});}
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>post({type:button.dataset.action})));
document.querySelectorAll('[data-secret-save]').forEach(button=>button.addEventListener('click',()=>{const provider=button.dataset.secretSave;const input=document.querySelector('[data-secret="'+provider+'"]');post({type:'saveSecret',provider,value:input.value});input.value='';}));
document.querySelectorAll('[data-secret-test]').forEach(button=>button.addEventListener('click',()=>post({type:'testConnection',provider:button.dataset.secretTest})));
document.querySelectorAll('[data-secret-remove]').forEach(button=>button.addEventListener('click',()=>post({type:'removeSecret',provider:button.dataset.secretRemove})));
function fmtTok(n){if(n>=1e6)return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M';if(n>=1e3)return (n/1e3).toFixed(1).replace(/\.0$/,'')+'k';return String(n||0);}
function fmtCost(c){if(!c||c<=0)return '$0';if(c<0.01)return '$'+c.toFixed(4).replace(/0+$/,'');if(c<100)return '$'+c.toFixed(2);return '$'+c.toFixed(0);}
function fmtDuration(ms){ms=Math.max(0,ms);const s=Math.floor(ms/1000);const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);if(h>0)return m>0?h+'h '+m+'m':h+'h';if(m>0)return m+'m';return '<1m';}
function renderRateCountdown(){const el=document.getElementById('usage-rate-countdown');if(!el)return;const u=state.usage||{};if((u.lastProvider||'deepseek')!=='deepseek'){el.textContent='—';return;}const r=u.rate||{};if(typeof r.endsAt!=='number'){el.textContent='—';return;}const left=r.endsAt-Date.now();el.textContent=(r.nextIsPeak?'PEAK in ':'OFF-PEAK in ')+fmtDuration(left);}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderUsage(){
  const u=state.usage||{};const daily=u.daily||[];
  const peakEl=document.getElementById('usage-peak-badge');
  const lastProvider=u.lastProvider||'deepseek';
  if(peakEl){
    if(lastProvider==='deepseek'){const peak=u.peak;peakEl.innerHTML='<span class="peak-badge'+(peak?' peak':'')+'"><span class="dot"></span>'+(peak?'PEAK':'OFF-PEAK')+'</span>';}
    else{const label=lastProvider==='openrouter'?'OpenRouter':lastProvider==='gemini'?'Gemini':lastProvider==='llamacpp'?'llama.cpp':lastProvider==='cursor'?'Cursor':'Ollama';peakEl.innerHTML='<span class="peak-badge"><span class="dot"></span>'+label+'</span>';}
  }
  renderRateCountdown();
  document.getElementById('usage-today-tokens').textContent=fmtTok(u.todayTokens);
  document.getElementById('usage-today-cost').textContent=fmtCost(u.todayCost);
  document.getElementById('usage-total-tokens').textContent=fmtTok(u.totalTokens);
  document.getElementById('usage-total-cost').textContent=fmtCost(u.totalCost);
  document.querySelectorAll('[data-usage-openrouter]').forEach(el=>{const rows=(u.openRouterModels||[]).map(m=>'<tr><td>'+esc(m.model)+'</td><td>'+esc(m.priceLabel)+'</td><td class="num">'+m.requests+'</td><td class="num">'+fmtTok(m.totalTokens)+'</td><td class="num">'+fmtCost(m.cost)+'</td></tr>').join('');el.innerHTML=rows?'<table class="usage"><thead><tr><th>Model</th><th>Catalog price</th><th>Req</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>'+rows+'</tbody></table>':'<div class="empty">No OpenRouter usage yet.</div>';});
  const now=new Date();const days=[];
  for(let i=13;i>=0;i--){const d=new Date(now.getTime()-i*86400000);const key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');const rec=daily.find(x=>x.date===key);days.push({key,label:key.slice(5),total:rec?rec.totalTokens:0,cost:rec?rec.cost:0});}
  const max=Math.max(1,...days.map(d=>d.total));const W=640,H=180,P=26,bw=W/days.length,inner=H-P*2;
  const barColor='color-mix(in srgb,var(--vscode-foreground) 55%,transparent)';
  const bars=days.map((d,i)=>{const h=Math.max(2,d.total/max*inner);const x=i*bw+5,y=H-P-h;return '<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+(bw-10).toFixed(1)+'" height="'+h.toFixed(1)+'" rx="2" fill="'+barColor+'"><title>'+d.key+': '+fmtTok(d.total)+' tokens · '+fmtCost(d.cost)+'</title></rect>';}).join('');
  const labels=days.map((d,i)=>'<text x="'+(i*bw+bw/2).toFixed(1)+'" y="'+(H-P+16)+'" text-anchor="middle" font-size="10" fill="var(--vscode-descriptionForeground)">'+d.label+'</text>').join('');
  document.querySelectorAll('[data-usage-chart]').forEach(el=>{el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Nika tokens per day (last 14 days)">'+bars+labels+'</svg>';});
  document.querySelectorAll('[data-usage-sessions]').forEach(el=>{const rows=(u.sessions||[]).map(s=>'<tr><td>'+(s.title?esc(s.title):'<span class="empty">Untitled session</span>')+'</td><td>'+(s.workspace?esc(s.workspace):'—')+'</td><td class="num">'+s.requests+'</td><td class="num">'+fmtTok(s.totalTokens)+'</td><td class="num">'+fmtCost(s.cost)+'</td><td class="num">'+new Date(s.end).toLocaleDateString()+'</td></tr>').join('');el.innerHTML=rows?'<table class="usage"><thead><tr><th>Session</th><th>Workspace</th><th>Req</th><th>Tokens</th><th>Cost</th><th>Last</th></tr></thead><tbody>'+rows+'</tbody></table>':'<div class="empty">No sessions recorded yet.</div>';});
  document.querySelectorAll('[data-usage-workspaces]').forEach(el=>{const rows=(u.workspaces||[]).map(w=>'<tr><td>'+esc(w.workspace)+'</td><td class="num">'+w.sessions+'</td><td class="num">'+w.requests+'</td><td class="num">'+fmtTok(w.totalTokens)+'</td><td class="num">'+fmtCost(w.cost)+'</td></tr>').join('');el.innerHTML=rows?'<table class="usage"><thead><tr><th>Workspace</th><th>Sessions</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>'+rows+'</tbody></table>':'<div class="empty">No workspace usage yet.</div>';});
  document.querySelectorAll('[data-usage-messages]').forEach(el=>{const rows=(u.messages||[]).map(m=>'<tr><td>'+new Date(m.t).toLocaleString()+'</td><td>'+esc(m.model)+'</td><td class="num">'+fmtTok(m.totalTokens)+'</td><td class="num">'+fmtCost(m.cost)+'</td><td>'+(m.provider==='openrouter'?'<span class="pill">catalog</span>':(m.peak?'<span class="pill">PEAK</span>':'<span class="pill">off</span>'))+'</td><td>'+(m.error?'<span style="color:var(--vscode-errorForeground)">error</span>':'')+'</td></tr>').join('');el.innerHTML=rows?'<table class="usage"><thead><tr><th>Time</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Rate</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>':'<div class="empty">No requests yet.</div>';});
}
renderUsage();
const openRouterFilter=document.querySelector('[data-openrouter-filter]');
function renderOpenRouterCatalog(){
  const hosts=document.querySelectorAll('[data-openrouter-catalog]');if(!hosts.length)return;
  const q=((openRouterFilter&&openRouterFilter.value)||'').toLowerCase();
  const list=(state.openrouterModels||[]).filter(m=>!q||m.id.toLowerCase().includes(q)||m.name.toLowerCase().includes(q));
  const shown=list.slice(0,100);
  const chips=m=>{const c=[];if(m.free)c.push('<span class="pill">free</span>');if(m.vision)c.push('<span class="pill">vision</span>');if(m.toolCalling)c.push('<span class="pill">tools</span>');if(m.reasoning)c.push('<span class="pill">reasoning</span>');return c.join(' ');};
  const rows=shown.map(m=>'<tr><td><button class="action" data-openrouter-default="'+esc(m.id)+'">'+esc(m.id)+'</button></td><td>'+esc(m.name)+'</td><td class="num">'+fmtTok(m.contextWindow)+'</td><td>'+esc(m.priceLabel||'—')+'</td><td>'+chips(m)+'</td></tr>').join('');
  hosts.forEach(el=>{el.innerHTML=rows?'<table class="usage"><thead><tr><th>Model id</th><th>Name</th><th>Context</th><th>Price (per 1M)</th><th>Caps</th></tr></thead><tbody>'+rows+'</tbody></table>'+(list.length>100?'<p class="hint">Showing the first 100 matches — refine the filter.</p>':''):'<div class="empty">No models match the filter.</div>';});
}
if(openRouterFilter){openRouterFilter.addEventListener('input',renderOpenRouterCatalog);renderOpenRouterCatalog();}
document.addEventListener('click',e=>{const btn=e.target.closest('[data-openrouter-default]');if(btn){post({type:'setOpenRouterDefault',model:btn.dataset.openrouterDefault});}});
const visionOptions=(state.openrouterModels||[]).filter(m=>m.vision).map(m=>'<option value="'+esc(m.id)+'">').join('');
document.querySelectorAll('#openrouter-vision-models').forEach(el=>{el.innerHTML=visionOptions;});
// Auto-fill the OpenRouter vision model from the default model when it is a
// vision-capable OpenRouter model and the field is empty.
(function autoFillVisionOpenRouter(){
  const input=document.getElementById('visionOpenRouterModel');if(!input||input.value)return;
  const defaultModel=settings.defaultModel||'';
  const prefix='nika/openrouter/';
  if(defaultModel.startsWith(prefix)){
    const raw=defaultModel.slice(prefix.length);
    const m=(state.openrouterModels||[]).find(x=>x.id===raw);
    if(m&&m.vision){input.value=raw;}
  }
})();
if(window.__rateTimer)clearInterval(window.__rateTimer);
window.__rateTimer=setInterval(renderRateCountdown,1000);
</script></body></html>`;
	}

	private _selectRow(key: string, label: string, options: string[][]): string {
		return `<div class="row"><label for="${key}"><strong>${label}</strong></label><select id="${key}" data-setting="${key}">${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></div>`;
	}

	private _textRow(key: string, label: string): string {
		return `<div class="row"><label for="${key}"><strong>${label}</strong></label><input id="${key}" data-setting="${key}" type="text"></div>`;
	}

	private _numberRow(key: string, label: string, min: string, max: string, step: string): string {
		return `<div class="row"><label for="${key}"><strong>${label}</strong></label><input id="${key}" data-setting="${key}" type="number" min="${min}" max="${max}" step="${step}"></div>`;
	}

	private _checkboxRow(key: string, label: string): string {
		return `<div class="row"><label for="${key}"><strong>${label}</strong></label><input id="${key}" data-setting="${key}" type="checkbox"></div>`;
	}

	/** Typed view of the flattened `modelChoices` state array. */
	private _modelChoices(state: Record<string, unknown>): { id: string; displayName: string; provider: string; vision: boolean; efforts: string[]; vendor?: string; contextWindow?: number; priceLabel?: string; free?: boolean }[] {
		return (state.modelChoices as unknown[]) as { id: string; displayName: string; provider: string; vision: boolean; efforts: string[]; vendor?: string; contextWindow?: number; priceLabel?: string; free?: boolean }[];
	}

	/**
	 * Overview-page status rows. Managed mode lists only the added providers;
	 * legacy mode keeps the classic five rows so nothing disappears for users
	 * who have not used the wizard yet.
	 */
	private _overviewProviderRows(state: Record<string, unknown>): string {
		const labels: Record<string, [string, string]> = {
			deepseek: [vscode.l10n.t('DeepSeek'), vscode.l10n.t('Flash, Pro, and experimental Responses')],
			gemini: [vscode.l10n.t('Gemini'), vscode.l10n.t('Every Gemini model on the Google catalog')],
			openrouter: [vscode.l10n.t('OpenRouter'), vscode.l10n.t('The full model catalog at OpenRouter prices')],
			ollama: [vscode.l10n.t('Ollama'), vscode.l10n.t('Models pulled on the configured host')],
			llamacpp: [vscode.l10n.t('llama.cpp'), vscode.l10n.t('Models loaded on the configured llama.cpp server')],
			cursor: [vscode.l10n.t('Cursor'), vscode.l10n.t('Cursor API models billed to your Cursor account')],
		};
		const configured = (state.providersConfigured ?? {}) as Record<string, boolean>;
		const ids = state.providersManaged
			? Object.keys(configured).filter(id => configured[id])
			: ['deepseek', 'gemini', 'openrouter', 'ollama', 'llamacpp', 'cursor'];
		if (ids.length === 0) {
			return `<div class="empty">${vscode.l10n.t('No providers added yet.')}</div>`;
		}
		return ids.map(id => {
			const [label, hint] = labels[id] ?? [id, ''];
			return `<div class="row"><label><strong>${label}</strong><span class="hint">${hint}</span></label><span data-provider-status="${id}"></span></div>`;
		}).join('');
	}

	private _providerLabel(provider: string): string {
		switch (provider) {
			case 'deepseek': return vscode.l10n.t('DeepSeek');
			case 'gemini': return vscode.l10n.t('Gemini');
			case 'gemma': return vscode.l10n.t('Ollama');
			case 'openrouter': return vscode.l10n.t('OpenRouter');
			case 'llamacpp': return vscode.l10n.t('llama.cpp');
			case 'cursor': return vscode.l10n.t('Cursor');
			default: return provider;
		}
	}

	private _providerPill(provider: string): string {
		return `<span class="pill">${this._providerLabel(provider)}</span>`;
	}

	/**
	 * Clamp a requested effort to the nearest supported level. The effort
	 * magnitudes are ordered `none < low < medium < high < max`; when the
	 * requested value is unsupported we pick the closest supported level,
	 * preferring the next-higher one when equidistant (so a `max` request on a
	 * model that tops out at `high` becomes `high`, not `low`).
	 */
	private _clampEffort(requested: string, supported: string[]): string {
		const order = ['none', 'low', 'medium', 'high', 'max'];
		const target = order.indexOf(requested);
		if (target === -1 || supported.length === 0) {
			return requested;
		}
		if (supported.includes(requested)) {
			return requested;
		}
		let best = supported[0];
		let bestDist = Number.POSITIVE_INFINITY;
		for (const level of supported) {
			const dist = Math.abs(order.indexOf(level) - target);
			if (dist < bestDist || (dist === bestDist && order.indexOf(level) > order.indexOf(best))) {
				best = level;
				bestDist = dist;
			}
		}
		return best;
	}

	/**
	 * Effort `<option>` pairs for a model id, derived from its capability list
	 * (empty for models with no effort control). Labels are localized.
	 */
	private _effortOptionsForModel(state: Record<string, unknown>, modelId: string): string[][] {
		const model = this._modelChoices(state).find(m => m.id === modelId);
		const efforts = model?.efforts ?? [];
		const labels: Record<string, string> = {
			none: vscode.l10n.t('None'),
			low: vscode.l10n.t('Low'),
			medium: vscode.l10n.t('Medium'),
			high: vscode.l10n.t('High'),
			max: vscode.l10n.t('Max'),
		};
		return efforts.map(e => [e, labels[e] ?? e]);
	}

	/**
	 * A model `<select>` populated from `modelChoices` (key-gated native models
	 * + OpenRouter catalog). The current value is always included as a fallback
	 * option so the dropdown never renders blank, and a provider pill is shown
	 * next to the select.
	 */
	private _modelSelectRow(key: string, label: string, state: Record<string, unknown>, currentValue: string): string {
		const choices = this._modelChoices(state);
		const options = choices.map(m => `<option value="${m.id}">${m.displayName}</option>`).join('');
		const hasCurrent = choices.some(m => m.id === currentValue);
		const fallback = hasCurrent ? '' : `<option value="${currentValue}">${currentValue}</option>`;
		const currentProvider = choices.find(m => m.id === currentValue)?.provider;
		const pill = currentProvider ? this._providerPill(currentProvider) : '';
		return `<div class="row"><label for="${key}"><strong>${label}</strong></label><div class="controls"><select id="${key}" data-setting="${key}">${fallback}${options}</select>${pill}</div></div>`;
	}

	/**
	 * An effort `<select>` whose options derive from the given model's
	 * capability list. When the model has no effort control, the select is
	 * disabled with a hint. The current value is always included as a fallback
	 * option so it never renders blank.
	 */
	private _effortSelectRow(key: string, label: string, state: Record<string, unknown>, modelId: string, currentValue: string): string {
		const options = this._effortOptionsForModel(state, modelId);
		const hasCurrent = options.some(([value]) => value === currentValue);
		const fallback = hasCurrent ? '' : `<option value="${currentValue}">${currentValue}</option>`;
		const disabled = options.length === 0 ? ' disabled' : '';
		const hint = options.length === 0 ? `<span class="hint">${vscode.l10n.t('This model does not support a thinking-effort setting.')}</span>` : '';
		return `<div class="row"><label for="${key}"><strong>${label}</strong>${hint}</label><select id="${key}" data-setting="${key}"${disabled}>${fallback}${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></div>`;
	}

	/**
	 * The image-description backend select. Options are the vision-capable
	 * models fetched from the configured providers — the same lineup shown on
	 * the Models page: native models plus the wizard-selected catalog models
	 * (managed mode) or the key-gated natives/catalogs (legacy mode). Each
	 * entry stores the model id (`nika/…`) so `_describeMedia` can route to
	 * the right provider. A `none` option ("None (native vision)") is offered
	 * only when the default model supports native image input, and `vscode`
	 * lets users type any other VS Code vision model.
	 */
	private _visionBackendRow(state: Record<string, unknown>, currentValue: string): string {
		const defaultModel = String((state.settings as Record<string, unknown>).defaultModel ?? NIKA_RESPONSES_MODEL);
		const choices = this._modelChoices(state);
		// DeepSeek advertises media input only so Copilot preserves attachments
		// for Nika's text conversion — it cannot describe images itself, so it
		// never counts as a vision backend or as natively vision-capable.
		const defaultModelEntry = choices.find(m => m.id === defaultModel);
		const defaultModelVision = (defaultModelEntry?.vision ?? false) && defaultModelEntry?.provider !== 'deepseek';
		const options: string[][] = [];
		if (defaultModelVision) {
			options.push(['none', vscode.l10n.t('None (native vision)')]);
		}
		const seen = new Set<string>();
		for (const model of choices) {
			if (!model.vision || model.provider === 'deepseek' || seen.has(model.id)) {
				continue;
			}
			seen.add(model.id);
			const providerLabel = this._providerLabel(model.provider);
			const hasProviderInName = providerLabel && model.displayName.toLowerCase().includes(providerLabel.toLowerCase());
			options.push([model.id, hasProviderInName ? model.displayName : `${model.displayName} (${providerLabel})`]);
		}
		options.push(['vscode', vscode.l10n.t('Another VS Code vision model')]);
		const hasCurrent = options.some(([value]) => value === currentValue);
		const fallback = hasCurrent ? '' : `<option value="${currentValue}">${currentValue}</option>`;
		const hint = defaultModelVision
			? vscode.l10n.t('Your default model supports images natively — you can turn preprocessing off.')
			: vscode.l10n.t('Your default model is text-only, so images are described by this backend first.');
		return `<div class="row"><label for="visionModel"><strong>${vscode.l10n.t('Image-description backend')}</strong><span class="hint">${hint}</span></label><select id="visionModel" data-setting="visionModel">${fallback}${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></div>`;
	}

	private _agentRow(role: 'plan' | 'explore' | 'utility' | 'utilitySmall' | 'inlineChat', label: string, state: Record<string, unknown>): string {
		const modelKey = `agent.${role}`;
		const effortKey = `agent.${role}ThinkingEffort`;
		const currentModel = String((state.settings as Record<string, unknown>)[modelKey] ?? NIKA_RESPONSES_MODEL);
		const currentEffort = String((state.settings as Record<string, unknown>)[effortKey] ?? 'high');
		const modelOptions = this._modelChoices(state).map(m => `<option value="${m.id}">${m.displayName}</option>`).join('');
		const effortOptions = this._effortOptionsForModel(state, currentModel);
		const hasCurrentEffort = effortOptions.some(([value]) => value === currentEffort);
		const effortFallback = hasCurrentEffort ? '' : `<option value="${currentEffort}">${currentEffort}</option>`;
		const effortDisabled = effortOptions.length === 0 ? ' disabled' : '';
		return `<div class="row"><label for="${modelKey}"><strong>${label}</strong></label><div class="agent-controls"><select id="${modelKey}" aria-label="${vscode.l10n.t('{0} model', label)}" data-setting="${modelKey}">${modelOptions}</select><select id="${effortKey}" aria-label="${vscode.l10n.t('{0} thinking effort', label)}" data-setting="${effortKey}"${effortDisabled}>${effortFallback}${effortOptions.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></div></div>`;
	}
}
