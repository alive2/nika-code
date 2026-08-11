/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { getNikaModelCapabilities, getVisibleNikaModelIds, isNikaDeepSeekModel, isNikaGeminiModel, isNikaModelId, NIKA_AGENT_DEFAULTS, NIKA_RESPONSES_MODEL, resolveNikaTokenLimits } from '../nikaModels';

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
		expect(isNikaModelId('gemini-2.5-flash')).toBe(true);
		expect(isNikaModelId('gemini-2.5-flash-lite')).toBe(true);
		expect(isNikaModelId('gemma4:31b')).toBe(true);
		expect(isNikaModelId('unknown')).toBe(false);
		expect(isNikaDeepSeekModel('deepseek-v4-flash')).toBe(true);
		expect(isNikaGeminiModel('gemini-2.5-flash')).toBe(true);
		expect(getNikaModelCapabilities('deepseek-v4-flash-responses', limits).supportedEndpoints).toHaveLength(1);
		expect(getNikaModelCapabilities('gemini-2.5-flash', limits).vision).toBe(true);
		expect(getNikaModelCapabilities('gemma4:31b', limits).vision).toBe(true);
	});

	it('hides cloud models until their corresponding key exists', () => {
		expect(getVisibleNikaModelIds(false, false)).toEqual(['gemma4:31b']);
		expect(getVisibleNikaModelIds(true, false)).toEqual([
			'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-responses', 'gemma4:31b',
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
});
