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
import { NikaSettingsEditor } from '../nikaSettingsEditor';
import { NikaUsageStatus } from '../nikaUsageStatus';
import { NikaUsageTracker } from '../nikaUsageTracker';
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
			getConfiguration: vi.fn(() => ({ get: (_key: string, fallback: unknown) => fallback })),
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

function createContext() {
	return {
		secrets: {
			get: vi.fn().mockResolvedValue('test-key'),
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
	return { lmWrapper, geminiProvider, ollamaProvider, usageTracker, attachmentProcessor };
}

function createProvider() {
	const fakes = createFakes();
	const instantiation = createInstantiationService(fakes);
	const provider = new NikaLMProvider(
		createByokStorage() as never,
		createContext(),
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
