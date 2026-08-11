/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { isNikaThinkingEffort, NIKA_AGENT_DEFAULTS, NIKA_DEEPSEEK_SECRET, NIKA_GEMINI_SECRET, NIKA_RESPONSES_MODEL } from './nikaModels';

type NikaConnection = 'deepseek' | 'gemini' | 'ollama';
type NikaSettingsSection = 'overview' | 'providers' | 'models' | 'vision' | 'pdf' | 'agents' | 'diagnostics';
type ConnectionResult = { readonly ok: boolean; readonly message: string; readonly checkedAt: string };

const SETTINGS = new Set([
	'defaultModel', 'outputTokens', 'contextWindow', 'temperature', 'thinkingEffort',
	'visionModel', 'visionVSCodeModel', 'ollamaBaseUrl',
	'pdfMaxFileSizeMB', 'pdfMaxPages', 'pdfPageNotice', 'pdfSparseFallback', 'pdfSparseThreshold',
	'agent.plan', 'agent.explore', 'agent.utility', 'agent.utilitySmall', 'agent.inlineChat',
	'agent.planThinkingEffort', 'agent.exploreThinkingEffort', 'agent.utilityThinkingEffort', 'agent.utilitySmallThinkingEffort', 'agent.inlineChatThinkingEffort',
	'logLevel', 'releaseCheckEnabled',
]);

const SECRET_KEYS: Record<'deepseek' | 'gemini', string> = {
	deepseek: NIKA_DEEPSEEK_SECRET,
	gemini: NIKA_GEMINI_SECRET,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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
	private readonly _output = this._register(vscode.window.createOutputChannel(vscode.l10n.t('Nika')));
	private readonly _connections = new Map<NikaConnection, ConnectionResult>();

	constructor(
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(vscode.commands.registerCommand('nika.openSettings', () => this.open()));
		this._register(vscode.commands.registerCommand('nika.checkForUpdates', () => this.checkForUpdates(true)));
		this._register(vscode.commands.registerCommand('nika.openLogs', () => this._output.show(true)));
		this._register(vscode.commands.registerCommand('nika.exportDiagnostics', () => this.exportDiagnostics()));
		this._register(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('nika')) {
				void this._render();
			}
		}));
		this._register(this._context.secrets.onDidChange(event => {
			if (event.key === NIKA_DEEPSEEK_SECRET || event.key === NIKA_GEMINI_SECRET) {
				void this._render();
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
			const [deepseekKey, geminiKey] = await Promise.all([
				this._context.secrets.get(NIKA_DEEPSEEK_SECRET),
				this._context.secrets.get(NIKA_GEMINI_SECRET),
			]);
			if (!deepseekKey && !geminiKey) {
				this.open('providers');
				void vscode.window.showInformationMessage(vscode.l10n.t('Welcome to NikaCode. Nika Settings is open: add and test a DeepSeek key to start chatting. A Gemini key is optional for Gemini and vision features.'));
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
		this._panel = vscode.window.createWebviewPanel(
			'nika.settings',
			vscode.l10n.t('Nika Settings'),
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this._register(this._panel.webview.onDidReceiveMessage(message => this._onMessage(message)));
		this._panel.onDidDispose(() => { this._panel = undefined; });
		void this._render(initialSection ?? 'overview');
	}

	private async _render(initialSection: NikaSettingsSection = 'overview'): Promise<void> {
		if (!this._panel) {
			return;
		}
		const state = { ...await this._state(), initialSection };
		this._panel.webview.html = this._html(this._panel.webview, state);
	}

	private async _state(): Promise<Record<string, unknown>> {
		const config = vscode.workspace.getConfiguration('nika');
		const [deepseekKey, geminiKey] = await Promise.all([
			this._context.secrets.get(NIKA_DEEPSEEK_SECRET),
			this._context.secrets.get(NIKA_GEMINI_SECRET),
		]);
		const value = <T>(key: string, fallback: T): T => config.get<T>(key, fallback);
		return {
			deepseekConfigured: !!deepseekKey,
			geminiConfigured: !!geminiKey,
			appVersion: vscode.version,
			extensionVersion: String((this._context.extension.packageJSON as { version?: string }).version ?? 'unknown'),
			connections: Object.fromEntries(this._connections),
			settings: {
				defaultModel: value('defaultModel', NIKA_RESPONSES_MODEL),
				outputTokens: value('outputTokens', '8K'),
				contextWindow: value('contextWindow', '128K'),
				temperature: value('temperature', 0.7),
				thinkingEffort: value('thinkingEffort', 'high'),
				visionModel: value('visionModel', 'gemini-2.5-flash'),
				visionVSCodeModel: value('visionVSCodeModel', ''),
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
			},
		};
	}

	private async _onMessage(message: unknown): Promise<void> {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}
		try {
			switch (message.type) {
				case 'saveSetting':
					if (typeof message.key === 'string' && SETTINGS.has(message.key)) {
						await this._saveSetting(message.key, message.value);
					}
					break;
				case 'saveSecret':
					if ((message.provider === 'deepseek' || message.provider === 'gemini') && typeof message.value === 'string') {
						await this._saveSecret(message.provider, message.value);
					}
					break;
				case 'removeSecret':
					if (message.provider === 'deepseek' || message.provider === 'gemini') {
						await this._context.secrets.delete(SECRET_KEYS[message.provider]);
						this._connections.delete(message.provider);
						void vscode.window.showInformationMessage(vscode.l10n.t('{0} key removed.', message.provider === 'deepseek' ? 'DeepSeek' : 'Gemini'));
					}
					break;
				case 'testConnection':
					if (message.provider === 'deepseek' || message.provider === 'gemini' || message.provider === 'ollama') {
						await this.testConnection(message.provider);
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
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.log('ERROR', detail);
			void vscode.window.showErrorMessage(vscode.l10n.t('Nika Settings could not apply the change: {0}', detail));
		} finally {
			await this._render();
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
			throw new Error(vscode.l10n.t('Thinking effort must be None, Low, High, or Max.'));
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

	private async _saveSecret(provider: 'deepseek' | 'gemini', value: string): Promise<void> {
		const trimmed = value.trim();
		if (trimmed.length < 8) {
			throw new Error(vscode.l10n.t('Enter a valid API key before saving.'));
		}
		await this._context.secrets.store(SECRET_KEYS[provider], trimmed);
		this._connections.delete(provider);
		void vscode.window.showInformationMessage(vscode.l10n.t('{0} key saved securely.', provider === 'deepseek' ? 'DeepSeek' : 'Gemini'));
	}

	async testConnection(provider: NikaConnection): Promise<boolean> {
		let result: ConnectionResult;
		try {
			let response;
			if (provider === 'deepseek') {
				const key = await this._context.secrets.get(NIKA_DEEPSEEK_SECRET);
				if (!key) { throw new Error(vscode.l10n.t('No DeepSeek key is configured.')); }
				response = await this._fetcherService.fetch('https://api.deepseek.com/models', { method: 'GET', headers: { Authorization: `Bearer ${key}` }, callSite: 'nika-deepseek-test' });
			} else if (provider === 'gemini') {
				const key = await this._context.secrets.get(NIKA_GEMINI_SECRET);
				if (!key) { throw new Error(vscode.l10n.t('No Gemini key is configured.')); }
				response = await this._fetcherService.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { method: 'GET', headers: { 'x-goog-api-key': key }, callSite: 'nika-gemini-test' });
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
			? vscode.l10n.t('{0} connection successful.', provider === 'ollama' ? 'Ollama' : provider === 'gemini' ? 'Gemini' : 'DeepSeek')
			: vscode.l10n.t('{0} connection failed: {1}', provider === 'ollama' ? 'Ollama' : provider === 'gemini' ? 'Gemini' : 'DeepSeek', result.message));
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
input,select{width:100%;min-height:30px;padding:5px 8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px}input:focus,select:focus,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}.controls{display:flex;gap:7px;align-items:center}.controls input{flex:1}.controls button,.action{white-space:nowrap;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;padding:6px 11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}.secondary{background:var(--vscode-button-secondaryBackground)!important;color:var(--vscode-button-secondaryForeground)!important}.danger{background:transparent!important;color:var(--vscode-errorForeground)!important;border-color:var(--vscode-errorForeground)!important}.pill{display:inline-flex;gap:6px;align-items:center;padding:3px 8px;border-radius:999px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px}.dot{width:7px;height:7px;border-radius:50%;background:#ef4444}.ok .dot{background:#22c55e}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}@media(max-width:720px){.shell{display:block}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}nav{display:flex;overflow:auto}.brand{margin-bottom:14px}main{padding:28px 20px}.row{grid-template-columns:1fr;gap:8px}}
</style></head><body><div class="shell"><aside class="side"><div class="brand"><svg class="mark" viewBox="0 0 1024 1024" aria-hidden="true"><rect width="1024" height="1024" fill="#000"/><path fill="#fff" d="M510 650 163 894V670c0-18 9-35 24-45l139-92 184 117Z"/><path fill="#fff" d="M163 197 330 92v416c0 21 11 40 29 51l151 96-27 18-298-190c-14-9-22-24-22-41V197Z"/><path fill="#fff" d="m710 530 151 91v209L710 932V530Z"/><path fill="#fff" d="M330 303 710 530v252L359 568c-18-11-29-30-29-51V303Z"/><path fill="#fff" d="m601 270 260 148c0 17-9 33-24 42l-127 70-109-64V270Z"/><path fill="#fff" d="M601 270c0-7 4-14 10-18l250-144v310L601 270Z"/></svg>NikaCode</div><nav>
${[['overview', vscode.l10n.t('Overview')], ['providers', vscode.l10n.t('Providers')], ['models', vscode.l10n.t('Models')], ['vision', vscode.l10n.t('Vision')], ['pdf', vscode.l10n.t('PDF')], ['agents', vscode.l10n.t('Agents')], ['diagnostics', vscode.l10n.t('Diagnostics')]].map(([id, label], i) => `<button class="${i === 0 ? 'active' : ''}" data-section="${id}">${label}</button>`).join('')}
</nav></aside><main>
<section id="overview" class="active"><h1>${vscode.l10n.t('Nika Settings')}</h1><p class="lead">${vscode.l10n.t('Native DeepSeek, Gemini, Gemma, vision, and PDF support for NikaCode.')}</p>
<div class="card"><h2>${vscode.l10n.t('Get started')}</h2><p class="hint">${vscode.l10n.t('Set up a provider to make Nika models available in chat.')}</p><ol><li><strong>${vscode.l10n.t('Add your DeepSeek API key')}</strong> — ${vscode.l10n.t('Use DeepSeek Flash and Flash Responses for Nika chat and agents.')}</li><li><strong>${vscode.l10n.t('Optionally add your Gemini API key')}</strong> — ${vscode.l10n.t('Enable Gemini chat plus image and sparse-PDF vision features.')}</li></ol><button class="action" data-section="providers">${vscode.l10n.t('Set up providers')}</button></div>
<div class="card"><div class="row"><label><strong>${vscode.l10n.t('DeepSeek')}</strong><span class="hint">${vscode.l10n.t('Flash, Pro, and experimental Responses')}</span></label><span data-provider-status="deepseek"></span></div><div class="row"><label><strong>${vscode.l10n.t('Gemini')}</strong><span class="hint">${vscode.l10n.t('Flash and Flash Lite')}</span></label><span data-provider-status="gemini"></span></div><div class="row"><label><strong>${vscode.l10n.t('Ollama')}</strong><span class="hint">${vscode.l10n.t('Gemma 4 31B at the configured host')}</span></label><span data-provider-status="ollama"></span></div></div>
<div class="card"><div class="row"><label><strong>${vscode.l10n.t('NikaCode version')}</strong></label><span id="app-version"></span></div><div class="row"><label><strong>${vscode.l10n.t('Bundled Copilot version')}</strong></label><span id="extension-version"></span></div></div></section>
<section id="providers"><h1>${vscode.l10n.t('Set up Nika')}</h1><p class="lead">${vscode.l10n.t('Start with DeepSeek: paste the key, select Save, then select Test. Gemini is optional and enables native Gemini chat plus vision features. API keys stay in Secret Storage and are never displayed.')}</p><div class="card">
${this._secretRow('deepseek', vscode.l10n.t('1. DeepSeek API key'), vscode.l10n.t('Required for DeepSeek Flash and Flash Responses. Save the key, then test the connection.'))}${this._secretRow('gemini', vscode.l10n.t('2. Gemini API key (optional)'), vscode.l10n.t('Adds native Gemini chat and image or sparse-PDF vision.'))}${this._textRow('ollamaBaseUrl', vscode.l10n.t('Ollama host'))}${this._connectionRow('ollama', vscode.l10n.t('Ollama connection'))}
</div></section>
<section id="models"><h1>${vscode.l10n.t('Models')}</h1><p class="lead">${vscode.l10n.t('Choose defaults and request budgets. A conversation-level picker selection always wins.')}</p><div class="card">
${this._selectRow('defaultModel', vscode.l10n.t('Default model for new chats'), [['nika/deepseek-v4-flash','DeepSeek V4 Flash'],['nika/deepseek-v4-pro','DeepSeek V4 Pro'],['nika/deepseek-v4-flash-responses','DeepSeek V4 Flash (Responses)'],['nika/gemini-2.5-flash','Gemini 2.5 Flash'],['nika/gemini-2.5-flash-lite','Gemini 2.5 Flash Lite'],['nika/gemma4:31b','Gemma 4 31B']])}
${this._selectRow('outputTokens', vscode.l10n.t('Maximum output'), ['4K','8K','16K','32K','64K','128K','384K'].map(v=>[v,v]))}${this._selectRow('contextWindow', vscode.l10n.t('Input context preset'), ['32K','64K','128K','256K','512K','1M'].map(v=>[v,v]))}${this._numberRow('temperature', vscode.l10n.t('Temperature'), '0', '2', '0.1')}${this._selectRow('thinkingEffort', vscode.l10n.t('Default thinking effort'), [['none',vscode.l10n.t('None')],['low',vscode.l10n.t('Low')],['high',vscode.l10n.t('High')],['max',vscode.l10n.t('Max')]])}</div></section>
<section id="vision"><h1>${vscode.l10n.t('Vision')}</h1><p class="lead">${vscode.l10n.t('Choose the image-description backend used for text-only DeepSeek models. Provider credentials are managed on the Providers page.')}</p><div class="card">
${this._selectRow('visionModel', vscode.l10n.t('Image-description backend'), [['gemini-2.5-flash','Gemini 2.5 Flash'],['gemini-2.5-flash-lite','Gemini 2.5 Flash Lite'],['gemma4:31b','Gemma 4 31B (Ollama)'],['vscode',vscode.l10n.t('Another VS Code vision model')]])}${this._textRow('visionVSCodeModel', vscode.l10n.t('VS Code vision model identifier'))}
</div></section>
<section id="pdf"><h1>${vscode.l10n.t('PDF')}</h1><p class="lead">${vscode.l10n.t('PDF limits apply only to PDF reads. Page ranges can be requested in English or Hebrew.')}</p><div class="card">${this._numberRow('pdfMaxFileSizeMB', vscode.l10n.t('Maximum PDF size (MB)'), '1', '1024', '1')}${this._numberRow('pdfMaxPages', vscode.l10n.t('Pages without an explicit range'), '1', '1000', '1')}${this._checkboxRow('pdfPageNotice', vscode.l10n.t('Show truncation notice'))}${this._checkboxRow('pdfSparseFallback', vscode.l10n.t('Use Gemini for sparse or scanned PDFs'))}${this._numberRow('pdfSparseThreshold', vscode.l10n.t('Sparse-document character threshold'), '1', '100000', '100')}</div></section>
<section id="agents"><h1>${vscode.l10n.t('Agents')}</h1><p class="lead">${vscode.l10n.t('Assign a model and thinking effort to each built-in role. The recommended profile uses DeepSeek V4 Flash Responses for every role.')}</p><div class="card">${(['plan','explore','utility','utilitySmall','inlineChat'] as const).map(id=>this._agentRow(id, ({plan:vscode.l10n.t('Plan'),explore:vscode.l10n.t('Explore'),utility:vscode.l10n.t('Utility'),utilitySmall:vscode.l10n.t('Utility Small'),inlineChat:vscode.l10n.t('Inline Chat')} as Record<string,string>)[id])).join('')}</div><div class="actions"><button class="action" data-action="recommendedAgents">${vscode.l10n.t('Apply recommended mappings')}</button></div></section>
<section id="diagnostics"><h1>${vscode.l10n.t('Diagnostics')}</h1><p class="lead">${vscode.l10n.t('Nika writes to a native output channel and never creates an automatic log file.')}</p><div class="card">${this._selectRow('logLevel', vscode.l10n.t('Log level'), ['DEBUG','INFO','WARN','ERROR'].map(v=>[v,v]))}${this._checkboxRow('releaseCheckEnabled', vscode.l10n.t('Check for releases on startup'))}</div><div class="actions"><button class="action" data-action="openLogs">${vscode.l10n.t('Open Nika Output')}</button><button class="action secondary" data-action="exportDiagnostics">${vscode.l10n.t('Export Diagnostics')}</button><button class="action secondary" data-action="checkUpdates">${vscode.l10n.t('Check for Updates')}</button></div></section>
</main></div><script nonce="${token}">const vscode=acquireVsCodeApi();const state=${encoded};
const settings=state.settings;document.getElementById('app-version').textContent=state.appVersion;document.getElementById('extension-version').textContent=state.extensionVersion;
function status(id,configured){const result=state.connections[id];const text=result?(result.ok?${JSON.stringify(vscode.l10n.t('Connected'))}:result.message):(configured?${JSON.stringify(vscode.l10n.t('Configured'))}:${JSON.stringify(vscode.l10n.t('Not configured'))});document.querySelectorAll('[data-provider-status="'+id+'"]').forEach(target=>{target.innerHTML='<span class="pill '+(result?.ok?'ok':'')+'"><span class="dot"></span></span> ';target.append(document.createTextNode(text));});}status('deepseek',state.deepseekConfigured);status('gemini',state.geminiConfigured);status('ollama',true);
document.querySelectorAll('[data-setting]').forEach(el=>{const key=el.dataset.setting;if(el.type==='checkbox')el.checked=Boolean(settings[key]);else el.value=String(settings[key]??'');el.addEventListener('change',()=>{let value=el.type==='checkbox'?el.checked:(el.type==='number'?Number(el.value):el.value);vscode.postMessage({type:'saveSetting',key,value});});});
function activateSection(id){const button=document.querySelector('nav button[data-section="'+id+'"]');const section=document.getElementById(id);if(!button||!section)return;document.querySelectorAll('nav button,section').forEach(el=>el.classList.remove('active'));button.classList.add('active');section.classList.add('active');const saved=vscode.getState()||{};vscode.setState({...saved,activeSection:id});}
const restoredSection=(vscode.getState()||{}).activeSection;activateSection(restoredSection||state.initialSection||'overview');document.querySelectorAll('[data-section]').forEach(button=>button.addEventListener('click',()=>activateSection(button.dataset.section)));
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:button.dataset.action})));
document.querySelectorAll('[data-secret-save]').forEach(button=>button.addEventListener('click',()=>{const provider=button.dataset.secretSave;const input=document.querySelector('[data-secret="'+provider+'"]');vscode.postMessage({type:'saveSecret',provider,value:input.value});input.value='';}));
document.querySelectorAll('[data-secret-test]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'testConnection',provider:button.dataset.secretTest})));
document.querySelectorAll('[data-secret-remove]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'removeSecret',provider:button.dataset.secretRemove})));
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

	private _secretRow(provider: 'deepseek' | 'gemini', label: string, hint: string): string {
		return `<div class="row"><label><strong>${label}</strong><span class="hint">${hint} ${vscode.l10n.t('Stored securely; the saved value is never read back into this page.')}</span><span data-provider-status="${provider}"></span></label><div class="controls"><input type="password" autocomplete="off" data-secret="${provider}" placeholder="${vscode.l10n.t('Paste your API key')}"><button data-secret-save="${provider}">${vscode.l10n.t('Save')}</button><button class="secondary" data-secret-test="${provider}">${vscode.l10n.t('Test')}</button><button class="danger" data-secret-remove="${provider}">${vscode.l10n.t('Remove')}</button></div></div>`;
	}

	private _connectionRow(provider: NikaConnection, label: string): string {
		return `<div class="row"><label><strong>${label}</strong><span data-provider-status="${provider}"></span></label><div><button class="action secondary" data-secret-test="${provider}">${vscode.l10n.t('Test Connection')}</button></div></div>`;
	}

	private _agentRow(role: 'plan' | 'explore' | 'utility' | 'utilitySmall' | 'inlineChat', label: string): string {
		const modelKey = `agent.${role}`;
		const effortKey = `agent.${role}ThinkingEffort`;
		const models = [
			[NIKA_RESPONSES_MODEL, vscode.l10n.t('DeepSeek V4 Flash (Responses)')],
			['nika/deepseek-v4-flash', vscode.l10n.t('DeepSeek V4 Flash')],
			['nika/deepseek-v4-pro', vscode.l10n.t('DeepSeek V4 Pro')],
			['nika/gemini-2.5-flash', vscode.l10n.t('Gemini 2.5 Flash')],
			['nika/gemini-2.5-flash-lite', vscode.l10n.t('Gemini 2.5 Flash Lite')],
			['nika/gemma4:31b', vscode.l10n.t('Gemma 4 31B (Ollama)')],
		];
		const efforts = [['none', vscode.l10n.t('None')], ['low', vscode.l10n.t('Low')], ['high', vscode.l10n.t('High')], ['max', vscode.l10n.t('Max')]];
		return `<div class="row"><label for="${modelKey}"><strong>${label}</strong></label><div class="agent-controls"><select id="${modelKey}" aria-label="${vscode.l10n.t('{0} model', label)}" data-setting="${modelKey}">${models.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select><select id="${effortKey}" aria-label="${vscode.l10n.t('{0} thinking effort', label)}" data-setting="${effortKey}">${efforts.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></div></div>`;
	}
}
