/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFetchResponseType, ChatResponse } from '../../../../platform/chat/common/commonTypes';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../../platform/endpoint/common/endpointProvider';
import { ChatEndpoint } from '../../../../platform/endpoint/node/chatEndpoint';
import { ICreateEndpointBodyOptions, IMakeChatRequestOptions } from '../../../../platform/networking/common/networking';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { DeepSeekEndpoint } from '../deepSeekEndpoint';

function metadata(id: string, endpoint: ModelSupportedEndpoint): IChatModelInformation {
	return {
		id,
		name: id,
		vendor: 'Nika',
		version: '1.0',
		model_picker_enabled: true,
		is_chat_default: false,
		is_chat_fallback: false,
		supported_endpoints: [endpoint],
		capabilities: {
			type: 'chat', family: id, tokenizer: 'o200k_base' as any,
			supports: { streaming: true, tool_calls: true, vision: false, thinking: true, reasoning_effort: ['none', 'low', 'high', 'max'] },
			limits: { max_prompt_tokens: 128_000, max_output_tokens: 8_000, max_context_window_tokens: 136_000 },
		},
	};
}

function options(effort: string): ICreateEndpointBodyOptions {
	return {
		debugName: 'nika-test',
		messages: [{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'hello' }] }],
		requestId: 'nika-request',
		postOptions: {},
		finishedCb: undefined,
		location: undefined as any,
		modelCapabilities: { reasoningEffort: effort },
	};
}

describe('DeepSeekEndpoint', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;

	beforeEach(async () => {
		accessor = disposables.add(createExtensionUnitTestingServices().createTestingAccessor());
		instantiationService = accessor.get(IInstantiationService);
		const configurationService = accessor.get(IConfigurationService);
		const getNonExtensionConfig = configurationService.getNonExtensionConfig.bind(configurationService);
		configurationService.getNonExtensionConfig = <T>(key: string) => {
			if (key === 'nika.temperature') { return 0.7 as T; }
			if (key === 'nika.thinkingEffort') { return 'high' as T; }
			return getNonExtensionConfig<T>(key);
		};
	});

	afterEach(() => disposables.clear());

	it.each(['low', 'high', 'max'])('maps %s thinking for Chat Completions', effort => {
		const endpoint = instantiationService.createInstance(DeepSeekEndpoint, metadata('deepseek-v4-flash', ModelSupportedEndpoint.ChatCompletions), 'secret', 'https://api.deepseek.com/chat/completions');
		const body = endpoint.createRequestBody(options(effort));
		endpoint.interceptBody(body);
		expect(body.thinking).toEqual({ type: 'enabled' });
		expect(body.reasoning_effort).toBe(effort);
		expect(body.max_tokens).toBe(8_000);
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.temperature).toBeUndefined();
		expect(body.top_p).toBeUndefined();
	});

	it('disables thinking and permits configured temperature', () => {
		const endpoint = instantiationService.createInstance(DeepSeekEndpoint, metadata('deepseek-v4-pro', ModelSupportedEndpoint.ChatCompletions), 'secret', 'https://api.deepseek.com/chat/completions');
		const body = endpoint.createRequestBody(options('none'));
		endpoint.interceptBody(body);
		expect(body.thinking).toEqual({ type: 'disabled' });
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.temperature).toBe(0.7);
	});

	it.each(['deepseek-v4-flash-responses', 'deepseek-v4-pro-responses'])('strips the -responses suffix on the Chat Completions branch too (%s)', model => {
		// Defensive hardening: a `-responses` id routed to the Chat Completions
		// URL must never reach the wire verbatim.
		const endpoint = instantiationService.createInstance(DeepSeekEndpoint, metadata(model, ModelSupportedEndpoint.ChatCompletions), 'secret', 'https://api.deepseek.com/chat/completions');
		const body = endpoint.createRequestBody(options('high'));
		endpoint.interceptBody(body);
		expect(body.model).toBe(model.slice(0, -'-responses'.length));
		expect(body.max_tokens).toBe(8_000);
	});

	it.each(['none', 'low', 'high', 'max'])('aliases the Responses model and maps %s effort', effort => {
		const endpoint = instantiationService.createInstance(DeepSeekEndpoint, metadata('deepseek-v4-flash-responses', ModelSupportedEndpoint.Responses), 'secret', 'https://api.deepseek.com/responses');
		const body = endpoint.createRequestBody(options(effort));
		endpoint.interceptBody(body);
		expect(body.model).toBe('deepseek-v4-flash');
		expect(body.reasoning).toEqual({ effort });
		expect(body.max_output_tokens).toBe(8_000);
		expect(body.store).toBeUndefined();
		expect(body.previous_response_id).toBeUndefined();
	});

	it('aliases the Pro Responses model to deepseek-v4-pro on the wire', () => {
		const endpoint = instantiationService.createInstance(DeepSeekEndpoint, metadata('deepseek-v4-pro-responses', ModelSupportedEndpoint.Responses), 'secret', 'https://api.deepseek.com/responses');
		const body = endpoint.createRequestBody(options('high'));
		endpoint.interceptBody(body);
		expect(body.model).toBe('deepseek-v4-pro');
		expect(body.reasoning).toEqual({ effort: 'high' });
		expect(body.max_output_tokens).toBe(8_000);
		expect(body.store).toBeUndefined();
		expect(body.previous_response_id).toBeUndefined();
	});

	it('never honors stateful markers so stateless tool outputs stay paired with their calls', async () => {
		const endpoint = instantiationService.createInstance(DeepSeekEndpoint, metadata('deepseek-v4-flash-responses', ModelSupportedEndpoint.Responses), 'secret', 'https://api.deepseek.com/responses');
		const parentResponse: ChatResponse = {
			type: ChatFetchResponseType.Success,
			requestId: 'request-id',
			serverRequestId: 'server-request-id',
			usage: undefined,
			resolvedModel: 'deepseek-v4-flash-responses',
			value: ''
		};
		const parentRequestSpy = vi.spyOn(ChatEndpoint.prototype, 'makeChatRequest2').mockResolvedValue(parentResponse);

		const requestOptions: IMakeChatRequestOptions = {
			debugName: 'nika-test',
			messages: [{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'hello' }] }],
			finishedCb: undefined,
			location: undefined as any,
		};
		await endpoint.makeChatRequest2(requestOptions, CancellationToken.None);

		expect(parentRequestSpy).toHaveBeenCalledOnce();
		expect(parentRequestSpy.mock.calls[0][0].ignoreStatefulMarker).toBe(true);
	});

	it('normalizes empty and invalid Responses tool schemas to object-root JSON Schema', () => {
		const endpoint = instantiationService.createInstance(DeepSeekEndpoint, metadata('deepseek-v4-flash-responses', ModelSupportedEndpoint.Responses), 'secret', 'https://api.deepseek.com/responses');
		const body = endpoint.createRequestBody(options('high'));
		body.tools = [
			{ type: 'function', name: 'missing_schema', description: '', parameters: {} },
			{ type: 'function', name: 'null_schema', description: '', parameters: { type: null, properties: null } },
		];
		endpoint.interceptBody(body);
		expect(body.tools).toEqual([
			{ type: 'function', name: 'missing_schema', description: '', parameters: { type: 'object', properties: {} } },
			{ type: 'function', name: 'null_schema', description: '', parameters: { type: 'object', properties: {} } },
		]);
	});
});
