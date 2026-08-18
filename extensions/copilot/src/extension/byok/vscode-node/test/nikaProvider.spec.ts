/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CopilotLanguageModelWrapper } from '../../../conversation/vscode-node/languageModelAccess';
import { DeepSeekEndpoint } from '../../node/deepSeekEndpoint';
import { NikaAttachmentProcessor } from '../nikaAttachments';
import { NikaIndexingStatus } from '../nikaIndexingStatus';
import { NikaOpenRouterProvider } from '../nikaOpenRouterProvider';
import { NikaSettingsEditor } from '../nikaSettingsEditor';
import { NikaUsageStatus } from '../nikaUsageStatus';
import { NikaUsageTracker } from '../nikaUsageTracker';
import { CustomDataPartMimeTypes } from '../../../../platform/endpoint/common/endpointTypes';
import { GeminiNativeBYOKLMProvider } from '../geminiNativeProvider';
import { NikaLMProvider, type NikaLanguageModelChatInformation } from '../nikaProvider';
import { OllamaLMProvider } from '../ollamaProvider';

vi.mock('vscode', async (importOriginal) => {
	const actual = await importOriginal<typeof import('vscode')>();
	const configurationChange = new actual.EventEmitter<unknown>();
	return {
		...actual,
		// The shim only declares ChatHookType as a type, but `vscodeTypes.ts`
		// re-exports it as a runtime value (it is a string enum in the real
		// vscode API). Provide the value so transitive imports can load.
		ChatHookType: {
			SessionStart: 'SessionStart',
			UserPromptSubmit: 'UserPromptSubmit',
			PreToolUse: 'PreToolUse',
			PostToolUse: 'PostToolUse',
			SubagentStart: 'SubagentStart',
			SubagentStop: 'SubagentStop',
			Stop: 'Stop',
		},
		// Runtime placeholders for the remaining re-exports in `vscodeTypes.ts`
		// that the test shim does not define as values. Only identity matters
		// here — the provider under test never constructs these.
		ChatRequest: class ChatRequest { },
		Extension: class Extension { },
		ChatMcpToolInvocationData: class ChatMcpToolInvocationData { },
		LanguageModelToolInformation: class LanguageModelToolInformation { },
		workspace: {
			getConfiguration: vi.fn(() => ({ get: (key: string, fallback: unknown) => key === 'openrouterFloor' ? floorEnabled : fallback })),
			onDidChangeConfiguration: configurationChange.event,
			workspaceFolders: [],
			asRelativePath: (_uri: unknown, _includeWorkspaceFolder: boolean) => '',
		},
		window: {
			showErrorMessage: vi.fn(),
			activeTextEditor: undefined,
		},
	};
});

// Mutable flag the vscode mock reads for the `openrouterFloor` setting.
let floorEnabled = false;

function createByokStorage() {
	return {
		getAPIKey: vi.fn().mockResolvedValue(undefined),
		storeAPIKey: vi.fn().mockResolvedValue(undefined),
		deleteAPIKey: vi.fn().mockResolvedValue(undefined),
		getStoredModelConfigs: vi.fn().mockResolvedValue({}),
		saveModelConfig: vi.fn().mockResolvedValue(undefined),
		removeModelConfig: vi.fn().mockResolvedValue(undefined),
	};
}

function createContext(keys?: Record<string, string | undefined>) {
	return {
		secrets: {
			get: vi.fn((key: string) => Promise.resolve(keys ? keys[key] : 'test-key')),
			onDidChange: vi.fn(() => ({ dispose: () => { } })),
		},
	} as never;
}

function createInstantiationService(overrides: {
	lmWrapper: { provideLanguageModelResponse: ReturnType<typeof vi.fn>; provideTokenCount: ReturnType<typeof vi.fn> };
	geminiProvider: { provideLanguageModelChatResponse: ReturnType<typeof vi.fn>; provideTokenCount: ReturnType<typeof vi.fn> };
	ollamaProvider: { provideLanguageModelChatResponse: ReturnType<typeof vi.fn>; provideTokenCount: ReturnType<typeof vi.fn>; updateKnownModels: ReturnType<typeof vi.fn> };
	usageTracker: { notifyLiveChange: ReturnType<typeof vi.fn>; trackStream: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> };
	attachmentProcessor: { process: ReturnType<typeof vi.fn> };
	openRouterProvider: { getCatalog: ReturnType<typeof vi.fn>; createEndpoint: ReturnType<typeof vi.fn>; invalidateCache: ReturnType<typeof vi.fn> };
}) {
	const deepSeekEndpointUrls: string[] = [];
	const createInstance = vi.fn((Ctor: unknown, ...args: unknown[]) => {
		if (Ctor === CopilotLanguageModelWrapper) {
			return overrides.lmWrapper;
		}
		if (Ctor === GeminiNativeBYOKLMProvider) {
			return overrides.geminiProvider;
		}
		if (Ctor === OllamaLMProvider) {
			return overrides.ollamaProvider;
		}
		if (Ctor === NikaUsageTracker) {
			return overrides.usageTracker;
		}
		if (Ctor === NikaSettingsEditor) {
			return { dispose: () => { } };
		}
		if (Ctor === NikaOpenRouterProvider) {
			return overrides.openRouterProvider;
		}
		if (Ctor === NikaAttachmentProcessor) {
			return overrides.attachmentProcessor;
		}
		if (Ctor === NikaIndexingStatus) {
			return { dispose: () => { } };
		}
		if (Ctor === NikaUsageStatus) {
			return { dispose: () => { } };
		}
		if (Ctor === DeepSeekEndpoint) {
			deepSeekEndpointUrls.push(args[2] as string);
			return { dispose: () => { } };
		}
		throw new Error(`Unexpected createInstance target: ${(Ctor as { name?: string })?.name}`);
	});
	return { createInstance, deepSeekEndpointUrls };
}

function createFakes() {
	const lmWrapper = {
		provideLanguageModelResponse: vi.fn().mockResolvedValue(undefined),
		provideTokenCount: vi.fn().mockResolvedValue(0),
	};
	const geminiProvider = {
		provideLanguageModelChatResponse: vi.fn().mockResolvedValue(undefined),
		provideTokenCount: vi.fn().mockResolvedValue(0),
	};
	const ollamaProvider = {
		provideLanguageModelChatResponse: vi.fn().mockResolvedValue(undefined),
		provideTokenCount: vi.fn().mockResolvedValue(0),
		updateKnownModels: vi.fn(),
	};
	const usageTracker = {
		notifyLiveChange: vi.fn(),
		trackStream: vi.fn(() => () => { }),
		record: vi.fn(),
	};
	const attachmentProcessor = {
		process: vi.fn().mockResolvedValue({ replayMarkers: [], messages: [] }),
	};
	const openRouterProvider = {
		getCatalog: vi.fn().mockResolvedValue(new Map()),
		createEndpoint: vi.fn(() => ({ dispose: () => { } })),
		invalidateCache: vi.fn(),
	};
	return { lmWrapper, geminiProvider, ollamaProvider, usageTracker, attachmentProcessor, openRouterProvider };
}

function createProvider(overrides?: {
	keys?: Record<string, string | undefined>;
	catalog?: Map<string, { id: string; name: string; capabilities: { name: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; supportsReasoningEffort?: string[]; pricing?: { label: string; inputCost: number; outputCost: number; cacheCost: number } }; pricing?: { promptPerMTok: number; completionPerMTok: number; cacheReadPerMTok: number; requestFee: number; free: boolean } }>;
}) {
	const fakes = createFakes();
	const instantiation = createInstantiationService(fakes);
	if (overrides?.catalog) {
		vi.mocked(fakes.openRouterProvider.getCatalog).mockResolvedValue(overrides.catalog as never);
	}
	const provider = new NikaLMProvider(
		createByokStorage() as never,
		createContext(overrides?.keys),
		{} as never,
		instantiation as never,
	);
	return { provider, fakes, deepSeekEndpointUrls: instantiation.deepSeekEndpointUrls };
}

function deepSeekRequestArgs() {
	const messages = [{ role: 'user', content: 'Hello there' }] as never;
	const options = { requestInitiator: 'test', modelOptions: {}, modelConfiguration: {} } as never;
	const progress = { report: vi.fn() } as never;
	const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { } }) } as never;
	return { messages, options, progress, token };
}

describe('NikaLMProvider', () => {
	it('returns after a successful DeepSeek request without falling through to the Ollama fallback', async () => {
		const { provider, fakes, deepSeekEndpointUrls } = createProvider();
		const model = { id: 'deepseek-v4-flash-responses' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

		// The DeepSeek request must be routed to the responses endpoint...
		expect(deepSeekEndpointUrls).toEqual(['https://api.deepseek.com/responses']);
		expect(fakes.lmWrapper.provideLanguageModelResponse).toHaveBeenCalledTimes(1);
		// ...and must NOT also fire a second request against the local Ollama host
		// (the regression this guards: a missing return fell through to the
		// Ollama fallback branch, which surfaced Ollama's "model not found" 404
		// for the `-responses` id and masked the successful DeepSeek response).
		expect(fakes.ollamaProvider.provideLanguageModelChatResponse).not.toHaveBeenCalled();
	});

	it('still routes non-DeepSeek models to the Ollama fallback', async () => {
		const { provider, fakes } = createProvider();
		const model = { id: 'gemma4:31b' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

		expect(fakes.lmWrapper.provideLanguageModelResponse).not.toHaveBeenCalled();
		expect(fakes.ollamaProvider.provideLanguageModelChatResponse).toHaveBeenCalledTimes(1);
	});

	it('throws for unknown Nika model ids', async () => {
		const { provider } = createProvider();
		const model = { id: 'some-other-model' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await expect(provider.provideLanguageModelChatResponse(model, messages, options, progress, token))
			.rejects.toThrow('Unknown Nika model');
	});
});

describe('Nika OpenRouter support', () => {
	it('routes openrouter models through the OpenRouter endpoint with raw id', async () => {
		const { provider, fakes } = createProvider();
		const model = { id: 'openrouter/anthropic/claude-sonnet-4', vendor: 'openrouter' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

		expect(fakes.openRouterProvider.createEndpoint).toHaveBeenCalledWith('anthropic/claude-sonnet-4', 'test-key');
		expect(fakes.lmWrapper.provideLanguageModelResponse).toHaveBeenCalledTimes(1);
		expect(fakes.ollamaProvider.provideLanguageModelChatResponse).not.toHaveBeenCalled();
	});

	it('appends the :floor variant to the wire model id when the toggle is on', async () => {
		floorEnabled = true;
		try {
			const { provider, fakes } = createProvider();
			const model = { id: 'openrouter/deepseek/deepseek-v4-flash-0731', vendor: 'openrouter' } as NikaLanguageModelChatInformation;
			const { messages, options, progress, token } = deepSeekRequestArgs();

			await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

			expect(fakes.openRouterProvider.createEndpoint).toHaveBeenCalledWith('deepseek/deepseek-v4-flash-0731:floor', 'test-key');
			expect(fakes.lmWrapper.provideLanguageModelResponse).toHaveBeenCalledTimes(1);
		} finally {
			floorEnabled = false;
		}
	});

	it('does not double-append :floor when the model id already ends with it', async () => {
		floorEnabled = true;
		try {
			const { provider, fakes } = createProvider();
			const model = { id: 'openrouter/deepseek/deepseek-v4-flash-0731:floor', vendor: 'openrouter' } as NikaLanguageModelChatInformation;
			const { messages, options, progress, token } = deepSeekRequestArgs();

			await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

			expect(fakes.openRouterProvider.createEndpoint).toHaveBeenCalledWith('deepseek/deepseek-v4-flash-0731:floor', 'test-key');
			expect(fakes.lmWrapper.provideLanguageModelResponse).toHaveBeenCalledTimes(1);
		} finally {
			floorEnabled = false;
		}
	});

	it('rejects openrouter models when the API key is missing', async () => {
		const { provider } = createProvider({ keys: { 'nika.openrouter.apiKey': undefined } });
		const model = { id: 'openrouter/anthropic/claude-sonnet-4' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await expect(provider.provideLanguageModelChatResponse(model, messages, options, progress, token))
			.rejects.toThrow('Configure an OpenRouter API key in Nika Settings');
		expect(provider.usageTracker.record).not.toHaveBeenCalled();
	});

	it('records usage with the openrouter provider and pricing snapshot', async () => {
		const pricing = { promptPerMTok: 3, completionPerMTok: 15, cacheReadPerMTok: 0.3, requestFee: 0.005, free: false };
		const { provider, fakes } = createProvider({
			catalog: new Map([[
				'anthropic/claude-sonnet-4',
				{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', capabilities: { name: 'Claude Sonnet 4', toolCalling: true, vision: false, maxInputTokens: 200_000, maxOutputTokens: 64_000 }, pricing },
			]]),
		});
		fakes.lmWrapper.provideLanguageModelResponse.mockImplementation(async (_endpoint, _messages, _options, _initiator, progress) => {
			progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })), CustomDataPartMimeTypes.Usage));
		});
		const model = { id: 'openrouter/anthropic/claude-sonnet-4' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

		expect(fakes.openRouterProvider.getCatalog).toHaveBeenCalledWith('test-key');
		expect(provider.usageTracker.record).toHaveBeenCalledWith(expect.objectContaining({
			model: 'openrouter/anthropic/claude-sonnet-4',
			provider: 'openrouter',
			promptTokens: 10,
			completionTokens: 5,
			pricing,
		}));
	});

	it('appends the OpenRouter catalog to the model list when the key is present', async () => {
		const { provider, fakes } = createProvider({
			keys: { 'nika.deepseek.apiKey': 'ds', 'nika.openrouter.apiKey': 'or-1', 'nika.gemini.apiKey': undefined },
			catalog: new Map([[
				'deepseek/deepseek-chat-v4-0324',
				{ id: 'deepseek/deepseek-chat-v4-0324', name: 'DeepSeek Chat V4', capabilities: { name: 'DeepSeek Chat V4', toolCalling: true, vision: false, maxInputTokens: 128_000, maxOutputTokens: 8_192 } },
			]]),
		});

		const models = await provider.provideLanguageModelChatInformation();

		expect(fakes.openRouterProvider.getCatalog).toHaveBeenCalledWith('or-1');
		const openRouterIds = models.filter(m => m.id.startsWith('openrouter/'));
		expect(openRouterIds.length).toBe(1);
		expect(openRouterIds[0].id).toBe('openrouter/deepseek/deepseek-chat-v4-0324');
		expect(openRouterIds[0].name).toBe('DeepSeek Chat V4');
		expect(openRouterIds[0].detail).toBe('Nika');
		expect(openRouterIds[0].isBYOK).toBe(true);
		expect(openRouterIds[0].capabilities.toolCalling).toBe(true);
		// Even text-only OpenRouter catalog models advertise image input: Nika
		// preprocesses images into a text description before forwarding, so the
		// workbench must not block drag-and-drop images for them.
		expect(openRouterIds[0].capabilities.imageInput).toBe(true);
	});

	it('omits the OpenRouter catalog when the key is missing', async () => {
		const { provider, fakes } = createProvider({ keys: { 'nika.openrouter.apiKey': undefined } });

		const models = await provider.provideLanguageModelChatInformation();

		expect(fakes.openRouterProvider.getCatalog).not.toHaveBeenCalled();
		expect(models.filter(m => m.vendor === 'openrouter')).toHaveLength(0);
	});

	it('still lists models when the catalog fetch fails', async () => {
		const { provider, fakes } = createProvider();
		vi.mocked(fakes.openRouterProvider.getCatalog).mockRejectedValueOnce(new Error('HTTP 500'));

		const models = await provider.provideLanguageModelChatInformation();

		expect(models.length).toBeGreaterThan(0);
		expect(models.filter(m => m.vendor === 'openrouter')).toHaveLength(0);
	});
});
