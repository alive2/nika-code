/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody } from '../../../platform/networking/common/networking';
import { OpenAIEndpoint } from './openAIEndpoint';

/**
 * Z.ai (Zhipu GLM) exposes two thinking surfaces on its OpenAI-compatible
 * `/chat/completions` endpoint:
 *
 * - A binary switch — `thinking: { type: 'enabled' | 'disabled' }` — used by
 *   older GLM generations (GLM-5.1 and below). These advertise the levels
 *   `none` (thinking off) and `high` (thinking on).
 * - An OpenAI-style top-level `reasoning_effort` magnitude — `max`/`high`/
 *   `low` — accepted by GLM-5.2 and newer, alongside the switch. GLM-5.3 /
 *   GLM-5.3-Flash force thinking on (the API rejects `disabled`), advertise
 *   only `low`/`high`/`max`, and error on any other value; GLM-5.2 accepts
 *   `none` as well, which stops thinking.
 *
 * Nika's picker advertises exactly the levels each model accepts (see the
 * catalog in `nikaZaiProvider.ts`), and this endpoint translates the resolved
 * level into the wire parameters. Effort-capable models keep the base class's
 * `reasoning_effort` (declared-set validated); binary-switch models scrub
 * every effort field the generic OpenAI-compatible base class would otherwise
 * emit (older GLM ignores `reasoning_effort`, and some gateways reject
 * unknown fields outright).
 *
 * See https://docs.z.ai/guides/capabilities/thinking-mode (switch) and
 * https://docs.z.ai/guides/capabilities/thinking (reasoning_effort).
 */
export class ZaiEndpoint extends OpenAIEndpoint {

	private _isChatCompletions(): boolean {
		return !this.useResponsesApi && !this.useMessagesApi;
	}

	/**
	 * Whether the model accepts the top-level `reasoning_effort` magnitude.
	 * GLM-5.2+ models do (the catalog advertises their levels); binary-switch
	 * generations advertise subsets of `none`/`high`, which never include
	 * `max`, so the declared level set itself is the discriminator.
	 */
	private _supportsReasoningEffort(): boolean {
		return (this.supportsReasoningEffort ?? []).includes('max');
	}

	/**
	 * The thinking-effort selection for this request: the per-request model
	 * picker value wins, then the global Nika thinking-effort setting. No
	 * selection at all yields `undefined`, which leaves the wire param to the
	 * platform default (GLM servers default to their deepest reasoning).
	 */
	private _requestedEffort(options: ICreateEndpointBodyOptions): string | undefined {
		return options.modelCapabilities?.reasoningEffort
			?? this._configurationService.getNonExtensionConfig<string>('nika.thinkingEffort');
	}

	/**
	 * Resolve whether the request should run with thinking enabled. The
	 * per-request selection (model picker) wins; otherwise fall back to the
	 * Nika thinking effort setting so the global "thinking off" intent is
	 * honored. Only `none` turns thinking off, and only on models that
	 * advertise it — forced-thinking models (GLM-5.3 pair) never do and stay
	 * enabled regardless.
	 */
	private _thinkingEnabled(options: ICreateEndpointBodyOptions): boolean {
		const declared = this.supportsReasoningEffort ?? [];
		if (declared.length === 0) {
			return true;
		}
		const requested = this._requestedEffort(options);
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
		if (!this._supportsReasoningEffort()) {
			// Binary-switch GLM generations ignore reasoning_effort; scrub it
			// here again so nothing leaks past {@link _applyZaiThinking}.
			body.reasoning_effort = undefined;
		}
		body.reasoning = undefined;
	}

	private _applyZaiThinking(body: IEndpointBody, options: ICreateEndpointBodyOptions): void {
		const thinkingDisabled = !this._thinkingEnabled(options);
		body.thinking = { type: thinkingDisabled ? 'disabled' : 'enabled' };
		if (this._supportsReasoningEffort()) {
			// GLM-5.2+ accepts the effort magnitude alongside the switch; keep
			// whatever the base class already validated against the declared
			// levels (override setting or per-request selection) and otherwise
			// honor the Nika effort setting. While thinking is off the
			// magnitude is meaningless, so drop it.
			if (thinkingDisabled) {
				body.reasoning_effort = undefined;
			} else if (body.reasoning_effort === undefined) {
				const requested = this._requestedEffort(options);
				if (requested && this.supportsReasoningEffort!.includes(requested)) {
					body.reasoning_effort = requested;
				}
			}
			body.reasoning = undefined;
			return;
		}
		// Older GLM generations reason only through the binary switch and
		// ignore reasoning_effort; keep the wire clean and unambiguous.
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
