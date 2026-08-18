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
export const NIKA_OPENROUTER_SECRET = 'nika.openrouter.apiKey';

/**
 * Provider-group prefix for OpenRouter catalog models contributed through the
 * Nika provider. A model with raw catalog id `anthropic/claude-sonnet-4` is
 * exposed to the workbench as `openrouter/anthropic/claude-sonnet-4` (and
 * `nika/openrouter/anthropic/claude-sonnet-4` once vendor-qualified).
 */
export const NIKA_OPENROUTER_MODEL_PREFIX = 'openrouter/';

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
export type NikaThinkingEffort = 'none' | 'low' | 'medium' | 'high' | 'max';
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

export function isNikaModelId(value: string): boolean {
	return NIKA_DEEPSEEK_MODEL_IDS.includes(value as NikaModelId)
		|| NIKA_GEMINI_MODEL_IDS.includes(value as NikaModelId)
		|| value === NIKA_GEMMA_MODEL_ID
		|| isNikaOpenRouterModel(value);
}

/**
 * True for OpenRouter catalog model ids exposed through the Nika provider
 * (`openrouter/<vendor>/<model>`). The raw catalog id follows the prefix, e.g.
 * `openrouter/anthropic/claude-sonnet-4`.
 */
export function isNikaOpenRouterModel(value: string): boolean {
	return value.startsWith(NIKA_OPENROUTER_MODEL_PREFIX);
}

export function isNikaDeepSeekModel(value: string): value is NikaModelId {
	return NIKA_DEEPSEEK_MODEL_IDS.includes(value as NikaModelId);
}

export function isNikaGeminiModel(value: string): value is NikaModelId {
	return NIKA_GEMINI_MODEL_IDS.includes(value as NikaModelId);
}

export function isNikaThinkingEffort(value: unknown): value is NikaThinkingEffort {
	return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'max';
}

/**
 * The provider family a Nika model belongs to. Gemma is served from a local
 * Ollama host rather than a cloud API.
 */
export type NikaModelProvider = 'deepseek' | 'gemini' | 'gemma' | 'openrouter';

/**
 * Strips the optional `nika/` vendor prefix used in settings values (e.g.
 * `nika/deepseek-v4-flash-responses`) so provider checks and catalog ids can
 * match against the bare model id.
 */
function unprefixNikaModelId(id: string): string {
	return id.startsWith('nika/') ? id.slice('nika/'.length) : id;
}

/**
 * Returns the provider family for a Nika model id. The id may carry the `nika/`
 * vendor prefix (as stored in `nika.defaultModel`) or the bare model id (the
 * chat-picker form). OpenRouter catalog ids are `openrouter/<vendor>/<model>`.
 * Returns `undefined` for unknown ids.
 */
export function getNikaModelProvider(id: string): NikaModelProvider | undefined {
	const value = unprefixNikaModelId(id);
	if (isNikaDeepSeekModel(value)) {
		return 'deepseek';
	}
	if (isNikaGeminiModel(value)) {
		return 'gemini';
	}
	if (value === NIKA_GEMMA_MODEL_ID) {
		return 'gemma';
	}
	if (isNikaOpenRouterModel(value)) {
		return 'openrouter';
	}
	return undefined;
}

/**
 * The reasoning-effort levels a Nika model of the given id accepts. DeepSeek
 * supports the full range; Gemini omits `max`; OpenRouter uses `low`-`high`
 * with `medium` (its own magnitude) rather than `none`/`max`; Gemma has no
 * effort control (empty). For OpenRouter catalog models the narrower
 * per-model list from the catalog's `supportsReasoningEffort` should take
 * precedence when building dropdowns.
 */
export function getNikaEffortOptionsForModel(id: string): NikaThinkingEffort[] {
	switch (getNikaModelProvider(id)) {
		case 'deepseek':
			return ['none', 'low', 'high', 'max'];
		case 'gemini':
			return ['none', 'low', 'high'];
		case 'openrouter':
			return ['low', 'medium', 'high'];
		case 'gemma':
		default:
			return [];
	}
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
