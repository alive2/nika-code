/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { ChatCompletionContentPartKind } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFetchResponseType } from '../../../../platform/chat/common/commonTypes';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../../platform/endpoint/common/endpointProvider';
import { FinishedCallback } from '../../../../platform/networking/common/fetch';
import { IMakeChatRequestOptions } from '../../../../platform/networking/common/networking';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { DeepSeekWebClient, DeepSeekWebCompletionOptions } from '../deepSeekWebClient';
import { DeepSeekWebEndpoint, DeepSeekWebSessionCache } from '../deepSeekWebEndpoint';

function metadata(id = 'deepseekweb/deepseek-chat'): IChatModelInformation {
	return {
		id,
		name: id,
		vendor: 'Nika',
		version: '1.0',
		model_picker_enabled: true,
		is_chat_default: false,
		is_chat_fallback: false,
		supported_endpoints: [ModelSupportedEndpoint.ChatCompletions],
		capabilities: {
			type: 'chat', family: id, tokenizer: 'o200k_base' as any,
			supports: { streaming: true, tool_calls: false, vision: true, thinking: true, reasoning_effort: ['none', 'low', 'high'] },
			limits: { max_prompt_tokens: 120_000, max_output_tokens: 8_000, max_context_window_tokens: 128_000 },
		},
	};
}

type MockedClient = DeepSeekWebClient & { uploadFile: ReturnType<typeof vi.fn>; streamCompletion: ReturnType<typeof vi.fn> };

/** Stub web client: scriptable uploads and stream. */
function stubClient(streamImpl?: () => AsyncGenerator<string, void, unknown>): MockedClient {
	return {
		uploadFile: vi.fn(async () => 'file-1'),
		streamCompletion: vi.fn((options: DeepSeekWebCompletionOptions, _token: CancellationToken) => {
			const gen = streamImpl ? streamImpl() : (async function* () { yield 'a'; yield 'b'; })();
			return gen;
		}),
	} as unknown as MockedClient;
}

function sessionCache(): DeepSeekWebSessionCache & { getOrCreate: ReturnType<typeof vi.fn> } {
	return {
		getOrCreate: vi.fn(async () => 'session-1'),
	};
}

function requestOptions(overrides: Partial<IMakeChatRequestOptions> = {}): IMakeChatRequestOptions {
	return {
		debugName: 'nika-test',
		messages: [
			{ role: Raw.ChatRole.System, content: [{ type: ChatCompletionContentPartKind.Text, text: 'You are Nika.' }] },
			{ role: Raw.ChatRole.User, content: [{ type: ChatCompletionContentPartKind.Text, text: 'hello' }] },
		],
		finishedCb: undefined,
		location: undefined as any,
		modelCapabilities: { reasoningEffort: 'high' },
		...overrides,
	};
}

describe('DeepSeekWebEndpoint', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;

	beforeEach(async () => {
		accessor = disposables.add(createExtensionUnitTestingServices().createTestingAccessor());
		instantiationService = accessor.get(IInstantiationService);
	});

	afterEach(() => disposables.clear());

	function createEndpoint(client: DeepSeekWebClient, cache: DeepSeekWebSessionCache, sessionKey = 'chat-key', modelId = 'deepseekweb/deepseek-chat'): DeepSeekWebEndpoint {
		return instantiationService.createInstance(DeepSeekWebEndpoint, metadata(modelId), client, cache, sessionKey);
	}

	it('flattens roles and text into a transcript', async () => {
		const client = stubClient();
		const endpoint = createEndpoint(client, sessionCache());
		const processed = await (endpoint as unknown as { _buildPrompt(messages: Raw.ChatMessage[]): Promise<{ prompt: string; refFileIds: string[] }> })._buildPrompt(requestOptions().messages as Raw.ChatMessage[]);
		expect(processed.prompt).toBe('System: You are Nika.\n\nUser: hello');
		expect(processed.refFileIds).toEqual([]);
	});

	it('uploads image parts and references them as [Image N]', async () => {
		const client = stubClient();
		const endpoint = createEndpoint(client, sessionCache());
		const processed = await (endpoint as unknown as { _buildPrompt(messages: Raw.ChatMessage[]): Promise<{ prompt: string; refFileIds: string[] }> })._buildPrompt([
			{ role: Raw.ChatRole.User, content: [
				{ type: ChatCompletionContentPartKind.Text, text: 'What is in this image? ' },
				{ type: ChatCompletionContentPartKind.Image, imageUrl: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } },
			] },
			{ role: Raw.ChatRole.User, content: [
				{ type: ChatCompletionContentPartKind.Image, imageUrl: { url: 'data:image/jpeg;base64,/9j/4AAQ==' } },
			] },
		]);
		expect(processed.prompt).toBe('User: What is in this image? [Image 1]\n\nUser: [Image 2]');
		expect(processed.refFileIds).toEqual(['file-1', 'file-1']);
		expect(client.uploadFile).toHaveBeenCalledTimes(2);
		expect(client.uploadFile).toHaveBeenNthCalledWith(1, expect.any(Buffer), 'image-1.png', 'image/png');
		expect(client.uploadFile).toHaveBeenNthCalledWith(2, expect.any(Buffer), 'image-2.jpg', 'image/jpeg');
	});

	it('marks leftover document parts and drops empty messages', async () => {
		const client = stubClient();
		const endpoint = createEndpoint(client, sessionCache());
		const processed = await (endpoint as unknown as { _buildPrompt(messages: Raw.ChatMessage[]): Promise<{ prompt: string; refFileIds: string[] }> })._buildPrompt([
			{ role: Raw.ChatRole.User, content: [] },
			{ role: Raw.ChatRole.User, content: [{ type: ChatCompletionContentPartKind.Document, documentData: { data: 'eA==', mediaType: 'application/pdf' } }] },
		]);
		// Nika converts PDFs to text before this endpoint; anything still here
		// becomes a defensive marker instead of being dropped silently.
		expect(processed.prompt).toBe('User: [Document]');
	});

	it('streams a completion to a Success response and passes thinking/reasoning through', async () => {
		const client = stubClient();
		const cache = sessionCache();
		const finishedCb = vi.fn<FinishedCallback>(async () => undefined);
		const endpoint = createEndpoint(client, cache, 'chat-key');
		const response = await endpoint.makeChatRequest2(requestOptions({ finishedCb }), CancellationToken.None);
		expect(response.type).toBe(ChatFetchResponseType.Success);
		if (response.type === ChatFetchResponseType.Success) {
			expect(response.value).toBe('ab');
		}
		// Session reuse and thinking mapping.
		expect(cache.getOrCreate).toHaveBeenCalledWith('chat-key');
		const streamOptions = client.streamCompletion.mock.calls[0][0] as DeepSeekWebCompletionOptions;
		expect(streamOptions.chatSessionId).toBe('session-1');
		expect(streamOptions.thinkingEnabled).toBe(true);
		// Instant (default) mode.
		expect(streamOptions.modelType).toBe('default');
		// Finished callback receives cumulative text with deltas.
		expect(finishedCb).toHaveBeenCalledTimes(2);
		expect(finishedCb.mock.calls[0][0]).toBe('a');
		expect(finishedCb.mock.calls[1][0]).toBe('ab');
	});

	it('maps expert and vision models to their web model types', async () => {
		const chat = stubClient();
		await createEndpoint(chat, sessionCache()).makeChatRequest2(requestOptions(), CancellationToken.None);
		expect((chat.streamCompletion.mock.calls[0][0] as DeepSeekWebCompletionOptions).modelType).toBe('default');

		const expertClient = stubClient();
		await createEndpoint(expertClient, sessionCache(), 'chat-key', 'deepseekweb/deepseek-expert').makeChatRequest2(requestOptions(), CancellationToken.None);
		expect((expertClient.streamCompletion.mock.calls[0][0] as DeepSeekWebCompletionOptions).modelType).toBe('expert');

		const visionClient = stubClient();
		await createEndpoint(visionClient, sessionCache(), 'chat-key', 'deepseekweb/deepseek-vision').makeChatRequest2(requestOptions(), CancellationToken.None);
		expect((visionClient.streamCompletion.mock.calls[0][0] as DeepSeekWebCompletionOptions).modelType).toBe('vision');
	});

	it('rejects image parts in expert mode', async () => {
		const endpoint = createEndpoint(stubClient(), sessionCache(), 'chat-key', 'deepseekweb/deepseek-expert');
		await expect((endpoint as unknown as { _buildPrompt(messages: Raw.ChatMessage[]): Promise<{ prompt: string; refFileIds: string[] }> })._buildPrompt([
			{ role: Raw.ChatRole.User, content: [
				{ type: ChatCompletionContentPartKind.Image, imageUrl: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } },
			] },
		])).rejects.toThrow('DeepSeek Web Expert mode does not accept images; use the Chat or Vision model instead.');
	});

	it('disables thinking when reasoning effort is none', async () => {
		const client = stubClient();
		const endpoint = createEndpoint(client, sessionCache());
		await endpoint.makeChatRequest2(requestOptions({ modelCapabilities: { reasoningEffort: 'none' } }), CancellationToken.None);
		const streamOptions = client.streamCompletion.mock.calls[0][0] as DeepSeekWebCompletionOptions;
		expect(streamOptions.thinkingEnabled).toBe(false);
	});

	it('stops the stream when the finished callback returns a stop code', async () => {
		const client = stubClient();
		const endpoint = createEndpoint(client, sessionCache());
		const response = await endpoint.makeChatRequest2(requestOptions({ finishedCb: vi.fn(async () => 1) }), CancellationToken.None);
		expect(response.type).toBe(ChatFetchResponseType.Success);
		if (response.type === ChatFetchResponseType.Success) {
			expect(response.value).toBe('a');
		}
	});

	it('returns Failed with the error reason', async () => {
		const client = stubClient(async function* () { throw new Error('boom'); });
		const endpoint = createEndpoint(client, sessionCache());
		const response = await endpoint.makeChatRequest2(requestOptions(), CancellationToken.None);
		expect(response.type).toBe(ChatFetchResponseType.Failed);
		if (response.type === ChatFetchResponseType.Failed) {
			expect(response.reason).toBe('boom');
		}
	});

	it('returns Canceled when the token was cancelled', async () => {
		const client = stubClient(async function* () { throw new Error('boom'); });
		const endpoint = createEndpoint(client, sessionCache());
		const source = new CancellationTokenSource();
		source.cancel();
		const response = await endpoint.makeChatRequest2(requestOptions(), source.token);
		expect(response.type).toBe(ChatFetchResponseType.Canceled);
		source.dispose();
	});
});
