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
import { BYOKKnownModels, byokKnownModelToAPIInfo, resolveModelInfo } from '../common/byokProvider';
import { DeepSeekEndpoint } from '../node/deepSeekEndpoint';
import { ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';
import { byokKnownModelToAPIInfoWithEffort } from './byokModelInfo';
import { GeminiNativeBYOKLMProvider } from './geminiNativeProvider';
import { NikaIndexingStatus } from './nikaIndexingStatus';
import { NikaUsageStatus } from './nikaUsageStatus';
import {
	getNikaModelCapabilities,
	getVisibleNikaModelIds,
	isNikaDeepSeekModel,
	isNikaGeminiModel,
	isNikaModelId,
	isNikaThinkingEffort,
	NIKA_DEEPSEEK_SECRET,
	NIKA_GEMINI_MODEL_IDS,
	NIKA_GEMINI_SECRET,
	NIKA_GEMMA_MODEL_ID,
	NIKA_PROVIDER_ID,
	NIKA_PROVIDER_NAME,
	NIKA_RESPONSES_MODEL,
	NikaModelId,
	resolveNikaTokenLimits,
} from './nikaModels';
import { NikaSettingsEditor } from './nikaSettingsEditor';
import { NikaAttachmentProcessor } from './nikaAttachments';
import { NikaUsageTracker, TokenTrackingProgress } from './nikaUsageTracker';
import { OllamaConfig, OllamaLMProvider } from './ollamaProvider';

export interface NikaLanguageModelChatInformation extends vscode.LanguageModelChatInformation {
	readonly isBYOK: true;
}

export class NikaLMProvider extends Disposable implements vscode.LanguageModelChatProvider<NikaLanguageModelChatInformation> {
	public static readonly providerId = NIKA_PROVIDER_ID;
	public static readonly providerName = NIKA_PROVIDER_NAME;

	private readonly _onDidChange = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	private readonly _lmWrapper: CopilotLanguageModelWrapper;
	private readonly _geminiProvider: GeminiNativeBYOKLMProvider;
	private readonly _ollamaProvider: OllamaLMProvider;
	private readonly _attachmentProcessor: NikaAttachmentProcessor;
	readonly settingsEditor: NikaSettingsEditor;
	readonly usageTracker: NikaUsageTracker;

	constructor(
		byokStorageService: IBYOKStorageService,
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IFetcherService _fetcherService: IFetcherService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
		this._geminiProvider = this._instantiationService.createInstance(GeminiNativeBYOKLMProvider, this._geminiKnownModels(), byokStorageService);
		this._ollamaProvider = this._instantiationService.createInstance(OllamaLMProvider, byokStorageService);
		this._ollamaProvider.updateKnownModels(this._gemmaKnownModels());
		this.usageTracker = this._register(this._instantiationService.createInstance(NikaUsageTracker));
		this.settingsEditor = this._register(this._instantiationService.createInstance(NikaSettingsEditor, this.usageTracker));
		this._attachmentProcessor = this._instantiationService.createInstance(NikaAttachmentProcessor, this.settingsEditor);
		this._register(this._instantiationService.createInstance(NikaIndexingStatus, this.settingsEditor));
		this._register(this._instantiationService.createInstance(NikaUsageStatus, this.settingsEditor, this.usageTracker));

		this._register(this._context.secrets.onDidChange(event => {
			if (event.key === NIKA_DEEPSEEK_SECRET || event.key === NIKA_GEMINI_SECRET) {
				this._onDidChange.fire();
			}
		}));
		this._register(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('nika.outputTokens') || event.affectsConfiguration('nika.contextWindow') || event.affectsConfiguration('nika.thinkingEffort') || event.affectsConfiguration('nika.ollamaBaseUrl')) {
				this._ollamaProvider.updateKnownModels(this._gemmaKnownModels());
				this._onDidChange.fire();
			}
		}));
	}

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): Promise<NikaLanguageModelChatInformation[]> {
		const [deepseekKey, geminiKey] = await Promise.all([
			this._context.secrets.get(NIKA_DEEPSEEK_SECRET),
			this._context.secrets.get(NIKA_GEMINI_SECRET),
		]);
		const limits = this._limits();
		const modelIds = getVisibleNikaModelIds(!!deepseekKey, !!geminiKey);
		const defaultModel = vscode.workspace.getConfiguration('nika').get<string>('defaultModel', NIKA_RESPONSES_MODEL).replace(/^nika\//, '');

		return modelIds.map(id => {
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
	}

	async provideLanguageModelChatResponse(model: NikaLanguageModelChatInformation, messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>, options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart2>, token: vscode.CancellationToken): Promise<void> {
		if (!isNikaModelId(model.id)) {
			throw new Error(vscode.l10n.t('Unknown Nika model: {0}', model.id));
		}
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
					const chatModelLabel = chatModel === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro' : 'DeepSeek V4 Flash';
					const switchAction = vscode.l10n.t('Use {0} Chat Completions', chatModelLabel);
					const selected = await vscode.window.showErrorMessage(
						vscode.l10n.t('The experimental DeepSeek Responses request failed. Nika did not fall back automatically.'),
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
		}

		if (isNikaGeminiModel(model.id)) {
			const key = await this._context.secrets.get(NIKA_GEMINI_SECRET);
			if (!key) {
				throw new Error(vscode.l10n.t('Configure a Gemini API key in Nika Settings before using this model.'));
			}
			const delegate: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration> = {
				...model,
				configuration: { apiKey: key },
			};
			return this._geminiProvider.provideLanguageModelChatResponse(delegate, messages, options, progress, token);
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
		if (isNikaDeepSeekModel(model.id)) {
			const endpoint = this._createDeepSeekEndpoint(model.id, await this._context.secrets.get(NIKA_DEEPSEEK_SECRET) ?? '');
			return this._lmWrapper.provideTokenCount(endpoint, text);
		}
		if (isNikaGeminiModel(model.id)) {
			const delegate: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration> = {
				...model,
				configuration: { apiKey: await this._context.secrets.get(NIKA_GEMINI_SECRET) ?? '' },
			};
			return this._geminiProvider.provideTokenCount(delegate, text, token);
		}
		const url = vscode.workspace.getConfiguration('nika').get<string>('ollamaBaseUrl', 'http://localhost:11434').replace(/\/$/, '');
		return this._ollamaProvider.provideTokenCount({ ...model, url, configuration: { url } }, text, token);
	}

	private _createDeepSeekEndpoint(id: NikaModelId, apiKey: string): DeepSeekEndpoint {
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

	private _recordUsage(modelId: string, tracked: TokenTrackingProgress, meta: { sessionId?: string; title?: string; workspace?: string; initiator?: string }): void {
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

	private _geminiKnownModels(): BYOKKnownModels {
		const limits = this._limits();
		return Object.fromEntries(NIKA_GEMINI_MODEL_IDS.map(id => [id, getNikaModelCapabilities(id, limits)]));
	}

	private _gemmaKnownModels(): BYOKKnownModels {
		return { [NIKA_GEMMA_MODEL_ID]: getNikaModelCapabilities(NIKA_GEMMA_MODEL_ID, this._limits()) };
	}

	private _tooltipFor(id: NikaModelId): string {
		if (id.endsWith('-responses')) {
			return vscode.l10n.t('Experimental DeepSeek Responses API model. It never falls back silently to Chat Completions.');
		}
		if (isNikaDeepSeekModel(id)) {
			return vscode.l10n.t('DeepSeek V4 through the native Nika provider. Images and PDFs are converted to text first.');
		}
		if (isNikaGeminiModel(id)) {
			return vscode.l10n.t('Native Gemini model with image and document input.');
		}
		return vscode.l10n.t('Gemma 4 31B through the configured Ollama host.');
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
