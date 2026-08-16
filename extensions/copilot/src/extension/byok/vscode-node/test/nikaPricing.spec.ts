/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	deepSeekPricingKey,
	formatCost,
	formatDuration,
	formatTokenCount,
	getDeepSeekRatePeriod,
	getDeepSeekTokenCost,
	isDeepSeekPeakHour,
	NIKA_DEEPSEEK_PEAK_PRICES,
} from '../nikaPricing';

/** Build a UTC Date at the given hour for peak-hour boundary tests. */
function utcHour(hour: number, minute = 0): Date {
	return new Date(Date.UTC(2026, 7, 16, hour, minute, 0));
}

describe('Nika DeepSeek pricing', () => {
	it('treats documented peak windows as peak', () => {
		expect(isDeepSeekPeakHour(utcHour(1))).toBe(true);
		expect(isDeepSeekPeakHour(utcHour(3, 59))).toBe(true);
		expect(isDeepSeekPeakHour(utcHour(6))).toBe(true);
		expect(isDeepSeekPeakHour(utcHour(9, 59))).toBe(true);
	});

	it('treats everything else as off-peak', () => {
		expect(isDeepSeekPeakHour(utcHour(0))).toBe(false);
		expect(isDeepSeekPeakHour(utcHour(4))).toBe(false);
		expect(isDeepSeekPeakHour(utcHour(5, 59))).toBe(false);
		expect(isDeepSeekPeakHour(utcHour(10))).toBe(false);
		expect(isDeepSeekPeakHour(utcHour(23))).toBe(false);
	});

	it('publishes both DeepSeek models with peak rates', () => {
		expect(NIKA_DEEPSEEK_PEAK_PRICES['deepseek-v4-flash']).toEqual({ cacheHitPerMTok: 0.014, cacheMissPerMTok: 0.44, outputPerMTok: 1.32 });
		expect(NIKA_DEEPSEEK_PEAK_PRICES['deepseek-v4-pro']).toEqual({ cacheHitPerMTok: 0.044, cacheMissPerMTok: 1.32, outputPerMTok: 3.96 });
	});

	it('maps responses models to their base pricing key', () => {
		expect(deepSeekPricingKey('deepseek-v4-flash')).toBe('deepseek-v4-flash');
		expect(deepSeekPricingKey('deepseek-v4-pro-responses')).toBe('deepseek-v4-pro');
		expect(deepSeekPricingKey('gemini-2.5-flash')).toBeUndefined();
		expect(deepSeekPricingKey('gemma4:31b')).toBeUndefined();
	});

	it('computes peak cost with cache-hit/miss split', () => {
		// 1M input (half cached) + 1M output on pro at peak:
		// 0.5M*0.044 + 0.5M*1.32 + 1M*3.96 = 0.022 + 0.66 + 3.96 = 4.642
		const result = getDeepSeekTokenCost('deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 500_000 }, utcHour(2));
		expect(result).toBeDefined();
		expect(result!.peak).toBe(true);
		expect(result!.rateLabel).toBe('PEAK');
		expect(result!.cacheHitTokens).toBe(500_000);
		expect(result!.cacheMissTokens).toBe(500_000);
		expect(result!.outputTokens).toBe(1_000_000);
		expect(result!.cost).toBeCloseTo(4.642, 6);
	});

	it('halves the cost off-peak', () => {
		const peak = getDeepSeekTokenCost('deepseek-v4-flash', { inputTokens: 100_000, outputTokens: 50_000, cachedTokens: 0 }, utcHour(2))!;
		const offPeak = getDeepSeekTokenCost('deepseek-v4-flash', { inputTokens: 100_000, outputTokens: 50_000, cachedTokens: 0 }, utcHour(23))!;
		expect(offPeak.peak).toBe(false);
		expect(offPeak.rateLabel).toBe('OFF-PEAK');
		expect(offPeak.cost).toBeCloseTo(peak.cost / 2, 8);
	});

	it('clamps cached tokens to the input total', () => {
		const result = getDeepSeekTokenCost('deepseek-v4-flash', { inputTokens: 10_000, outputTokens: 0, cachedTokens: 99_000 }, utcHour(2))!;
		expect(result.cacheHitTokens).toBe(10_000);
		expect(result.cacheMissTokens).toBe(0);
	});

	it('returns undefined for non-DeepSeek models', () => {
		expect(getDeepSeekTokenCost('gemini-2.5-flash', { inputTokens: 10, outputTokens: 10, cachedTokens: 0 })).toBeUndefined();
	});

	it('formats token counts for the status bar', () => {
		expect(formatTokenCount(0)).toBe('0');
		expect(formatTokenCount(999)).toBe('999');
		expect(formatTokenCount(1200)).toBe('1.2k');
		expect(formatTokenCount(34_000)).toBe('34k');
		expect(formatTokenCount(1_400_000)).toBe('1.4M');
	});

	it('formats costs for display', () => {
		expect(formatCost(0)).toBe('$0');
		expect(formatCost(0.00042)).toBe('$0.0004');
		expect(formatCost(0.031)).toBe('$0.03');
		expect(formatCost(1.24)).toBe('$1.24');
		expect(formatCost(123.456)).toBe('$123');
	});

	describe('getDeepSeekRatePeriod', () => {
		it('reports peak windows and their end time', () => {
			// 02:30 UTC → inside 01:00–04:00; ends at 04:00, next is off-peak.
			const mid = getDeepSeekRatePeriod(new Date(Date.UTC(2026, 7, 16, 2, 30, 0)));
			expect(mid.peak).toBe(true);
			expect(mid.nextIsPeak).toBe(false);
			expect(mid.endsAt).toBe(Date.UTC(2026, 7, 16, 4, 0, 0));

			// 08:00 UTC → inside 06:00–10:00; ends at 10:00.
			const late = getDeepSeekRatePeriod(new Date(Date.UTC(2026, 7, 16, 8, 0, 0)));
			expect(late.peak).toBe(true);
			expect(late.endsAt).toBe(Date.UTC(2026, 7, 16, 10, 0, 0));
		});

		it('reports the next peak start during off-peak gaps', () => {
			// 05:00 UTC → off-peak gap between 04:00 and 06:00; next peak at 06:00.
			const gap = getDeepSeekRatePeriod(new Date(Date.UTC(2026, 7, 16, 5, 0, 0)));
			expect(gap.peak).toBe(false);
			expect(gap.nextIsPeak).toBe(true);
			expect(gap.endsAt).toBe(Date.UTC(2026, 7, 16, 6, 0, 0));

			// 12:00 UTC → off-peak after 10:00; next peak at 01:00 the NEXT day.
			const afternoon = getDeepSeekRatePeriod(new Date(Date.UTC(2026, 7, 16, 12, 0, 0)));
			expect(afternoon.peak).toBe(false);
			expect(afternoon.nextIsPeak).toBe(true);
			expect(afternoon.endsAt).toBe(Date.UTC(2026, 7, 17, 1, 0, 0));

			// 00:30 UTC → off-peak before 01:00; next peak at 01:00 today.
			const midnight = getDeepSeekRatePeriod(new Date(Date.UTC(2026, 7, 16, 0, 30, 0)));
			expect(midnight.peak).toBe(false);
			expect(midnight.nextIsPeak).toBe(true);
			expect(midnight.endsAt).toBe(Date.UTC(2026, 7, 16, 1, 0, 0));
		});
	});

	it('formats durations for countdowns', () => {
		expect(formatDuration(0)).toBe('<1m');
		expect(formatDuration(59_000)).toBe('<1m');
		expect(formatDuration(60_000)).toBe('1m');
		expect(formatDuration(45 * 60_000)).toBe('45m');
		expect(formatDuration(60 * 60_000)).toBe('1h');
		expect(formatDuration(83 * 60_000)).toBe('1h 23m');
		expect(formatDuration(-5000)).toBe('<1m');
	});
});
