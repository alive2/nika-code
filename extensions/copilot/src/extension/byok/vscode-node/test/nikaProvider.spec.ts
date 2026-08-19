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
import { NikaLlamaCppProvider } from '../nikaLlamaCppProvider';
import { NikaSettingsEditor } from '../nikaSettingsEditor';
import { NikaUsageStatus } from '../nikaUsageStatus';
import { NikaUsageTracker } from '../nikaUsageTracker';
import { CustomDataPartMimeTypes } from '../../../../platform/endpoint/common/endpointTypes';
import { GeminiNativeBYOKLMProvider } from '../geminiNativeProvider';
import { NikaLMProvider, type NikaLanguageModelChatInformation } from '../nikaProvider';
import { NikaCursorProvider } from '../nikaCursorProvider';
import { NikaGeminiProvider } from '../nikaGeminiProvider';
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
			getConfiguration: vi.fn(() => ({ get: (key: string, fallback: unknown) => key === 'openrouterFloor' ? floorEnabled : key === 'providers' ? providersConfig : fallback })),
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

// Mutable flags the vscode mock reads for the `openrouterFloor` and
// `providers` settings.
let floorEnabled = false;
let providersConfig: unknown;

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
	llamaCppProvider: { getCatalog: ReturnType<typeof vi.fn>; createEndpoint: ReturnType<typeof vi.fn>; invalidateCache: ReturnType<typeof vi.fn> };
	geminiCatalogProvider: { getCatalog: ReturnType<typeof vi.fn>; invalidateCache: ReturnType<typeof vi.fn> };
	cursorProvider: { getCatalog: ReturnType<typeof vi.fn>; createEndpoint: ReturnType<typeof vi.fn>; invalidateCache: ReturnType<typeof vi.fn> };
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
		if (Ctor === NikaLlamaCppProvider) {
			return overrides.llamaCppProvider;
		}
		if (Ctor === NikaGeminiProvider) {
			return overrides.geminiCatalogProvider;
		}
		if (Ctor === NikaCursorProvider) {
			return overrides.cursorProvider;
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
	const llamaCppProvider = {
		getCatalog: vi.fn().mockResolvedValue(new Map()),
		createEndpoint: vi.fn(() => ({ dispose: () => { } })),
		invalidateCache: vi.fn(),
	};
	const geminiCatalogProvider = {
		getCatalog: vi.fn().mockResolvedValue(new Map()),
		invalidateCache: vi.fn(),
	};
	const cursorProvider = {
		getCatalog: vi.fn().mockResolvedValue(new Map()),
		createEndpoint: vi.fn(() => ({ dispose: () => { } })),
		invalidateCache: vi.fn(),
	};
	return { lmWrapper, geminiProvider, ollamaProvider, usageTracker, attachmentProcessor, openRouterProvider, llamaCppProvider, geminiCatalogProvider, cursorProvider };
}

function createProvider(overrides?: {
	keys?: Record<string, string | undefined>;
	fetcher?: { fetch: ReturnType<typeof vi.fn> };
	catalog?: Map<string, { id: string; name: string; capabilities: { name: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; supportsReasoningEffort?: string[]; pricing?: { label: string; inputCost: number; outputCost: number; cacheCost: number } }; pricing?: { promptPerMTok: number; completionPerMTok: number; cacheReadPerMTok: number; requestFee: number; free: boolean } }>;
	geminiCatalog?: Map<string, { id: string; name: string; capabilities: { name: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; supportsReasoningEffort?: string[] } }>;
	cursorCatalog?: Map<string, { id: string; name: string; capabilities: { name: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; supportsReasoningEffort?: string[] } }>;
}) {
	const fakes = createFakes();
	const instantiation = createInstantiationService(fakes);
	if (overrides?.catalog) {
		vi.mocked(fakes.openRouterProvider.getCatalog).mockResolvedValue(overrides.catalog as never);
	}
	if (overrides?.geminiCatalog) {
		vi.mocked(fakes.geminiCatalogProvider.getCatalog).mockResolvedValue(overrides.geminiCatalog as never);
	}
	if (overrides?.cursorCatalog) {
		vi.mocked(fakes.cursorProvider.getCatalog).mockResolvedValue(overrides.cursorCatalog as never);
	}
	const provider = new NikaLMProvider(
		createByokStorage() as never,
		createContext(overrides?.keys),
		(overrides?.fetcher ?? { fetch: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ models: [] }) }) }) as never,
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
		const model = { id: 'openrouter/anthropic/claude-sonnet-4', vendor: 'openrouter' } as unknown as NikaLanguageModelChatInformation;
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
			const model = { id: 'openrouter/deepseek/deepseek-v4-flash-0731', vendor: 'openrouter' } as unknown as NikaLanguageModelChatInformation;
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
			const model = { id: 'openrouter/deepseek/deepseek-v4-flash-0731:floor', vendor: 'openrouter' } as unknown as NikaLanguageModelChatInformation;
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

		const models = await provider.provideLanguageModelChatInformation({} as never, {} as never);

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

		const models = await provider.provideLanguageModelChatInformation({} as never, {} as never);

		expect(fakes.openRouterProvider.getCatalog).not.toHaveBeenCalled();
		expect(models.filter(m => (m as { vendor?: string }).vendor === 'openrouter')).toHaveLength(0);
	});

	it('still lists models when the catalog fetch fails', async () => {
		const { provider, fakes } = createProvider();
		vi.mocked(fakes.openRouterProvider.getCatalog).mockRejectedValueOnce(new Error('HTTP 500'));

		const models = await provider.provideLanguageModelChatInformation({} as never, {} as never);

		expect(models.length).toBeGreaterThan(0);
		expect(models.filter(m => (m as { vendor?: string }).vendor === 'openrouter')).toHaveLength(0);
	});
});

describe('Nika llama.cpp support', () => {
	it('routes llamacpp models through the llama.cpp endpoint with native images', async () => {
		const { provider, fakes } = createProvider();
		const model = { id: 'llamacpp/qwen2.5vl-7b' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

		expect(fakes.llamaCppProvider.createEndpoint).toHaveBeenCalledWith('qwen2.5vl-7b', 'http://localhost:8080', 'test-key');
		// Images pass through untouched: llama.cpp models are multimodal, so
		// only PDFs are converted to text by the attachment processor.
		expect(fakes.attachmentProcessor.process).toHaveBeenCalledWith(messages, token, { preserveImages: true });
		expect(fakes.lmWrapper.provideLanguageModelResponse).toHaveBeenCalledTimes(1);
		expect(fakes.ollamaProvider.provideLanguageModelChatResponse).not.toHaveBeenCalled();
	});

	it('creates an unauthenticated endpoint when no llama.cpp key is configured', async () => {
		const { provider, fakes } = createProvider({ keys: { 'nika.llamacpp.apiKey': undefined } });
		const model = { id: 'llamacpp/llama-3.2-3b' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

		expect(fakes.llamaCppProvider.createEndpoint).toHaveBeenCalledWith('llama-3.2-3b', 'http://localhost:8080', undefined);
		expect(fakes.lmWrapper.provideLanguageModelResponse).toHaveBeenCalledTimes(1);
	});

	it('records usage with the llamacpp provider (no pricing snapshot)', async () => {
		const { provider, fakes } = createProvider();
		fakes.lmWrapper.provideLanguageModelResponse.mockImplementation(async (_endpoint, _messages, _options, _initiator, progress) => {
			progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })), CustomDataPartMimeTypes.Usage));
		});
		const model = { id: 'llamacpp/qwen2.5vl-7b' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

		expect(provider.usageTracker.record).toHaveBeenCalledWith(expect.objectContaining({
			model: 'llamacpp/qwen2.5vl-7b',
			provider: 'llamacpp',
			promptTokens: 10,
			completionTokens: 5,
		}));
	});

	it('appends llama.cpp server models to the model list when the server responds', async () => {
		const { provider, fakes } = createProvider();
		vi.mocked(fakes.llamaCppProvider.getCatalog).mockResolvedValue(new Map([[
			'qwen2.5vl-7b',
			{ id: 'qwen2.5vl-7b', name: 'qwen2.5vl-7b', contextWindow: 32768, capabilities: { name: 'qwen2.5vl-7b', toolCalling: true, vision: true, maxInputTokens: 28672, maxOutputTokens: 4096, contextWindow: 32768 } },
		]]) as never);

		const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

		expect(fakes.llamaCppProvider.getCatalog).toHaveBeenCalledWith('http://localhost:8080', 'test-key');
		const llamaIds = models.filter(m => m.id.startsWith('llamacpp/'));
		expect(llamaIds).toHaveLength(1);
		expect(llamaIds[0].id).toBe('llamacpp/qwen2.5vl-7b');
		expect(llamaIds[0].name).toBe('qwen2.5vl-7b');
		expect(llamaIds[0].detail).toBe('Nika');
		expect(llamaIds[0].isBYOK).toBe(true);
		expect(llamaIds[0].capabilities.toolCalling).toBe(true);
		// llama.cpp models accept images natively, so the picker entry must
		// advertise image input (no vision-backend preprocessing happens).
		expect(llamaIds[0].capabilities.imageInput).toBe(true);
		expect(llamaIds[0].statusIcon).toBeDefined();
	});

	it('still lists models when the llama.cpp server is unreachable', async () => {
		const { provider, fakes } = createProvider();
		vi.mocked(fakes.llamaCppProvider.getCatalog).mockRejectedValueOnce(new Error('ECONNREFUSED'));

		const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

		expect(models.length).toBeGreaterThan(0);
		expect(models.filter(m => m.id.startsWith('llamacpp/'))).toHaveLength(0);
	});
});

describe('Nika provider-config gating (nika.providers)', () => {
	it('exposes only the wizard-selected native models in managed mode', async () => {
		providersConfig = { deepseek: { models: ['deepseek-v4-flash'] }, gemini: { models: ['gemini-2.5-flash-lite'] } };
		try {
			const { provider } = createProvider({ keys: { 'nika.deepseek.apiKey': 'ds', 'nika.gemini.apiKey': 'gm' } });

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(models.map(m => m.id)).toEqual(['deepseek-v4-flash', 'gemini-2.5-flash-lite']);
			// The legacy bare Gemma id is not part of managed mode; Ollama
			// models surface through the dynamic `ollama/…` catalog instead.
			expect(models.filter(m => m.id === 'gemma4:31b')).toHaveLength(0);
		} finally {
			providersConfig = undefined;
		}
	});

	it('exposes nothing when managed mode has empty selections', async () => {
		providersConfig = { deepseek: { models: [] }, gemini: { models: [] }, ollama: { models: [] }, openrouter: { models: [] }, llamacpp: { models: [] } };
		try {
			const { provider } = createProvider({ keys: { 'nika.deepseek.apiKey': 'ds', 'nika.gemini.apiKey': 'gm', 'nika.openrouter.apiKey': 'or' } });

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(models).toEqual([]);
		} finally {
			providersConfig = undefined;
		}
	});

	it('pulls the wizard-selected Ollama models from the dynamic /api/tags catalog', async () => {
		providersConfig = { ollama: { models: ['ollama/gemma4:31b', 'ollama/qwen3:8b'] } };
		try {
			const fetcher = { fetch: vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ models: [{ name: 'gemma4:31b' }, { name: 'qwen3:8b' }, { name: 'llama3.3:70b' }] }),
			}) };
			const { provider } = createProvider({ fetcher });

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(fetcher.fetch).toHaveBeenCalledWith('http://localhost:11434/api/tags', { method: 'GET', callSite: 'nika-ollama-tags' });
			const ollamaIds = models.filter(m => m.id.startsWith('ollama/'));
			expect(ollamaIds.map(m => m.id).sort()).toEqual(['ollama/gemma4:31b', 'ollama/qwen3:8b']);
			expect(ollamaIds[0].name).toBe('gemma4:31b');
			expect(ollamaIds[0].detail).toBe('Nika');
			expect(ollamaIds[0].isBYOK).toBe(true);
			expect(ollamaIds[0].capabilities.toolCalling).toBe(true);
			expect(ollamaIds[0].capabilities.imageInput).toBe(true);
			expect(ollamaIds[0].statusIcon).toBeDefined();
		} finally {
			providersConfig = undefined;
		}
	});

	it('keeps listing models when the Ollama host is unreachable in managed mode', async () => {
		providersConfig = { deepseek: { models: ['deepseek-v4-flash'] }, ollama: { models: ['ollama/gemma4:31b'] } };
		try {
			const fetcher = { fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
			const { provider } = createProvider({ keys: { 'nika.deepseek.apiKey': 'ds' }, fetcher });

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(models.map(m => m.id)).toEqual(['deepseek-v4-flash']);
		} finally {
			providersConfig = undefined;
		}
	});

	it('filters the OpenRouter catalog to the wizard selection in managed mode', async () => {
		providersConfig = { openrouter: { models: ['openrouter/deepseek/deepseek-chat-v4-0324'] } };
		try {
			const { provider, fakes } = createProvider({
				keys: { 'nika.openrouter.apiKey': 'or-1' },
				catalog: new Map([
					['deepseek/deepseek-chat-v4-0324', { id: 'deepseek/deepseek-chat-v4-0324', name: 'DeepSeek Chat V4', capabilities: { name: 'DeepSeek Chat V4', toolCalling: true, vision: false, maxInputTokens: 128_000, maxOutputTokens: 8_192 } }],
					['anthropic/claude-sonnet-4', { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', capabilities: { name: 'Claude Sonnet 4', toolCalling: true, vision: false, maxInputTokens: 200_000, maxOutputTokens: 64_000 } }],
				]),
			});

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(fakes.openRouterProvider.getCatalog).toHaveBeenCalledWith('or-1');
			expect(models.filter(m => m.id.startsWith('openrouter/')).map(m => m.id)).toEqual(['openrouter/deepseek/deepseek-chat-v4-0324']);
		} finally {
			providersConfig = undefined;
		}
	});

	it('skips the whole OpenRouter catalog when nothing is selected in managed mode', async () => {
		providersConfig = { openrouter: { models: [] } };
		try {
			const { provider, fakes } = createProvider({
				keys: { 'nika.openrouter.apiKey': 'or-1' },
				catalog: new Map([['anthropic/claude-sonnet-4', { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', capabilities: { name: 'Claude Sonnet 4', toolCalling: true, vision: false, maxInputTokens: 200_000, maxOutputTokens: 64_000 } }]]),
			});

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(fakes.openRouterProvider.getCatalog).not.toHaveBeenCalled();
			expect(models.filter(m => m.id.startsWith('openrouter/'))).toHaveLength(0);
		} finally {
			providersConfig = undefined;
		}
	});

	it('rejects responses for models that are not selected in managed mode', async () => {
		providersConfig = { deepseek: { models: ['deepseek-v4-flash'] } };
		try {
			const { provider } = createProvider({ keys: { 'nika.deepseek.apiKey': 'ds' } });
			const model = { id: 'deepseek-v4-pro' } as NikaLanguageModelChatInformation;
			const { messages, options, progress, token } = deepSeekRequestArgs();

			await expect(provider.provideLanguageModelChatResponse(model, messages, options, progress, token))
				.rejects.toThrow('The Nika model deepseek-v4-pro is not enabled. Select it in the Providers page of Nika Settings first.');
		} finally {
			providersConfig = undefined;
		}
	});

	it('rejects the legacy bare Gemma id in managed mode (it is not in any selection)', async () => {
		providersConfig = { ollama: { models: ['ollama/gemma4:31b'] } };
		try {
			const { provider, fakes } = createProvider();
			const model = { id: 'gemma4:31b' } as NikaLanguageModelChatInformation;
			const { messages, options, progress, token } = deepSeekRequestArgs();

			await expect(provider.provideLanguageModelChatResponse(model, messages, options, progress, token))
				.rejects.toThrow('is not enabled');
			expect(fakes.ollamaProvider.provideLanguageModelChatResponse).not.toHaveBeenCalled();
		} finally {
			providersConfig = undefined;
		}
	});

	it('does not fetch the Ollama catalog in legacy mode (bare Gemma id only)', async () => {
		const fetcher = { fetch: vi.fn() };
		const { provider } = createProvider({ fetcher });

		const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

		expect(fetcher.fetch).not.toHaveBeenCalled();
		expect(models.filter(m => m.id === 'gemma4:31b')).toHaveLength(1);
		expect(models.filter(m => m.id.startsWith('ollama/'))).toHaveLength(0);
	});
});

describe('Nika Gemini catalog support', () => {
	const geminiCatalog = (): Map<string, { id: string; name: string; capabilities: { name: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; supportsReasoningEffort?: string[] } }> => new Map([
		['gemini-2.5-pro', { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', capabilities: { name: 'Gemini 2.5 Pro', toolCalling: true, vision: true, maxInputTokens: 1_000_000, maxOutputTokens: 65_536, supportsReasoningEffort: ['none', 'low', 'high'] } }],
		['gemini-2.0-flash', { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', capabilities: { name: 'Gemini 2.0 Flash', toolCalling: true, vision: true, maxInputTokens: 1_000_000, maxOutputTokens: 8_192 } }],
	]);

	it('lists only the wizard-selected Gemini catalog models in managed mode', async () => {
		providersConfig = { gemini: { models: ['gemini-2.5-flash', 'gemini/gemini-2.5-pro'] } };
		try {
			const { provider, fakes } = createProvider({ keys: { 'nika.gemini.apiKey': 'gm-1' }, geminiCatalog: geminiCatalog() });

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(fakes.geminiCatalogProvider.getCatalog).toHaveBeenCalledWith('gm-1');
			const catalogIds = models.filter(m => m.id.startsWith('gemini/'));
			expect(catalogIds.map(m => m.id)).toEqual(['gemini/gemini-2.5-pro']);
			expect(catalogIds[0].name).toBe('Gemini 2.5 Pro');
			expect(catalogIds[0].detail).toBe('Nika');
			expect(catalogIds[0].isBYOK).toBe(true);
			expect(catalogIds[0].capabilities.toolCalling).toBe(true);
			expect(catalogIds[0].capabilities.imageInput).toBe(true);
			// The selected native model still appears as a bare id.
			expect(models.map(m => m.id)).toContain('gemini-2.5-flash');
			// Unselected catalog models stay hidden.
			expect(models.map(m => m.id)).not.toContain('gemini/gemini-2.0-flash');
		} finally {
			providersConfig = undefined;
		}
	});

	it('never lists the Gemini catalog in legacy mode', async () => {
		const { provider, fakes } = createProvider({ keys: { 'nika.gemini.apiKey': 'gm-1' }, geminiCatalog: geminiCatalog() });

		const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

		expect(fakes.geminiCatalogProvider.getCatalog).not.toHaveBeenCalled();
		expect(models.filter(m => m.id.startsWith('gemini/'))).toHaveLength(0);
		// The classic native lineup is intact.
		expect(models.map(m => m.id)).toEqual(['gemma4:31b', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
	});

	it('skips the Gemini catalog when nothing is selected in managed mode', async () => {
		providersConfig = { gemini: { models: ['gemini-2.5-flash'] } };
		try {
			const { provider, fakes } = createProvider({ keys: { 'nika.gemini.apiKey': 'gm-1' }, geminiCatalog: geminiCatalog() });

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(fakes.geminiCatalogProvider.getCatalog).not.toHaveBeenCalled();
			expect(models.map(m => m.id)).toEqual(['gemini-2.5-flash']);
		} finally {
			providersConfig = undefined;
		}
	});

	it('still lists models when the Gemini catalog fetch fails', async () => {
		providersConfig = { gemini: { models: ['gemini/gemini-2.5-pro'] } };
		try {
			const { provider, fakes } = createProvider({ keys: { 'nika.gemini.apiKey': 'gm-1' } });
			vi.mocked(fakes.geminiCatalogProvider.getCatalog).mockRejectedValueOnce(new Error('HTTP 401'));

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(models.filter(m => m.id.startsWith('gemini/'))).toHaveLength(0);
		} finally {
			providersConfig = undefined;
		}
	});

	it('routes Gemini catalog models to the native delegate with the raw wire id', async () => {
		const { provider, fakes } = createProvider();
		const model = { id: 'gemini/gemini-2.5-pro' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

		expect(fakes.geminiProvider.provideLanguageModelChatResponse).toHaveBeenCalledTimes(1);
		const delegate = vi.mocked(fakes.geminiProvider.provideLanguageModelChatResponse).mock.calls[0][0] as { id: string; configuration: { apiKey: string } };
		expect(delegate.id).toBe('gemini-2.5-pro');
		expect(delegate.configuration.apiKey).toBe('test-key');
		expect(fakes.ollamaProvider.provideLanguageModelChatResponse).not.toHaveBeenCalled();
	});
});

describe('Nika Cursor support', () => {
	const cursorCatalog = (): Map<string, { id: string; name: string; capabilities: { name: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; supportsReasoningEffort?: string[] } }> => new Map([
		['cursor-fast', { id: 'cursor-fast', name: 'cursor-fast', capabilities: { name: 'cursor-fast', toolCalling: true, vision: true, maxInputTokens: 200_000, maxOutputTokens: 16_384 } }],
		['cursor-turbo', { id: 'cursor-turbo', name: 'cursor-turbo', capabilities: { name: 'cursor-turbo', toolCalling: true, vision: true, maxInputTokens: 200_000, maxOutputTokens: 16_384 } }],
	]);

	it('routes cursor models through the Cursor endpoint with native images', async () => {
		const { provider, fakes } = createProvider({ keys: { 'nika.cursor.apiKey': 'cur-1' } });
		const model = { id: 'cursor/cursor-fast' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

		expect(fakes.cursorProvider.createEndpoint).toHaveBeenCalledWith('cursor-fast', 'cur-1');
		// Cursor serves frontier multimodal models: images pass through
		// untouched (only PDFs are converted to text).
		expect(fakes.attachmentProcessor.process).toHaveBeenCalledWith(messages, token, { preserveImages: true });
		expect(fakes.lmWrapper.provideLanguageModelResponse).toHaveBeenCalledTimes(1);
		expect(fakes.ollamaProvider.provideLanguageModelChatResponse).not.toHaveBeenCalled();
	});

	it('rejects cursor models when the API key is missing', async () => {
		const { provider } = createProvider({ keys: { 'nika.cursor.apiKey': undefined } });
		const model = { id: 'cursor/cursor-fast' } as NikaLanguageModelChatInformation;
		const { messages, options, progress, token } = deepSeekRequestArgs();

		await expect(provider.provideLanguageModelChatResponse(model, messages, options, progress, token))
			.rejects.toThrow('Configure a Cursor API key in Nika Settings');
	});

	it('appends the Cursor catalog in legacy mode whenever a key exists', async () => {
		const { provider, fakes } = createProvider({ keys: { 'nika.cursor.apiKey': 'cur-1' }, cursorCatalog: cursorCatalog() });

		const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

		expect(fakes.cursorProvider.getCatalog).toHaveBeenCalledWith('cur-1');
		const cursorIds = models.filter(m => m.id.startsWith('cursor/'));
		expect(cursorIds.map(m => m.id).sort()).toEqual(['cursor/cursor-fast', 'cursor/cursor-turbo']);
		expect(cursorIds[0].detail).toBe('Nika');
		expect(cursorIds[0].isBYOK).toBe(true);
		expect(cursorIds[0].capabilities.imageInput).toBe(true);
		expect(cursorIds[0].statusIcon).toBeDefined();
	});

	it('filters the Cursor catalog to the wizard selection in managed mode', async () => {
		providersConfig = { cursor: { models: ['cursor/cursor-turbo'] } };
		try {
			const { provider, fakes } = createProvider({ keys: { 'nika.cursor.apiKey': 'cur-1' }, cursorCatalog: cursorCatalog() });

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(fakes.cursorProvider.getCatalog).toHaveBeenCalledWith('cur-1');
			expect(models.filter(m => m.id.startsWith('cursor/')).map(m => m.id)).toEqual(['cursor/cursor-turbo']);
		} finally {
			providersConfig = undefined;
		}
	});

	it('skips the whole Cursor catalog when nothing is selected in managed mode', async () => {
		providersConfig = { cursor: { models: [] } };
		try {
			const { provider, fakes } = createProvider({ keys: { 'nika.cursor.apiKey': 'cur-1' }, cursorCatalog: cursorCatalog() });

			const models = await provider.provideLanguageModelChatInformation(undefined as never, { isCancellationRequested: false } as never);

			expect(fakes.cursorProvider.getCatalog).not.toHaveBeenCalled();
			expect(models.filter(m => m.id.startsWith('cursor/'))).toHaveLength(0);
		} finally {
			providersConfig = undefined;
		}
	});

	it('rejects cursor requests for unselected models in managed mode', async () => {
		providersConfig = { cursor: { models: ['cursor/cursor-fast'] } };
		try {
			const { provider } = createProvider({ keys: { 'nika.cursor.apiKey': 'cur-1' } });
			const model = { id: 'cursor/cursor-turbo' } as NikaLanguageModelChatInformation;
			const { messages, options, progress, token } = deepSeekRequestArgs();

			await expect(provider.provideLanguageModelChatResponse(model, messages, options, progress, token))
				.rejects.toThrow('is not enabled');
		} finally {
			providersConfig = undefined;
		}
	});
});
