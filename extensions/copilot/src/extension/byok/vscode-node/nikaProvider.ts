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
import {
	getNikaModelCapabilities,
	getVisibleNikaModelIds,
	isNikaDeepSeekModel,
	isNikaGeminiModel,
	isNikaModelId,
	NIKA_DEEPSEEK_SECRET,
	NIKA_GEMINI_MODEL_IDS,
	NIKA_GEMINI_SECRET,
	NIKA_GEMMA_MODEL_ID,
	NIKA_PROVIDER_ID,
	NIKA_PROVIDER_NAME,
	NikaModelId,
	resolveNikaTokenLimits,
} from './nikaModels';
import { NikaSettingsEditor } from './nikaSettingsEditor';
import { NikaAttachmentProcessor } from './nikaAttachments';
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
		this.settingsEditor = this._register(this._instantiationService.createInstance(NikaSettingsEditor));
		this._attachmentProcessor = this._instantiationService.createInstance(NikaAttachmentProcessor, this.settingsEditor);

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
		const defaultModel = vscode.workspace.getConfiguration('nika').get<string>('defaultModel', 'nika/deepseek-v4-flash').replace(/^nika\//, '');

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
			try {
				const endpoint = this._createDeepSeekEndpoint(model.id, key);
				const processed = await this._attachmentProcessor.process(messages, token);
				for (const marker of processed.replayMarkers) { progress.report(marker); }
				return await this._lmWrapper.provideLanguageModelResponse(endpoint, processed.messages, options, options.requestInitiator, progress, token);
			} catch (error) {
				if (model.id === 'deepseek-v4-flash-responses' && !token.isCancellationRequested) {
					const switchAction = vscode.l10n.t('Use Flash Chat Completions');
					const selected = await vscode.window.showErrorMessage(
						vscode.l10n.t('The experimental DeepSeek Responses request failed. Nika did not fall back automatically.'),
						switchAction,
					);
					if (selected === switchAction) {
						await vscode.workspace.getConfiguration('chat').update('defaultModel', 'nika/deepseek-v4-flash', vscode.ConfigurationTarget.Global);
						await vscode.workspace.getConfiguration('nika').update('defaultModel', 'nika/deepseek-v4-flash', vscode.ConfigurationTarget.Global);
					}
				}
				throw error;
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
		const capabilities = getNikaModelCapabilities(id, this._limits());
		const modelInfo = resolveModelInfo(id, NIKA_PROVIDER_NAME, { [id]: capabilities });
		const url = id === 'deepseek-v4-flash-responses'
			? 'https://api.deepseek.com/responses'
			: 'https://api.deepseek.com/chat/completions';
		return this._instantiationService.createInstance(DeepSeekEndpoint, modelInfo, apiKey, url);
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
		if (id === 'deepseek-v4-flash-responses') {
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
