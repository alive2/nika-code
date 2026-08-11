/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody } from '../../../platform/networking/common/networking';
import { isOpenAiFunctionTool, OpenAiResponsesFunctionTool } from '../../../platform/networking/common/fetch';
import { OpenAIEndpoint } from './openAIEndpoint';

function ensureObjectRootSchema(parameters: object | undefined): object {
	if (!parameters || Array.isArray(parameters)) {
		return { type: 'object', properties: {} };
	}
	const schema = parameters as Record<string, unknown>;
	if (schema.type === 'object') {
		return parameters;
	}
	return {
		...schema,
		type: 'object',
		properties: typeof schema.properties === 'object' && schema.properties !== null ? schema.properties : {},
	};
}

export function normalizeDeepSeekToolSchemas(body: IEndpointBody): void {
	if (!body.tools) {
		return;
	}
	for (const tool of body.tools) {
		if (isOpenAiFunctionTool(tool)) {
			tool.function.parameters = ensureObjectRootSchema(tool.function.parameters);
		} else if (tool.type === 'function') {
			const responsesTool = tool as OpenAiResponsesFunctionTool;
			responsesTool.parameters = ensureObjectRootSchema(responsesTool.parameters);
		}
	}
}

/** DeepSeek's OpenAI-compatible APIs differ in several important body fields. */
export class DeepSeekEndpoint extends OpenAIEndpoint {
	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		const body = super.createRequestBody(options);
		normalizeDeepSeekToolSchemas(body);
		const temperature = this._configurationService.getNonExtensionConfig<number>('nika.temperature') ?? 0.7;
		const defaultEffort = this._configurationService.getNonExtensionConfig<string>('nika.thinkingEffort') ?? 'high';
		const configuredEffort = options.modelCapabilities?.reasoningEffort;
		const effort = configuredEffort === 'none' || configuredEffort === 'low' || configuredEffort === 'high' || configuredEffort === 'max'
			? configuredEffort
			: (defaultEffort === 'none' || defaultEffort === 'low' || defaultEffort === 'max' ? defaultEffort : 'high');

		if (this.useResponsesApi) {
			body.model = this.model === 'deepseek-v4-flash-responses' ? 'deepseek-v4-flash' : this.model;
			body.max_output_tokens = this.maxOutputTokens;
			body.max_tokens = undefined;
			body.max_completion_tokens = undefined;
			body.reasoning = { effort };
			body.reasoning_effort = undefined;
			body.store = undefined;
			body.previous_response_id = undefined;
			body.include = undefined;
			body.temperature = effort === 'none' ? temperature : undefined;
			body.top_p = undefined;
		} else {
			body.model = this.model;
			body.max_tokens = this.maxOutputTokens;
			body.max_completion_tokens = undefined;
			body.reasoning = undefined;
			body.reasoning_effort = effort === 'none' ? undefined : effort;
			body.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
			body.temperature = effort === 'none' ? temperature : undefined;
			body.top_p = undefined;
		}
		return body;
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		if (!body) {
			return;
		}
		normalizeDeepSeekToolSchemas(body);
		if (this.useResponsesApi) {
			body.model = this.model === 'deepseek-v4-flash-responses' ? 'deepseek-v4-flash' : this.model;
			body.max_output_tokens = this.maxOutputTokens;
			delete body.max_completion_tokens;
			delete body.max_tokens;
			delete body.store;
			delete body.previous_response_id;
			delete body.include;
		} else {
			body.max_tokens = this.maxOutputTokens;
			delete body.max_completion_tokens;
		}
		const thinkingDisabled = this.useResponsesApi ? body.reasoning?.effort === 'none' : body.thinking?.type === 'disabled';
		body.temperature = thinkingDisabled ? (this._configurationService.getNonExtensionConfig<number>('nika.temperature') ?? 0.7) : undefined;
		delete body.top_p;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const modelInfo = {
			...this.modelMetadata,
			capabilities: {
				...this.modelMetadata.capabilities,
				limits: { ...this.modelMetadata.capabilities.limits, max_prompt_tokens: modelMaxPromptTokens },
			},
		};
		return this.instantiationService.createInstance(DeepSeekEndpoint, modelInfo, this._apiKey, this._modelUrl);
	}
}
