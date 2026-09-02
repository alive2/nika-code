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
export const NIKA_LLAMACPP_SECRET = 'nika.llamacpp.apiKey';
export const NIKA_CURSOR_SECRET = 'nika.cursor.apiKey';
export const NIKA_DEEPSEEK_WEB_SECRET = 'nika.deepseekWeb.token';
export const NIKA_OPENAI_SECRET = 'nika.openai.apiKey';
export const NIKA_ANTHROPIC_SECRET = 'nika.anthropic.apiKey';
export const NIKA_ZAI_SECRET = 'nika.zai.apiKey';

/**
 * Secret key holding the ChatGPT subscription (device-code OAuth) token
 * payload as JSON — see {@link NikaChatGptSubscriptionToken}. Signed in
 * through the provider wizard's device-code flow; used to call the codex
 * backend (`chatgpt.com/backend-api/codex/responses`).
 */
export const NIKA_CHATGPT_SUB_SECRET = 'nika.chatgpt.subscription';

/**
 * Secret key holding the Claude subscription (device-code OAuth) token
 * payload as JSON — see {@link NikaClaudeSubscriptionToken}. Signed in
 * through the provider wizard's device-code flow; used to call the Anthropic
 * Messages API with an OAuth bearer token.
 */
export const NIKA_CLAUDE_SUB_SECRET = 'nika.claude.subscription';

/**
 * OAuth access token payload stored under {@link NIKA_CHATGPT_SUB_SECRET}.
 * `accountId` and `planType` are read from the id_token JWT claims; the chat
 * call requires `ChatGPT-Account-ID` plus `OAI-Product-Sku: codex`.
 */
export interface NikaChatGptSubscriptionToken {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly idToken?: string;
	readonly accountId?: string;
	readonly planType?: string;
	/** Epoch millis when the access token expires. */
	readonly expiresAt?: number;
}

/**
 * OAuth access token payload stored under {@link NIKA_CLAUDE_SUB_SECRET}.
 * Chat calls carry it as a Bearer token plus the `oauth-2025-04-20` beta
 * header; the system prompt must be the exact Claude Code SDK string.
 */
export interface NikaClaudeSubscriptionToken {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly expiresAt?: number;
	/** `Pro` / `Max` / … as reported by the account endpoint. */
	readonly planType?: string;
	readonly displayName?: string;
}

/**
 * Validates an unknown secret payload as a ChatGPT subscription token.
 */
export function parseNikaChatGptSubscriptionToken(value: unknown): NikaChatGptSubscriptionToken | undefined {
	if (typeof value !== 'string' || value.length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as Partial<NikaChatGptSubscriptionToken>;
		if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0
			|| typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0) {
			return undefined;
		}
		return {
			accessToken: parsed.accessToken,
			refreshToken: parsed.refreshToken,
			idToken: typeof parsed.idToken === 'string' ? parsed.idToken : undefined,
			accountId: typeof parsed.accountId === 'string' ? parsed.accountId : undefined,
			planType: typeof parsed.planType === 'string' ? parsed.planType : undefined,
			expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * Validates an unknown secret payload as a Claude subscription token.
 */
export function parseNikaClaudeSubscriptionToken(value: unknown): NikaClaudeSubscriptionToken | undefined {
	if (typeof value !== 'string' || value.length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as Partial<NikaClaudeSubscriptionToken>;
		if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0
			|| typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0) {
			return undefined;
		}
		return {
			accessToken: parsed.accessToken,
			refreshToken: parsed.refreshToken,
			expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
			planType: typeof parsed.planType === 'string' ? parsed.planType : undefined,
			displayName: typeof parsed.displayName === 'string' ? parsed.displayName : undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * Provider-group prefix for OpenRouter catalog models contributed through the
 * Nika provider. A model with raw catalog id `anthropic/claude-sonnet-4` is
 * exposed to the workbench as `openrouter/anthropic/claude-sonnet-4` (and
 * `nika/openrouter/anthropic/claude-sonnet-4` once vendor-qualified).
 */
export const NIKA_OPENROUTER_MODEL_PREFIX = 'openrouter/';

/**
 * Provider-group prefix for llama.cpp server models contributed through the
 * Nika provider. A model loaded on the server under id `qwen2.5vl-7b` is
 * exposed to the workbench as `llamacpp/qwen2.5vl-7b` (and
 * `nika/llamacpp/qwen2.5vl-7b` once vendor-qualified).
 */
export const NIKA_LLAMACPP_MODEL_PREFIX = 'llamacpp/';

/**
 * Provider-group prefix for Ollama models contributed through the Nika
 * provider. A model pulled on the local Ollama host under name `gemma4:31b`
 * is exposed to the workbench as `ollama/gemma4:31b` (and
 * `nika/ollama/gemma4:31b` once vendor-qualified).
 */
export const NIKA_OLLAMA_MODEL_PREFIX = 'ollama/';

/**
 * Provider-group prefix for Google's Generative Language API models that are
 * discovered from the live catalog (everything beyond the curated native
 * lineup). A catalog model with raw id `gemini-2.5-pro` is exposed to the
 * workbench as `gemini/gemini-2.5-pro` (and `nika/gemini/gemini-2.5-pro`
 * once vendor-qualified). The prefix keeps catalog entries distinguishable
 * from the bare native ids (`gemini-2.5-flash`, `gemini-2.5-flash-lite`).
 */
export const NIKA_GEMINI_MODEL_PREFIX = 'gemini/';

/**
 * Provider-group prefix for Cursor API models contributed through the Nika
 * provider. A model listed by `api.cursor.com/v1/models` under id
 * `cursor-fast` is exposed to the workbench as `cursor/cursor-fast` (and
 * `nika/cursor/cursor-fast` once vendor-qualified).
 */
export const NIKA_CURSOR_MODEL_PREFIX = 'cursor/';

/**
 * Provider-group prefix for DeepSeek web chat models (chat.deepseek.com)
 * contributed through the Nika provider. The web API has a single chat
 * model (with automatic vision when images are attached), exposed to the
 * workbench as `deepseekweb/deepseek-chat` (and
 * `nika/deepseekweb/deepseek-chat` once vendor-qualified).
 */
export const NIKA_DEEPSEEK_WEB_MODEL_PREFIX = 'deepseekweb/';

/**
 * Provider-group prefix for OpenAI catalog models contributed through the
 * Nika provider. A model with raw catalog id `gpt-5` is exposed to the
 * workbench as `openai/gpt-5` (and `nika/openai/gpt-5` once
 * vendor-qualified).
 */
export const NIKA_OPENAI_MODEL_PREFIX = 'openai/';

/**
 * Provider-group prefix for Anthropic catalog models contributed through the
 * Nika provider. A model with raw catalog id `claude-sonnet-4` is exposed to
 * the workbench as `anthropic/claude-sonnet-4` (and
 * `nika/anthropic/claude-sonnet-4` once vendor-qualified).
 */
export const NIKA_ANTHROPIC_MODEL_PREFIX = 'anthropic/';

/**
 * Provider-group prefix for ChatGPT subscription (codex backend) models
 * contributed through the Nika provider. A model served by the codex
 * backend under id `gpt-5-codex` is exposed to the workbench as
 * `chatgpt/gpt-5-codex` (and `nika/chatgpt/gpt-5-codex` once
 * vendor-qualified).
 */
export const NIKA_CHATGPT_MODEL_PREFIX = 'chatgpt/';

/**
 * Provider-group prefix for Claude subscription (Anthropic OAuth) models
 * contributed through the Nika provider. A model served by the Messages API
 * under id `claude-sonnet-4-5` is exposed to the workbench as
 * `claude/claude-sonnet-4-5` (and `nika/claude/claude-sonnet-4-5` once
 * vendor-qualified).
 */
export const NIKA_CLAUDE_SUB_MODEL_PREFIX = 'claude/';

/**
 * Provider-group prefix for Z.ai (Zhipu GLM) catalog models contributed
 * through the Nika provider. A model served by `api.z.ai/api/paas/v4` under
 * raw id `glm-4.7` is exposed to the workbench as `zai/glm-4.7` (and
 * `nika/zai/glm-4.7` once vendor-qualified).
 */
export const NIKA_ZAI_MODEL_PREFIX = 'zai/';

/**
 * Master switch for GitHub Copilot integration. Off (the default) makes
 * NikaCode run entirely on BYOK models without a GitHub account: no sign-in
 * prompts, no Copilot utility models, no GitHub MCP server. Turn it on to
 * restore upstream Copilot behavior.
 */
export const NIKA_GITHUB_ENABLED_CONFIG_KEY = 'nika.github.enabled';

/**
 * Per-model image-preprocessing map. Value is the key relative to the `nika`
 * configuration section (callers use `workspace.getConfiguration('nika')`, so
 * the full registered setting is `nika.visionPreprocessingMap`). Keys of the
 * map are the bare (unqualified) model ids as seen by the request path
 * (`deepseek-v4-flash`, `openrouter/<vendor>/<model>`, `llamacpp/<server-id>`, …).
 * A boolean value overrides the per-model default: `true` = harness describes
 * images with the vision backend first; `false` = the harness sends image
 * parts through untouched. Absent entries fall back to the model's capability
 * (V4 Flash Vision, Gemini, Claude, GPT-5/4o, llama.cpp/Cursor multimodal →
 * native; text-only families → describe).
 */
export const NIKA_VISION_PREPROCESS_MAP_CONFIG_KEY = 'visionPreprocessingMap';

export type NikaModelId =
	| 'deepseek-v4-flash'
	| 'deepseek-v4-pro'
	| 'deepseek-v4-flash-responses'
	| 'deepseek-v4-pro-responses'
	| 'deepseek-v4-flash-vision-exp'
	| 'deepseek-v4-flash-vision-exp-responses'
	| 'gemini-2.5-flash'
	| 'gemini-2.5-flash-lite'
	| 'gemma4:31b';

/**
 * The Nika provider families a user can add through the Providers wizard.
 * `gemma` (the legacy bare `gemma4:31b` id) maps to the Ollama connection.
 */
export type NikaProviderId = 'deepseek' | 'gemini' | 'ollama' | 'openrouter' | 'llamacpp' | 'cursor' | 'deepseekweb' | 'openai' | 'anthropic' | 'chatgpt' | 'claude' | 'zai';

/**
 * Per-provider model selection persisted in the `nika.providers` setting. A
 * provider's entry lists the bare (unqualified) model ids the user selected
 * in the wizard; only those models are exposed to chat, Agents, and the
 * settings dropdowns. Stored ids use the exposed form: `deepseek-v4-flash`,
 * `gemini-2.5-flash`, `openrouter/<vendor>/<model>`, `ollama/<name>`, and
 * `llamacpp/<server-id>`.
 */
export interface NikaProviderSelection {
	readonly models: readonly string[];
}

export type NikaProviderConfig = Partial<Record<NikaProviderId, NikaProviderSelection>>;

export const NIKA_DEEPSEEK_MODEL_IDS: readonly NikaModelId[] = [
	'deepseek-v4-flash',
	'deepseek-v4-pro',
	'deepseek-v4-flash-responses',
	'deepseek-v4-pro-responses',
	'deepseek-v4-flash-vision-exp',
	'deepseek-v4-flash-vision-exp-responses',
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
export type NikaThinkingEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
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
		|| isNikaOpenRouterModel(value)
		|| isNikaLlamaCppModel(value)
		|| isNikaOllamaModel(value)
		|| isNikaGeminiCatalogModel(value)
		|| isNikaCursorModel(value)
		|| isNikaDeepSeekWebModel(value)
		|| isNikaOpenAIModel(value)
		|| isNikaAnthropicModel(value)
		|| isNikaChatGptSubModel(value)
		|| isNikaClaudeSubModel(value)
		|| isNikaZaiModel(value);
}

/**
 * True for Ollama model ids exposed through the Nika provider
 * (`ollama/<name>`). The model name as reported by the Ollama host's
 * `/api/tags` endpoint follows the prefix, e.g. `ollama/gemma4:31b`.
 */
export function isNikaOllamaModel(value: string): boolean {
	return value.startsWith(NIKA_OLLAMA_MODEL_PREFIX);
}

/**
 * True for Gemini catalog model ids exposed through the Nika provider
 * (`gemini/<model id>`). The raw id as reported by Google's models.list API
 * follows the prefix, e.g. `gemini/gemini-2.5-pro`. The curated native ids
 * (`gemini-2.5-flash`, `gemini-2.5-flash-lite`) are NOT catalog ids.
 */
export function isNikaGeminiCatalogModel(value: string): boolean {
	return value.startsWith(NIKA_GEMINI_MODEL_PREFIX);
}

/**
 * True for Cursor API model ids exposed through the Nika provider
 * (`cursor/<raw id>`). The raw id as reported by `api.cursor.com/v1/models`
 * follows the prefix, e.g. `cursor/cursor-fast`.
 */
export function isNikaCursorModel(value: string): boolean {
	return value.startsWith(NIKA_CURSOR_MODEL_PREFIX);
}

/**
 * True for DeepSeek web chat model ids exposed through the Nika provider
 * (`deepseekweb/<model id>`). The web API's model id follows the prefix,
 * e.g. `deepseekweb/deepseek-chat`.
 */
export function isNikaDeepSeekWebModel(value: string): boolean {
	return value.startsWith(NIKA_DEEPSEEK_WEB_MODEL_PREFIX);
}

/**
 * True for OpenAI catalog model ids exposed through the Nika provider
 * (`openai/<model id>`). The raw id as reported by `api.openai.com/v1/models`
 * follows the prefix, e.g. `openai/gpt-5`.
 */
export function isNikaOpenAIModel(value: string): boolean {
	return value.startsWith(NIKA_OPENAI_MODEL_PREFIX);
}

/**
 * True for Anthropic catalog model ids exposed through the Nika provider
 * (`anthropic/<model id>`). The raw id as reported by `api.anthropic.com/v1/models`
 * follows the prefix, e.g. `anthropic/claude-sonnet-4`.
 */
export function isNikaAnthropicModel(value: string): boolean {
	return value.startsWith(NIKA_ANTHROPIC_MODEL_PREFIX);
}

/**
 * True for ChatGPT subscription model ids exposed through the Nika provider
 * (`chatgpt/<model id>`), e.g. `chatgpt/gpt-5-codex`.
 */
export function isNikaChatGptSubModel(value: string): boolean {
	return value.startsWith(NIKA_CHATGPT_MODEL_PREFIX);
}

/**
 * True for Claude subscription model ids exposed through the Nika provider
 * (`claude/<model id>`), e.g. `claude/claude-sonnet-4-5`.
 */
export function isNikaClaudeSubModel(value: string): boolean {
	return value.startsWith(NIKA_CLAUDE_SUB_MODEL_PREFIX);
}

/**
 * True for Z.ai catalog model ids exposed through the Nika provider
 * (`zai/<model id>`). The raw id as served by `api.z.ai/api/paas/v4/models`
 * follows the prefix, e.g. `zai/glm-4.7`.
 */
export function isNikaZaiModel(value: string): boolean {
	return value.startsWith(NIKA_ZAI_MODEL_PREFIX);
}

/**
 * True for OpenRouter catalog model ids exposed through the Nika provider
 * (`openrouter/<vendor>/<model>`). The raw catalog id follows the prefix, e.g.
 * `openrouter/anthropic/claude-sonnet-4`.
 */
export function isNikaOpenRouterModel(value: string): boolean {
	return value.startsWith(NIKA_OPENROUTER_MODEL_PREFIX);
}

/**
 * True for llama.cpp server model ids exposed through the Nika provider
 * (`llamacpp/<server-model-id>`). The raw id as reported by the server's
 * `/v1/models` endpoint follows the prefix, e.g. `llamacpp/qwen2.5vl-7b`.
 */
export function isNikaLlamaCppModel(value: string): boolean {
	return value.startsWith(NIKA_LLAMACPP_MODEL_PREFIX);
}

export function isNikaDeepSeekModel(value: string): value is NikaModelId {
	return NIKA_DEEPSEEK_MODEL_IDS.includes(value as NikaModelId);
}

/**
 * True for the natively vision-capable DeepSeek model ids (the
 * `deepseek-v4-flash-vision-exp` Chat Completions and Responses variants).
 * Unlike the text-only DeepSeek models — which advertise media input only so
 * Nika can preprocess attachments into text — this model accepts image parts
 * directly on the wire, so the vision-preprocessing toggle should be the only
 * thing deciding whether images are described first or sent natively.
 */
export function isNikaDeepSeekVisionModel(value: string): boolean {
	const id = unprefixNikaModelId(value);
	return id === 'deepseek-v4-flash-vision-exp' || id === 'deepseek-v4-flash-vision-exp-responses';
}

export function isNikaGeminiModel(value: string): value is NikaModelId {
	return NIKA_GEMINI_MODEL_IDS.includes(value as NikaModelId);
}

export function isNikaThinkingEffort(value: unknown): value is NikaThinkingEffort {
	return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra';
}

/**
 * The provider family a Nika model belongs to. Gemma is served from a local
 * Ollama host rather than a cloud API; llama.cpp models come from a local
 * llama.cpp server's OpenAI-compatible endpoint; `ollama/…` ids are the
 * dynamic Ollama catalog form of the same family.
 */
export type NikaModelProvider = 'deepseek' | 'gemini' | 'gemma' | 'ollama' | 'openrouter' | 'llamacpp' | 'cursor' | 'deepseekweb' | 'openai' | 'anthropic' | 'chatgpt' | 'claude' | 'zai';

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
 * chat-picker form). OpenRouter catalog ids are `openrouter/<vendor>/<model>`;
 * llama.cpp server ids are `llamacpp/<server-model-id>`. Returns `undefined`
 * for unknown ids.
 */
export function getNikaModelProvider(id: string): NikaModelProvider | undefined {
	const value = unprefixNikaModelId(id);
	if (isNikaDeepSeekModel(value)) {
		return 'deepseek';
	}
	if (isNikaGeminiModel(value) || isNikaGeminiCatalogModel(value)) {
		return 'gemini';
	}
	if (value === NIKA_GEMMA_MODEL_ID) {
		return 'gemma';
	}
	if (isNikaOpenRouterModel(value)) {
		return 'openrouter';
	}
	if (isNikaLlamaCppModel(value)) {
		return 'llamacpp';
	}
	if (isNikaOllamaModel(value)) {
		return 'ollama';
	}
	if (isNikaCursorModel(value)) {
		return 'cursor';
	}
	if (isNikaDeepSeekWebModel(value)) {
		return 'deepseekweb';
	}
	if (isNikaOpenAIModel(value)) {
		return 'openai';
	}
	if (isNikaAnthropicModel(value)) {
		return 'anthropic';
	}
	if (isNikaChatGptSubModel(value)) {
		return 'chatgpt';
	}
	if (isNikaClaudeSubModel(value)) {
		return 'claude';
	}
	if (isNikaZaiModel(value)) {
		return 'zai';
	}
	return undefined;
}

/**
 * The reasoning-effort levels a Nika model of the given id accepts. DeepSeek
 * supports the full range; Gemini omits `max`; OpenRouter uses `low`-`high`
 * with `medium` (its own magnitude) rather than `none`/`max`; the ChatGPT
 * subscription (codex backend) family accepts the codex range `low`-`ultra`;
 * Gemma and llama.cpp have no effort control (empty). For OpenRouter catalog
 * models the narrower per-model list from the catalog's
 * `supportsReasoningEffort` should take precedence when building dropdowns.
 */
export function getNikaEffortOptionsForModel(id: string): NikaThinkingEffort[] {
	switch (getNikaModelProvider(id)) {
		case 'deepseek':
			return ['none', 'low', 'high', 'max'];
		case 'gemini':
			return ['none', 'low', 'high'];
		case 'openrouter':
		case 'openai':
			return ['low', 'medium', 'high'];
		case 'chatgpt':
			return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
		case 'llamacpp':
		case 'ollama':
		case 'gemma':
		case 'cursor':
		case 'deepseekweb':
		case 'anthropic':
		case 'claude':
		case 'zai':
			return [];
		default:
			return [];
	}
}

/**
 * Parses the raw `nika.providers` setting value. Returns `undefined` when the
 * setting is absent (legacy mode: visibility is derived from stored keys and
 * hosts as before the wizard existed) and a validated config object otherwise
 * (managed mode: only the selected models of added providers are visible). An
 * empty object `{}` is a valid managed config with nothing enabled.
 */
export function parseNikaProviderConfig(value: unknown): NikaProviderConfig | undefined {
	if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const config: NikaProviderConfig = {};
	for (const provider of ['deepseek', 'gemini', 'ollama', 'openrouter', 'llamacpp', 'cursor', 'deepseekweb', 'openai', 'anthropic', 'chatgpt', 'claude', 'zai'] as const) {
		const entry = (value as Record<string, unknown>)[provider];
		if (entry === undefined || entry === null || typeof entry !== 'object') {
			continue;
		}
		const rawModels = (entry as Record<string, unknown>).models;
		if (!Array.isArray(rawModels)) {
			continue;
		}
		const models = rawModels.filter((model): model is string => typeof model === 'string' && model.length > 0);
		config[provider] = { models };
	}
	return config;
}

/**
 * The selected model ids for a provider in managed mode, or `undefined` when
 * the provider is not configured (or when the config is absent entirely).
 */
export function getNikaSelectedModels(config: NikaProviderConfig | undefined, provider: NikaProviderId): readonly string[] | undefined {
	return config?.[provider]?.models;
}

/**
 * The native (non-catalog) Nika model ids to expose. Legacy mode (no
 * `nika.providers` config) keeps the classic rules: DeepSeek/Gemini models
 * show when their key is present and Gemma always shows. Managed mode
 * exposes exactly the wizard-selected models of added providers (Gemma and
 * other Ollama models flow through the dynamic `ollama/…` catalog instead of
 * this list).
 */
export function getVisibleNikaModelIds(hasDeepSeekKey: boolean, hasGeminiKey: boolean, providerConfig?: NikaProviderConfig): NikaModelId[] {
	if (providerConfig) {
		const deepseek = new Set(getNikaSelectedModels(providerConfig, 'deepseek') ?? []);
		const gemini = new Set(getNikaSelectedModels(providerConfig, 'gemini') ?? []);
		return [
			...(hasDeepSeekKey ? NIKA_DEEPSEEK_MODEL_IDS.filter(id => deepseek.has(id)) : []),
			...(hasGeminiKey ? NIKA_GEMINI_MODEL_IDS.filter(id => gemini.has(id)) : []),
		];
	}
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
				? 'DeepSeek V4 Pro (Responses)'
				: id === 'deepseek-v4-flash-responses'
					? 'DeepSeek V4 Flash (Responses)'
					: id === 'deepseek-v4-flash-vision-exp'
						? 'DeepSeek V4 Flash Vision (Exp)'
						: id === 'deepseek-v4-flash-vision-exp-responses'
							? 'DeepSeek V4 Flash Vision (Exp) (Responses)'
							: 'DeepSeek V4 Flash';
		return {
			name,
			contextWindow: limits.contextWindow,
			maxInputTokens: limits.maxInputTokens,
			maxOutputTokens: limits.maxOutputTokens,
			toolCalling: true,
			// The text-only DeepSeek models advertise media input here so
			// Copilot preserves attachments long enough for Nika to convert
			// them to text (images via the vision backend, PDFs always).
			// The vision model accepts image parts natively: with vision
			// preprocessing off (or `None (native vision)` selected), images
			// ride through untouched instead of being described first.
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
