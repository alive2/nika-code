/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody } from '../../../platform/networking/common/networking';
import { OpenAIEndpoint } from './openAIEndpoint';

/**
 * Z.ai (Zhipu GLM) has no OpenAI-style `reasoning_effort` magnitudes: the
 * platform ignores that field entirely and exposes a binary thinking switch
 * instead — `thinking: { type: 'enabled' | 'disabled' }`. GLM-5.3 and
 * GLM-5.3-Flash force thinking on (it cannot be disabled); every other GLM
 * model thinks by default but accepts `disabled`.
 *
 * Nika's picker therefore advertises the levels `none` (thinking off) and
 * `high` (thinking on, the platform default) — forced-thinking models only
 * advertise `high` — and this endpoint translates the resolved level into
 * the wire parameter, then scrubs every effort field the generic
 * OpenAI-compatible base class would otherwise emit (Z.ai ignores
 * `reasoning_effort`, and some gateways reject unknown fields outright).
 *
 * See https://docs.z.ai/guides/capabilities/thinking-mode for the switch.
 */
export class ZaiEndpoint extends OpenAIEndpoint {

	private _isChatCompletions(): boolean {
		return !this.useResponsesApi && !this.useMessagesApi;
	}

	/**
	 * Resolve whether the request should run with thinking enabled. The
	 * per-request selection (model picker) wins; otherwise fall back to the
	 * Nika thinking effort setting so the global "thinking off" intent is
	 * honored. Anything other than `none` maps to thinking on, and models
	 * that never advertise `none` (forced thinking) stay enabled regardless.
	 */
	private _thinkingEnabled(options: ICreateEndpointBodyOptions): boolean {
		const declared = this.supportsReasoningEffort ?? [];
		if (declared.length === 0) {
			return true;
		}
		const requested = options.modelCapabilities?.reasoningEffort
			?? this._configurationService.getNonExtensionConfig<string>('nika.thinkingEffort')
			?? 'high';
		return !(requested === 'none' && declared.includes('none'));
	}

	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		const body = super.createRequestBody(options);
		if (this._isChatCompletions()) {
			this._applyZaiThinking(body, options);
		}
		return body;
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		if (!body || !this._isChatCompletions()) {
			return;
		}
		// GLM accepts `max_tokens` and has no `max_completion_tokens`; undo
		// the o1/o3-style rename the base class applies to thinking models.
		body.max_tokens = this.maxOutputTokens;
		delete body.max_completion_tokens;
		// The base class removed temperature (and the thinking body was set in
		// {@link createRequestBody}); GLM only accepts temperature while
		// thinking is disabled, so restore it there from the Nika setting.
		const thinkingDisabled = body.thinking?.type === 'disabled';
		body.temperature = thinkingDisabled ? (this._configurationService.getNonExtensionConfig<number>('nika.temperature') ?? 0.7) : undefined;
		// Z.ai ignores reasoning_effort; keep the wire clean and unambiguous.
		body.reasoning_effort = undefined;
		body.reasoning = undefined;
	}

	private _applyZaiThinking(body: IEndpointBody, options: ICreateEndpointBodyOptions): void {
		const thinkingDisabled = !this._thinkingEnabled(options);
		body.thinking = { type: thinkingDisabled ? 'disabled' : 'enabled' };
		body.reasoning_effort = undefined;
		body.reasoning = undefined;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const modelInfo = {
			...this.modelMetadata,
			capabilities: {
				...this.modelMetadata.capabilities,
				limits: { ...this.modelMetadata.capabilities.limits, max_prompt_tokens: modelMaxPromptTokens },
			},
		};
		return this.instantiationService.createInstance(ZaiEndpoint, modelInfo, this._apiKey, this._modelUrl);
	}
}
