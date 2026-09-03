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
import { ZaiEndpoint } from '../zaiEndpoint';

function metadata(id: string, effortLevels: string[]): IChatModelInformation {
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
			supports: { streaming: true, tool_calls: true, vision: false, thinking: true, reasoning_effort: effortLevels },
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

function zaiEndpoint(instantiationService: IInstantiationService, id: string, effortLevels: string[]): ZaiEndpoint {
	return instantiationService.createInstance(ZaiEndpoint, metadata(id, effortLevels), 'secret', 'https://api.z.ai/api/paas/v4/chat/completions');
}

describe('ZaiEndpoint', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;
	// The stub below returns this for `nika.thinkingEffort`, so tests can
	// exercise the config fallback path (per-request selection absent).
	let thinkingEffortSetting = 'high';

	beforeEach(async () => {
		accessor = disposables.add(createExtensionUnitTestingServices().createTestingAccessor());
		instantiationService = accessor.get(IInstantiationService);
		const configurationService = accessor.get(IConfigurationService);
		const getNonExtensionConfig = configurationService.getNonExtensionConfig.bind(configurationService);
		configurationService.getNonExtensionConfig = <T>(key: string) => {
			if (key === 'nika.temperature') { return 0.7 as T; }
			if (key === 'nika.thinkingEffort') { return thinkingEffortSetting as T; }
			return getNonExtensionConfig<T>(key);
		};
		thinkingEffortSetting = 'high';
	});

	afterEach(() => disposables.clear());

	it.each(['low', 'high', 'max'])('maps %s thinking to the enabled wire switch', effort => {
		const endpoint = zaiEndpoint(instantiationService, 'glm-4.7', ['none', 'high']);
		const body = endpoint.createRequestBody(options(effort));
		endpoint.interceptBody(body);
		expect(body.thinking).toEqual({ type: 'enabled' });
		// Z.ai ignores reasoning_effort; it must never reach the wire.
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.reasoning).toBeUndefined();
		expect(body.max_tokens).toBe(8_000);
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.temperature).toBeUndefined();
	});

	it('maps none to a disabled thinking switch with configured temperature', () => {
		const endpoint = zaiEndpoint(instantiationService, 'glm-4.7', ['none', 'high']);
		const body = endpoint.createRequestBody(options('none'));
		endpoint.interceptBody(body);
		expect(body.thinking).toEqual({ type: 'disabled' });
		expect(body.reasoning_effort).toBeUndefined();
		// GLM only accepts temperature while thinking is off.
		expect(body.temperature).toBe(0.7);
		expect(body.max_tokens).toBe(8_000);
	});

	it('keeps forced-thinking ids enabled even for none', () => {
		// GLM-5.3 / GLM-5.3-Flash cannot disable thinking; the catalog only
		// advertises `high` for them, and `none` must not leak through.
		const endpoint = zaiEndpoint(instantiationService, 'glm-5.3', ['high']);
		const body = endpoint.createRequestBody(options('none'));
		endpoint.interceptBody(body);
		expect(body.thinking).toEqual({ type: 'enabled' });
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.temperature).toBeUndefined();
	});

	it('falls back to the Nika thinking effort setting when no level is selected', () => {
		const noSelection = { ...options('high'), modelCapabilities: undefined };
		const endpoint = zaiEndpoint(instantiationService, 'glm-4.7', ['none', 'high']);

		thinkingEffortSetting = 'none';
		let body = endpoint.createRequestBody(noSelection);
		endpoint.interceptBody(body);
		expect(body.thinking).toEqual({ type: 'disabled' });

		thinkingEffortSetting = 'high';
		body = endpoint.createRequestBody(noSelection);
		endpoint.interceptBody(body);
		expect(body.thinking).toEqual({ type: 'enabled' });
	});

	it('prefers the per-request selection over the global setting', () => {
		const endpoint = zaiEndpoint(instantiationService, 'glm-4.7', ['none', 'high']);
		thinkingEffortSetting = 'none';

		const body = endpoint.createRequestBody(options('high'));
		endpoint.interceptBody(body);
		expect(body.thinking).toEqual({ type: 'enabled' });
	});

	it('keeps translating thinking after cloneWithTokenOverride', () => {
		const endpoint = zaiEndpoint(instantiationService, 'glm-4.7', ['none', 'high']);
		const clone = endpoint.cloneWithTokenOverride(64_000);
		expect(clone).toBeInstanceOf(ZaiEndpoint);
		const body = (clone as ZaiEndpoint).createRequestBody(options('none'));
		(clone as ZaiEndpoint).interceptBody(body);
		expect(body.thinking).toEqual({ type: 'disabled' });
		expect(body.max_tokens).toBe(8_000);
	});
});
