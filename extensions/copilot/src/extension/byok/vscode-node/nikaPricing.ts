/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NikaModelId } from './nikaModels';

/**
 * DeepSeek V4 per-1M-token prices in USD at PEAK rates, per
 * https://api-docs.deepseek.com/quick_start/pricing (peak/off-peak billing
 * effective 2026-08-16 16:00 UTC; off-peak rates are exactly half of peak).
 *
 * Prices are keyed by the canonical model name WITHOUT the `-responses`
 * suffix: the Responses API models bill at their base model's rate.
 */
export interface DeepSeekModelPricing {
	/** Price per 1M input tokens that hit the context cache (peak). */
	readonly cacheHitPerMTok: number;
	/** Price per 1M input tokens that missed the context cache (peak). */
	readonly cacheMissPerMTok: number;
	/** Price per 1M output tokens (peak). */
	readonly outputPerMTok: number;
}

export const NIKA_DEEPSEEK_PEAK_PRICES: Readonly<Record<string, DeepSeekModelPricing>> = {
	'deepseek-v4-flash': { cacheHitPerMTok: 0.014, cacheMissPerMTok: 0.44, outputPerMTok: 1.32 },
	'deepseek-v4-pro': { cacheHitPerMTok: 0.044, cacheMissPerMTok: 1.32, outputPerMTok: 3.96 },
};

/**
 * DeepSeek's peak billing windows, in UTC:
 *  - 01:00–04:00
 *  - 06:00–10:00
 * All other hours are off-peak (half price). Boundaries are half-open:
 * 04:00 is off-peak, 06:00 is peak, 10:00 is off-peak.
 */
export function isDeepSeekPeakHour(date: Date = new Date()): boolean {
	const hour = date.getUTCHours();
	return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * Resolve the canonical pricing key for a Nika DeepSeek model id. The
 * `-responses` models bill at their base model's rate.
 */
export function deepSeekPricingKey(id: string): string | undefined {
	const canonical = id.endsWith('-responses') ? id.slice(0, -'-responses'.length) : id;
	return canonical in NIKA_DEEPSEEK_PEAK_PRICES ? canonical : undefined;
}

export interface DeepSeekTokenCostBreakdown {
	/** True when the request landed in a peak billing window. */
	readonly peak: boolean;
	/** Input tokens served from the context cache. */
	readonly cacheHitTokens: number;
	/** Input tokens that missed the context cache. */
	readonly cacheMissTokens: number;
	/** Output tokens. */
	readonly outputTokens: number;
	/** Total USD cost for this request (already off-peak-adjusted). */
	readonly cost: number;
	/** PEAK or OFF-PEAK label. */
	readonly rateLabel: 'PEAK' | 'OFF-PEAK';
}

/**
 * Compute the USD cost of a DeepSeek request. `inputTokens` and
 * `cachedTokens` are split into cache-hit vs cache-miss legs; off-peak
 * requests are billed at half the peak rate.
 */
export function getDeepSeekTokenCost(
	modelId: string,
	options: { inputTokens: number; outputTokens: number; cachedTokens: number },
	date: Date = new Date(),
): DeepSeekTokenCostBreakdown | undefined {
	const key = deepSeekPricingKey(modelId);
	if (!key) {
		return undefined;
	}
	const pricing = NIKA_DEEPSEEK_PEAK_PRICES[key];
	const peak = isDeepSeekPeakHour(date);
	const multiplier = peak ? 1 : 0.5;

	const cacheHitTokens = Math.max(0, Math.min(options.cachedTokens, options.inputTokens));
	const cacheMissTokens = Math.max(0, options.inputTokens - cacheHitTokens);
	const outputTokens = Math.max(0, options.outputTokens);

	const cost = (
		(cacheHitTokens / 1_000_000) * pricing.cacheHitPerMTok
		+ (cacheMissTokens / 1_000_000) * pricing.cacheMissPerMTok
		+ (outputTokens / 1_000_000) * pricing.outputPerMTok
	) * multiplier;

	return {
		peak,
		cacheHitTokens,
		cacheMissTokens,
		outputTokens,
		cost,
		rateLabel: peak ? 'PEAK' : 'OFF-PEAK',
	};
}

/**
 * Format a USD amount for display, e.g. `$0.031` or `$1.24`.
 */
export function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) {
		return '$0';
	}
	if (cost < 0.01) {
		// Sub-cent amounts are the common case for single requests; show
		// enough precision to be meaningful ($0.00042 → $0.0004).
		return `$${cost.toFixed(4).replace(/0+$/, '')}`;
	}
	if (cost < 100) {
		return `$${cost.toFixed(2)}`;
	}
	return `$${cost.toFixed(0)}`;
}

/**
 * Format a token count for the status bar, e.g. `1.2k`, `34k`, `1.4M`.
 */
export function formatTokenCount(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) {
		tokens = 0;
	}
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
	}
	return String(tokens);
}

/** Convenience re-export so pricing consumers can key off the model union. */
export function isNikaDeepSeekModelId(id: NikaModelId | string): boolean {
	return deepSeekPricingKey(id) !== undefined;
}
