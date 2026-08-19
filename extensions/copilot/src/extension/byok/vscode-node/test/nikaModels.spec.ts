/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { getNikaEffortOptionsForModel, getNikaModelCapabilities, getNikaModelProvider, getNikaSelectedModels, getVisibleNikaModelIds, isNikaDeepSeekModel, isNikaGeminiModel, isNikaLlamaCppModel, isNikaModelId, isNikaOllamaModel, isNikaThinkingEffort, NIKA_AGENT_DEFAULTS, NIKA_RESPONSES_MODEL, parseNikaProviderConfig, resolveNikaTokenLimits } from '../nikaModels';

describe('Nika model metadata', () => {
	it('uses the documented default budgets', () => {
		expect(resolveNikaTokenLimits(undefined, undefined)).toEqual({
			contextWindow: 136_000,
			maxInputTokens: 128_000,
			maxOutputTokens: 8_000,
		});
	});

	it('clamps input plus output to the DeepSeek one-million-token window', () => {
		expect(resolveNikaTokenLimits('1M', '384K')).toEqual({
			contextWindow: 1_000_000,
			maxInputTokens: 616_000,
			maxOutputTokens: 384_000,
		});
	});

	it('publishes the fixed provider lineup and capabilities', () => {
		const limits = resolveNikaTokenLimits('128K', '8K');
		expect(isNikaModelId('deepseek-v4-flash')).toBe(true);
		expect(isNikaModelId('deepseek-v4-pro')).toBe(true);
		expect(isNikaModelId('deepseek-v4-flash-responses')).toBe(true);
		expect(isNikaModelId('deepseek-v4-pro-responses')).toBe(true);
		expect(isNikaModelId('gemini-2.5-flash')).toBe(true);
		expect(isNikaModelId('gemini-2.5-flash-lite')).toBe(true);
		expect(isNikaModelId('gemma4:31b')).toBe(true);
		expect(isNikaModelId('unknown')).toBe(false);
		expect(isNikaDeepSeekModel('deepseek-v4-flash')).toBe(true);
		expect(isNikaGeminiModel('gemini-2.5-flash')).toBe(true);
		expect(getNikaModelCapabilities('deepseek-v4-flash-responses', limits).supportedEndpoints).toHaveLength(1);
		expect(getNikaModelCapabilities('deepseek-v4-pro-responses', limits).name).toBe('DeepSeek V4 Pro (Responses, Experimental)');
		expect(getNikaModelCapabilities('deepseek-v4-pro-responses', limits).supportedEndpoints).toHaveLength(1);
		expect(getNikaModelCapabilities('gemini-2.5-flash', limits).vision).toBe(true);
		expect(getNikaModelCapabilities('gemma4:31b', limits).vision).toBe(true);
	});

	it('hides cloud models until their corresponding key exists', () => {
		expect(getVisibleNikaModelIds(false, false)).toEqual(['gemma4:31b']);
		expect(getVisibleNikaModelIds(true, false)).toEqual([
			'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-responses', 'deepseek-v4-pro-responses', 'gemma4:31b',
		]);
		expect(getVisibleNikaModelIds(false, true)).toEqual([
			'gemma4:31b', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
		]);
	});

	it('uses the Responses model with role-specific thinking defaults', () => {
		expect(NIKA_AGENT_DEFAULTS).toEqual({
			plan: { model: NIKA_RESPONSES_MODEL, effort: 'max' },
			explore: { model: NIKA_RESPONSES_MODEL, effort: 'none' },
			utility: { model: NIKA_RESPONSES_MODEL, effort: 'high' },
			utilitySmall: { model: NIKA_RESPONSES_MODEL, effort: 'none' },
			inlineChat: { model: NIKA_RESPONSES_MODEL, effort: 'none' },
		});
	});

	it('maps model ids to their provider family', () => {
		expect(getNikaModelProvider('deepseek-v4-flash')).toBe('deepseek');
		expect(getNikaModelProvider('nika/deepseek-v4-flash-responses')).toBe('deepseek');
		expect(getNikaModelProvider('gemini-2.5-flash')).toBe('gemini');
		expect(getNikaModelProvider('gemma4:31b')).toBe('gemma');
		expect(getNikaModelProvider('openrouter/anthropic/claude-sonnet-4')).toBe('openrouter');
		expect(getNikaModelProvider('nika/openrouter/anthropic/claude-sonnet-4')).toBe('openrouter');
		expect(getNikaModelProvider('llamacpp/qwen2.5vl-7b')).toBe('llamacpp');
		expect(getNikaModelProvider('nika/llamacpp/qwen2.5vl-7b')).toBe('llamacpp');
		expect(getNikaModelProvider('unknown-model')).toBeUndefined();
	});

	it('recognizes llama.cpp server models as Nika models without an effort control', () => {
		expect(isNikaModelId('llamacpp/qwen2.5vl-7b')).toBe(true);
		expect(isNikaModelId('llamacpp/llama-3.2-3b')).toBe(true);
		expect(isNikaLlamaCppModel('llamacpp/qwen2.5vl-7b')).toBe(true);
		// Like OpenRouter ids, the raw form matches the `is*` helper; the
		// vendor-qualified form (`nika/…`) is resolved by `getNikaModelProvider`.
		expect(isNikaLlamaCppModel('nika/llamacpp/qwen2.5vl-7b')).toBe(false);
		expect(isNikaLlamaCppModel('openrouter/anthropic/claude-sonnet-4')).toBe(false);
		expect(getNikaModelProvider('nika/llamacpp/qwen2.5vl-7b')).toBe('llamacpp');
		expect(getNikaEffortOptionsForModel('llamacpp/qwen2.5vl-7b')).toEqual([]);
	});

	it('derives reasoning-effort options per provider', () => {
		expect(getNikaEffortOptionsForModel('deepseek-v4-flash')).toEqual(['none', 'low', 'high', 'max']);
		expect(getNikaEffortOptionsForModel('nika/deepseek-v4-pro-responses')).toEqual(['none', 'low', 'high', 'max']);
		expect(getNikaEffortOptionsForModel('gemini-2.5-flash')).toEqual(['none', 'low', 'high']);
		expect(getNikaEffortOptionsForModel('openrouter/anthropic/claude-sonnet-4')).toEqual(['low', 'medium', 'high']);
		expect(getNikaEffortOptionsForModel('llamacpp/qwen2.5vl-7b')).toEqual([]);
		expect(getNikaEffortOptionsForModel('gemma4:31b')).toEqual([]);
		expect(getNikaEffortOptionsForModel('unknown-model')).toEqual([]);
	});

	it('accepts the medium effort level', () => {
		expect(isNikaThinkingEffort('medium')).toBe(true);
		expect(isNikaThinkingEffort('none')).toBe(true);
		expect(isNikaThinkingEffort('max')).toBe(true);
		expect(isNikaThinkingEffort('ultra')).toBe(false);
	});

	it('recognizes ollama catalog models as Nika models', () => {
		expect(isNikaOllamaModel('ollama/gemma4:31b')).toBe(true);
		expect(isNikaOllamaModel('ollama/qwen3:8b')).toBe(true);
		expect(isNikaOllamaModel('gemma4:31b')).toBe(false);
		expect(isNikaOllamaModel('openrouter/anthropic/claude-sonnet-4')).toBe(false);
		expect(isNikaModelId('ollama/qwen3:8b')).toBe(true);
		expect(getNikaModelProvider('ollama/gemma4:31b')).toBe('ollama');
		expect(getNikaModelProvider('nika/ollama/qwen3:8b')).toBe('ollama');
		expect(getNikaEffortOptionsForModel('ollama/gemma4:31b')).toEqual([]);
	});

	it('parses the nika.providers setting into a validated config', () => {
		// Absent or malformed values mean legacy mode.
		expect(parseNikaProviderConfig(undefined)).toBeUndefined();
		expect(parseNikaProviderConfig(null)).toBeUndefined();
		expect(parseNikaProviderConfig('nope')).toBeUndefined();
		expect(parseNikaProviderConfig([{ models: ['deepseek-v4-flash'] }])).toBeUndefined();
		// An empty object is a valid managed config with nothing enabled.
		expect(parseNikaProviderConfig({})).toEqual({});
		// Non-array models are skipped; non-string entries are filtered.
		expect(parseNikaProviderConfig({
			deepseek: { models: ['deepseek-v4-flash', 42, '', null, 'deepseek-v4-pro'] },
			ollama: { models: 'not-an-array' },
			gemini: 'not-an-object',
		})).toEqual({
			deepseek: { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
		});
	});

	it('reads the selected models for a provider', () => {
		const config = parseNikaProviderConfig({
			deepseek: { models: ['deepseek-v4-flash'] },
			openrouter: { models: ['openrouter/anthropic/claude-sonnet-4'] },
		});
		expect(getNikaSelectedModels(config, 'deepseek')).toEqual(['deepseek-v4-flash']);
		expect(getNikaSelectedModels(config, 'openrouter')).toEqual(['openrouter/anthropic/claude-sonnet-4']);
		expect(getNikaSelectedModels(config, 'ollama')).toBeUndefined();
		expect(getNikaSelectedModels(undefined, 'deepseek')).toBeUndefined();
	});

	it('filters native models to the wizard selection in managed mode', () => {
		const config = parseNikaProviderConfig({
			deepseek: { models: ['deepseek-v4-flash'] },
			gemini: { models: ['gemini-2.5-flash-lite'] },
		});
		// Keys alone do not surface models in managed mode — selection does.
		expect(getVisibleNikaModelIds(true, true, config)).toEqual(['deepseek-v4-flash', 'gemini-2.5-flash-lite']);
		expect(getVisibleNikaModelIds(true, true, parseNikaProviderConfig({}))).toEqual([]);
		// Gemma flows through the dynamic ollama/… catalog, never this list.
		expect(getVisibleNikaModelIds(true, true, config)).not.toContain('gemma4:31b');
		// Legacy mode (no config) keeps the classic key-driven rules.
		expect(getVisibleNikaModelIds(true, false)).toEqual([
			'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-responses', 'deepseek-v4-pro-responses', 'gemma4:31b',
		]);
	});
});
