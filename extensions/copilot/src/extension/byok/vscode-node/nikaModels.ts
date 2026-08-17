/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { BYOKModelCapabilities } from '../common/byokProvider';

export const NIKA_PROVIDER_ID = 'nika';
export const NIKA_PROVIDER_NAME = 'Nika';

export const NIKA_DEEPSEEK_SECRET = 'nika.deepseek.apiKey';
export const NIKA_GEMINI_SECRET = 'nika.gemini.apiKey';

/**
 * Master switch for GitHub Copilot integration. Off (the default) makes
 * NikaCode run entirely on BYOK models without a GitHub account: no sign-in
 * prompts, no Copilot utility models, no GitHub MCP server. Turn it on to
 * restore upstream Copilot behavior.
 */
export const NIKA_GITHUB_ENABLED_CONFIG_KEY = 'nika.github.enabled';

export type NikaModelId =
	| 'deepseek-v4-flash'
	| 'deepseek-v4-pro'
	| 'deepseek-v4-flash-responses'
	| 'deepseek-v4-pro-responses'
	| 'gemini-2.5-flash'
	| 'gemini-2.5-flash-lite'
	| 'gemma4:31b';

export const NIKA_DEEPSEEK_MODEL_IDS: readonly NikaModelId[] = [
	'deepseek-v4-flash',
	'deepseek-v4-pro',
	'deepseek-v4-flash-responses',
	'deepseek-v4-pro-responses',
];

export const NIKA_GEMINI_MODEL_IDS: readonly NikaModelId[] = [
	'gemini-2.5-flash',
	'gemini-2.5-flash-lite',
];

export const NIKA_GEMMA_MODEL_ID: NikaModelId = 'gemma4:31b';

export const NIKA_CONTEXT_PRESETS = {
	'32K': 32_000,
	'64K': 64_000,
	'128K': 128_000,
	'256K': 256_000,
	'512K': 512_000,
	'1M': 1_000_000,
} as const;

export const NIKA_OUTPUT_PRESETS = {
	'4K': 4_000,
	'8K': 8_000,
	'16K': 16_000,
	'32K': 32_000,
	'64K': 64_000,
	'128K': 128_000,
	'384K': 384_000,
} as const;

export type NikaContextPreset = keyof typeof NIKA_CONTEXT_PRESETS;
export type NikaOutputPreset = keyof typeof NIKA_OUTPUT_PRESETS;
export type NikaThinkingEffort = 'none' | 'low' | 'high' | 'max';
export type NikaAgentRole = 'plan' | 'explore' | 'utility' | 'utilitySmall' | 'inlineChat';

export const NIKA_RESPONSES_MODEL = 'nika/deepseek-v4-flash-responses';
export const NIKA_AGENT_DEFAULTS: Record<NikaAgentRole, { readonly model: string; readonly effort: NikaThinkingEffort }> = {
	plan: { model: NIKA_RESPONSES_MODEL, effort: 'max' },
	explore: { model: NIKA_RESPONSES_MODEL, effort: 'none' },
	utility: { model: NIKA_RESPONSES_MODEL, effort: 'high' },
	utilitySmall: { model: NIKA_RESPONSES_MODEL, effort: 'none' },
	inlineChat: { model: NIKA_RESPONSES_MODEL, effort: 'none' },
};

export interface NikaTokenLimits {
	readonly contextWindow: number;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
}

/**
 * DeepSeek V4 has a 1M combined context window and a 384K output ceiling. The
 * user-facing context preset is the desired input allowance, not the combined
 * window, so it is clamped after reserving the selected output allowance.
 */
export function resolveNikaTokenLimits(contextPreset: string | undefined, outputPreset: string | undefined): NikaTokenLimits {
	const desiredInput = NIKA_CONTEXT_PRESETS[contextPreset as NikaContextPreset] ?? NIKA_CONTEXT_PRESETS['128K'];
	const maxOutputTokens = Math.min(NIKA_OUTPUT_PRESETS[outputPreset as NikaOutputPreset] ?? NIKA_OUTPUT_PRESETS['8K'], 384_000);
	const maxInputTokens = Math.min(desiredInput, 1_000_000 - maxOutputTokens);
	return { contextWindow: maxInputTokens + maxOutputTokens, maxInputTokens, maxOutputTokens };
}

export function isNikaModelId(value: string): value is NikaModelId {
	return NIKA_DEEPSEEK_MODEL_IDS.includes(value as NikaModelId)
		|| NIKA_GEMINI_MODEL_IDS.includes(value as NikaModelId)
		|| value === NIKA_GEMMA_MODEL_ID;
}

export function isNikaDeepSeekModel(value: string): value is NikaModelId {
	return NIKA_DEEPSEEK_MODEL_IDS.includes(value as NikaModelId);
}

export function isNikaGeminiModel(value: string): value is NikaModelId {
	return NIKA_GEMINI_MODEL_IDS.includes(value as NikaModelId);
}

export function isNikaThinkingEffort(value: unknown): value is NikaThinkingEffort {
	return value === 'none' || value === 'low' || value === 'high' || value === 'max';
}

export function getVisibleNikaModelIds(hasDeepSeekKey: boolean, hasGeminiKey: boolean): NikaModelId[] {
	return [
		...(hasDeepSeekKey ? NIKA_DEEPSEEK_MODEL_IDS : []),
		NIKA_GEMMA_MODEL_ID,
		...(hasGeminiKey ? NIKA_GEMINI_MODEL_IDS : []),
	];
}

export function getNikaModelCapabilities(id: NikaModelId, limits: NikaTokenLimits): BYOKModelCapabilities {
	if (isNikaDeepSeekModel(id)) {
		const name = id === 'deepseek-v4-pro'
			? 'DeepSeek V4 Pro'
			: id === 'deepseek-v4-pro-responses'
				? 'DeepSeek V4 Pro (Responses, Experimental)'
				: id === 'deepseek-v4-flash-responses'
					? 'DeepSeek V4 Flash (Responses, Experimental)'
					: 'DeepSeek V4 Flash';
		return {
			name,
			contextWindow: limits.contextWindow,
			maxInputTokens: limits.maxInputTokens,
			maxOutputTokens: limits.maxOutputTokens,
			toolCalling: true,
			// Nika preprocesses images and PDFs before forwarding DeepSeek's
			// text-only request. Advertise media input here so Copilot preserves
			// those attachments long enough for Nika to perform that conversion.
			vision: true,
			thinking: true,
			supportsReasoningEffort: ['none', 'low', 'high', 'max'],
			defaultReasoningEffort: 'high',
			reasoningEffortFormat: id.endsWith('-responses') ? 'responses' : 'chat-completions',
			supportedEndpoints: id.endsWith('-responses') ? [ModelSupportedEndpoint.Responses] : [ModelSupportedEndpoint.ChatCompletions],
		};
	}

	if (isNikaGeminiModel(id)) {
		return {
			name: id === 'gemini-2.5-flash' ? 'Gemini 2.5 Flash' : 'Gemini 2.5 Flash Lite',
			contextWindow: limits.contextWindow,
			maxInputTokens: limits.maxInputTokens,
			maxOutputTokens: limits.maxOutputTokens,
			toolCalling: true,
			vision: true,
			thinking: true,
			supportsReasoningEffort: ['none', 'low', 'high'],
			defaultReasoningEffort: 'high',
		};
	}

	return {
		name: 'Gemma 4 31B (Ollama)',
		contextWindow: limits.contextWindow,
		maxInputTokens: limits.maxInputTokens,
		maxOutputTokens: limits.maxOutputTokens,
		toolCalling: true,
		vision: true,
	};
}
