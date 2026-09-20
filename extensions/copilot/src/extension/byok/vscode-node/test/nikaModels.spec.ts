/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { getNikaEffortOptionsForModel, getNikaModelCapabilities, getNikaModelProvider, getNikaSelectedModels, getVisibleNikaModelIds, isNikaChatGptSubModel, isNikaClaudeSubModel, isNikaDeepSeekModel, isNikaDeepSeekVisionModel, isNikaGeminiModel, isNikaLlamaCppModel, isNikaModelId, isNikaOllamaModel, isNikaSglangModel, isNikaThinkingEffort, NIKA_AGENT_DEFAULTS, NIKA_RESPONSES_MODEL, nikaSglangApiKeySecret, nikaSglangModelId, parseNikaProviderConfig, parseNikaSglangModelId, parseNikaSglangServers, resolveNikaTokenLimits, slugifyNikaSglangServerId } from '../nikaModels';

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
		expect(isNikaModelId('deepseek-v4-flash-vision-exp')).toBe(true);
		expect(isNikaModelId('deepseek-v4-flash-vision-exp-responses')).toBe(true);
		expect(isNikaModelId('gemini-2.5-flash')).toBe(true);
		expect(isNikaModelId('gemini-2.5-flash-lite')).toBe(true);
		expect(isNikaModelId('gemma4:31b')).toBe(true);
		expect(isNikaModelId('openai/gpt-5')).toBe(true);
		expect(isNikaModelId('openai/gpt-4o-mini')).toBe(true);
		expect(isNikaModelId('anthropic/claude-sonnet-4')).toBe(true);
		expect(isNikaModelId('anthropic/claude-opus-4-5')).toBe(true);
		expect(isNikaModelId('chatgpt/gpt-5-codex')).toBe(true);
		expect(isNikaModelId('claude/claude-sonnet-4-5')).toBe(true);
		expect(isNikaModelId('unknown')).toBe(false);
		expect(isNikaChatGptSubModel('chatgpt/gpt-5-codex')).toBe(true);
		expect(isNikaChatGptSubModel('chatgpt/gpt-5.1-codex-mini')).toBe(true);
		expect(isNikaChatGptSubModel('openai/gpt-5')).toBe(false);
		expect(isNikaClaudeSubModel('claude/claude-opus-4-5')).toBe(true);
		expect(isNikaClaudeSubModel('claude/claude-haiku-4-5')).toBe(true);
		expect(isNikaClaudeSubModel('anthropic/claude-sonnet-4')).toBe(false);
		expect(isNikaDeepSeekModel('deepseek-v4-flash')).toBe(true);
		expect(isNikaDeepSeekModel('deepseek-v4-flash-vision-exp')).toBe(true);
		expect(isNikaGeminiModel('gemini-2.5-flash')).toBe(true);
		expect(getNikaModelCapabilities('deepseek-v4-flash-responses', limits).supportedEndpoints).toHaveLength(1);
		expect(getNikaModelCapabilities('deepseek-v4-pro-responses', limits).name).toBe('DeepSeek V4 Pro (Responses)');
		expect(getNikaModelCapabilities('deepseek-v4-pro-responses', limits).supportedEndpoints).toHaveLength(1);
		expect(getNikaModelCapabilities('deepseek-v4-flash-vision-exp', limits).name).toBe('DeepSeek V4 Flash Vision (Exp)');
		expect(getNikaModelCapabilities('deepseek-v4-flash-vision-exp', limits).vision).toBe(true);
		expect(getNikaModelCapabilities('deepseek-v4-flash-vision-exp-responses', limits).name).toBe('DeepSeek V4 Flash Vision (Exp) (Responses)');
		expect(getNikaModelCapabilities('gemini-2.5-flash', limits).vision).toBe(true);
		expect(getNikaModelCapabilities('gemma4:31b', limits).vision).toBe(true);
	});

	it('recognizes the DeepSeek vision model ids with or without the nika/ prefix', () => {
		expect(isNikaDeepSeekVisionModel('deepseek-v4-flash-vision-exp')).toBe(true);
		expect(isNikaDeepSeekVisionModel('deepseek-v4-flash-vision-exp-responses')).toBe(true);
		expect(isNikaDeepSeekVisionModel('nika/deepseek-v4-flash-vision-exp')).toBe(true);
		expect(isNikaDeepSeekVisionModel('nika/deepseek-v4-flash-vision-exp-responses')).toBe(true);
		expect(isNikaDeepSeekVisionModel('deepseek-v4-flash')).toBe(false);
		expect(isNikaDeepSeekVisionModel('deepseek-v4-flash-responses')).toBe(false);
		expect(isNikaDeepSeekVisionModel('deepseek-v4-pro')).toBe(false);
	});

	it('hides cloud models until their corresponding key exists', () => {
		expect(getVisibleNikaModelIds(false, false)).toEqual(['gemma4:31b']);
		expect(getVisibleNikaModelIds(true, false)).toEqual([
			'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-responses', 'deepseek-v4-pro-responses', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-flash-vision-exp-responses', 'gemma4:31b',
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
		expect(getNikaModelProvider('openai/gpt-5')).toBe('openai');
		expect(getNikaModelProvider('nika/openai/gpt-5')).toBe('openai');
		expect(getNikaModelProvider('anthropic/claude-sonnet-4')).toBe('anthropic');
		expect(getNikaModelProvider('nika/anthropic/claude-sonnet-4')).toBe('anthropic');
		expect(getNikaModelProvider('zai/glm-4.5')).toBe('zai');
		expect(getNikaModelProvider('nika/zai/glm-4.5')).toBe('zai');
		expect(getNikaModelProvider('chatgpt/gpt-5-codex')).toBe('chatgpt');
		expect(getNikaModelProvider('nika/chatgpt/gpt-5-codex')).toBe('chatgpt');
		expect(getNikaModelProvider('claude/claude-opus-4-5')).toBe('claude');
		expect(getNikaModelProvider('nika/claude/claude-opus-4-5')).toBe('claude');
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
		expect(getNikaEffortOptionsForModel('openai/gpt-5')).toEqual(['low', 'medium', 'high']);
		expect(getNikaEffortOptionsForModel('openai/gpt-4o')).toEqual(['low', 'medium', 'high']); // provider-level fallback; the catalog narrows per model
		expect(getNikaEffortOptionsForModel('anthropic/claude-sonnet-4')).toEqual([]);
		expect(getNikaEffortOptionsForModel('chatgpt/gpt-5.6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']); // codex range
		expect(getNikaEffortOptionsForModel('claude/claude-opus-4-5')).toEqual([]);
		expect(getNikaEffortOptionsForModel('zai/glm-4.5')).toEqual([]); // Z.ai GLM models have no effort control
		expect(getNikaEffortOptionsForModel('llamacpp/qwen2.5vl-7b')).toEqual([]);
		expect(getNikaEffortOptionsForModel('gemma4:31b')).toEqual([]);
		expect(getNikaEffortOptionsForModel('unknown-model')).toEqual([]);
	});

	it('accepts the medium effort level', () => {
		expect(isNikaThinkingEffort('medium')).toBe(true);
		expect(isNikaThinkingEffort('none')).toBe(true);
		expect(isNikaThinkingEffort('max')).toBe(true);
		expect(isNikaThinkingEffort('xhigh')).toBe(true);
		expect(isNikaThinkingEffort('ultra')).toBe(true);
		expect(isNikaThinkingEffort('turbo')).toBe(false);
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
		// Subscription providers are accepted like any other.
		expect(parseNikaProviderConfig({
			chatgpt: { models: ['chatgpt/gpt-5-codex', 42] },
			claude: { models: ['claude/claude-opus-4-5'] },
		})).toEqual({
			chatgpt: { models: ['chatgpt/gpt-5-codex'] },
			claude: { models: ['claude/claude-opus-4-5'] },
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
		expect(getNikaSelectedModels(parseNikaProviderConfig({ chatgpt: { models: ['chatgpt/gpt-5-codex'] } }), 'chatgpt')).toEqual(['chatgpt/gpt-5-codex']);
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
			'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-responses', 'deepseek-v4-pro-responses', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-flash-vision-exp-responses', 'gemma4:31b',
		]);
	});

	it('recognizes multi-server SGLang model ids without an effort control', () => {
		// The raw id may itself contain slashes (`Qwen/Qwen3-32B`); the first
		// segment after the family prefix is always the server id.
		expect(isNikaModelId('sglang/gpu-1/Qwen/Qwen3-32B')).toBe(true);
		expect(isNikaSglangModel('sglang/gpu-1/Qwen/Qwen3-32B')).toBe(true);
		expect(getNikaModelProvider('sglang/gpu-1/Qwen/Qwen3-32B')).toBe('sglang');
		expect(getNikaModelProvider('nika/sglang/gpu-1/Qwen/Qwen3-32B')).toBe('sglang');
		expect(getNikaEffortOptionsForModel('sglang/gpu-1/Qwen/Qwen3-32B')).toEqual([]);
		expect(isNikaSglangModel('llamacpp/qwen2.5vl-7b')).toBe(false);
	});

	it('round-trips the exposed SGLang model id', () => {
		const id = nikaSglangModelId('box1', 'Qwen/Qwen3-32B');
		expect(id).toBe('sglang/box1/Qwen/Qwen3-32B');
		expect(parseNikaSglangModelId(id)).toEqual({ serverId: 'box1', rawId: 'Qwen/Qwen3-32B' });
		expect(parseNikaSglangModelId(`nika/${id}`)).toEqual({ serverId: 'box1', rawId: 'Qwen/Qwen3-32B' });
		// A slash-free raw id still resolves; malformed ids do not.
		expect(parseNikaSglangModelId('sglang/box1/llama-3.2-3b')).toEqual({ serverId: 'box1', rawId: 'llama-3.2-3b' });
		expect(parseNikaSglangModelId('sglang/box1')).toBeUndefined();
		expect(parseNikaSglangModelId('sglang/box1/')).toBeUndefined();
		expect(parseNikaSglangModelId('/box1/model')).toBeUndefined();
		expect(parseNikaSglangModelId('llamacpp/qwen2.5vl-7b')).toBeUndefined();
	});

	it('keeps every SGLang server API key in its own secret', () => {
		expect(nikaSglangApiKeySecret('box1')).toBe('nika.sglang.box1.apiKey');
		expect(nikaSglangApiKeySecret('box2')).not.toBe(nikaSglangApiKeySecret('box1'));
	});

	it('slugifies SGLang server ids into id-safe, secret-safe fragments', () => {
		expect(slugifyNikaSglangServerId('GPU Rig #2')).toBe('gpu-rig-2');
		expect(slugifyNikaSglangServerId('http://localhost:30000')).toBe('localhost-30000');
		expect(slugifyNikaSglangServerId('  Box/One  ')).toBe('box-one');
		expect(slugifyNikaSglangServerId('---')).toBe('server');
		expect(slugifyNikaSglangServerId('')).toBe('server');
	});

	it('parses and normalizes nika.sglang.servers into unique servers', () => {
		// Absent or malformed values mean "no servers".
		expect(parseNikaSglangServers(undefined)).toEqual([]);
		expect(parseNikaSglangServers(null)).toEqual([]);
		expect(parseNikaSglangServers(42)).toEqual([]);
		// A lone entry is read as a one-element list: hand-written settings
		// spell a single server as one object (or one bare URL).
		expect(parseNikaSglangServers({ id: 'arbelai', label: 'ArbelAI', baseUrl: 'http://192.168.2.70:8010' })).toEqual([
			{ id: 'arbelai', label: 'ArbelAI', baseUrl: 'http://192.168.2.70:8010' },
		]);
		expect(parseNikaSglangServers('http://192.168.2.70:8010/v1')).toEqual([
			{ id: '192-168-2-70-8010', label: '192.168.2.70:8010', baseUrl: 'http://192.168.2.70:8010' },
		]);
		// Entries without an http(s) base URL are dropped.
		expect(parseNikaSglangServers([{ label: 'no url' }, 'localhost:30000', '', 42, null])).toEqual([]);
		// Objects and bare URL strings are both accepted; ids derive from the
		// label, then the id, then the URL host, and duplicates get suffixes.
		expect(parseNikaSglangServers([
			{ id: 'gpu-1', label: 'GPU 1', baseUrl: 'http://10.0.0.5:30000/' },
			{ baseUrl: 'http://10.0.0.5:30001' },
			'http://localhost:30000',
			{ label: 'GPU 1', baseUrl: 'http://10.0.0.6:30000' },
		])).toEqual([
			{ id: 'gpu-1', label: 'GPU 1', baseUrl: 'http://10.0.0.5:30000' },
			{ id: '10-0-0-5-30001', label: '10.0.0.5:30001', baseUrl: 'http://10.0.0.5:30001' },
			{ id: 'localhost-30000', label: 'localhost:30000', baseUrl: 'http://localhost:30000' },
			{ id: 'gpu-1-2', label: 'GPU 1', baseUrl: 'http://10.0.0.6:30000' },
		]);
	});

	it('strips a pasted /v1 path from the SGLang base URL', () => {
		// Copied URLs commonly carry the OpenAI-compatible path the provider
		// appends itself; keeping it would request `/v1/v1/models` and 404.
		expect(parseNikaSglangServers([
			{ label: 'Box A', baseUrl: 'http://192.168.2.70:8010/v1' },
			{ label: 'Box B', baseUrl: 'http://192.168.2.70:8011/v1/' },
			{ label: 'Box C', baseUrl: 'http://192.168.2.70:8012/V1/models' },
			{ label: 'Box D', baseUrl: 'http://192.168.2.70:8013/v1/chat/completions' },
			{ label: 'Box E', baseUrl: 'http://192.168.2.70:8014' },
		])).toEqual([
			{ id: 'box-a', label: 'Box A', baseUrl: 'http://192.168.2.70:8010' },
			{ id: 'box-b', label: 'Box B', baseUrl: 'http://192.168.2.70:8011' },
			{ id: 'box-c', label: 'Box C', baseUrl: 'http://192.168.2.70:8012' },
			{ id: 'box-d', label: 'Box D', baseUrl: 'http://192.168.2.70:8013' },
			{ id: 'box-e', label: 'Box E', baseUrl: 'http://192.168.2.70:8014' },
		]);
		// Only the trailing OpenAI path is stripped: a genuine sub-path stays
		// (the derived label/id are always host and port).
		expect(parseNikaSglangServers(['http://host:9000/sglang/v1'])).toEqual([
			{ id: 'host-9000', label: 'host:9000', baseUrl: 'http://host:9000/sglang' },
		]);
	});

	it('accepts SGLang in the managed provider config', () => {
		const config = parseNikaProviderConfig({ sglang: { models: ['sglang/gpu-1/Qwen/Qwen3-32B', 42] } });
		expect(config).toEqual({ sglang: { models: ['sglang/gpu-1/Qwen/Qwen3-32B'] } });
		expect(getNikaSelectedModels(config, 'sglang')).toEqual(['sglang/gpu-1/Qwen/Qwen3-32B']);
	});
});
