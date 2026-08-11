/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../../platform/endpoint/common/endpointProvider';
import { ICreateEndpointBodyOptions } from '../../../../platform/networking/common/networking';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
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
});
