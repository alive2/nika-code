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

/** Peak window boundaries in UTC minutes-of-day: 01:00–04:00 and 06:00–10:00. */
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
	[1 * 60, 4 * 60],
	[6 * 60, 10 * 60],
];

export interface NikaRatePeriodInfo {
	/** True when the current UTC hour is inside a peak window. */
	readonly peak: boolean;
	/** Epoch ms at which the current period ends and the opposite rate begins. */
	readonly endsAt: number;
	/** True when the period starting at {@link endsAt} is a peak window. */
	readonly nextIsPeak: boolean;
}

/**
 * Describe the current DeepSeek rate period and when it flips, so callers can
 * render a countdown ("1h 23m left" / "2h 05m to PEAK").
 */
export function getDeepSeekRatePeriod(date: Date = new Date()): NikaRatePeriodInfo {
	const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
	const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

	for (const [start, end] of PEAK_WINDOWS) {
		if (minutes >= start && minutes < end) {
			// Inside a peak window: it ends at the window's end (today).
			return { peak: true, endsAt: dayStart + end * 60_000, nextIsPeak: false };
		}
		if (minutes < start) {
			// Off-peak, before the first peak window of the day: it ends when the
			// next peak window starts (today).
			return { peak: false, endsAt: dayStart + start * 60_000, nextIsPeak: true };
		}
	}
	// Off-peak, after the last peak window of the day: it ends at the first
	// peak window of the NEXT day (01:00 tomorrow).
	return { peak: false, endsAt: dayStart + 24 * 60 * 60_000 + PEAK_WINDOWS[0][0] * 60_000, nextIsPeak: true };
}

/**
 * Both DeepSeek rate-period deadlines at once, so the status bar can show how
 * long the current period lasts AND when the next rate flip happens.
 */
export interface NikaRateCountdowns {
	/** True when the current UTC time is inside a peak window. */
	readonly peak: boolean;
	/** Epoch ms at which the current peak window ends (next off-peak begins). */
	readonly peakEndsAt: number;
	/** Epoch ms at which the current off-peak window ends (next peak begins). */
	readonly offPeakEndsAt: number;
}

/**
 * Compute both countdown deadlines: when the current (or next) peak window
 * ends and when the current off-peak window ends. Shares the window table with
 * {@link getDeepSeekRatePeriod}.
 *
 * - In PEAK (e.g. 02:00 UTC): `peakEndsAt` = 04:00 today, `offPeakEndsAt` = 06:00 today.
 * - In OFF-PEAK (e.g. 12:00 UTC): `peakEndsAt` = 04:00 tomorrow, `offPeakEndsAt` = 01:00 tomorrow.
 */
export function getDeepSeekRateCountdowns(date: Date = new Date()): NikaRateCountdowns {
	const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
	const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

	for (const [start, end] of PEAK_WINDOWS) {
		if (minutes >= start && minutes < end) {
			// Inside a peak window: it ends at the window's end (today); the
			// off-peak window ends when the next peak window starts.
			const nextPeakStart = PEAK_WINDOWS.find(([s]) => s >= end) ?? PEAK_WINDOWS[0];
			const offPeakEndsAt = dayStart + nextPeakStart[0] * 60_000 + (nextPeakStart === PEAK_WINDOWS[0] ? 24 * 60 * 60_000 : 0);
			return { peak: true, peakEndsAt: dayStart + end * 60_000, offPeakEndsAt };
		}
		if (minutes < start) {
			// Off-peak, before the first peak window of the day: the off-peak
			// window ends when that peak window starts; the peak window ends at
			// its own end (today).
			return { peak: false, peakEndsAt: dayStart + end * 60_000, offPeakEndsAt: dayStart + start * 60_000 };
		}
	}
	// Off-peak, after the last peak window of the day: the off-peak window ends
	// at the first peak window of the NEXT day (01:00 tomorrow); the next peak
	// window ends at 04:00 tomorrow.
	return { peak: false, peakEndsAt: dayStart + 24 * 60 * 60_000 + PEAK_WINDOWS[0][1] * 60_000, offPeakEndsAt: dayStart + 24 * 60 * 60_000 + PEAK_WINDOWS[0][0] * 60_000 };
}

/**
 * Format a duration for countdowns, e.g. `45m`, `1h`, `1h 23m`, `<1m`.
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) {
		return '<1m';
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	return `${minutes}m`;
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

/**
 * Raw OpenRouter catalog pricing as served by `GET /api/v1/models`. All fields
 * are USD strings; token prices are per 1M tokens and `request` is a flat fee
 * per request. Fields that a model does not charge for are omitted by the API.
 *
 * @see https://openrouter.ai/docs/api-reference/models
 */
export interface OpenRouterPricingRaw {
	/** USD per 1M prompt (input) tokens. */
	readonly prompt?: string;
	/** USD per 1M completion (output) tokens. */
	readonly completion?: string;
	/** Flat USD fee charged per request. */
	readonly request?: string;
	/** USD per image (used by vision preprocessing / direct image input). */
	readonly image?: string;
	/** USD per web search call. */
	readonly web_search?: string;
	/** USD per 1M prompt tokens served from the prompt cache. */
	readonly cache_read?: string;
	/** USD per 1M prompt tokens written to the prompt cache. */
	readonly cache_write?: string;
}

/**
 * Parsed OpenRouter pricing. Unlike DeepSeek, OpenRouter has no peak/off-peak
 * billing — the catalog price applies at all hours.
 */
export interface OpenRouterModelPricing {
	/** USD per 1M prompt (input) tokens. */
	readonly promptPerMTok: number;
	/** USD per 1M completion (output) tokens. */
	readonly completionPerMTok: number;
	/** USD per 1M prompt tokens served from the prompt cache. */
	readonly cacheReadPerMTok: number;
	/** Flat USD fee charged per request. */
	readonly requestFee: number;
	/** USD per image, when the model charges per image. */
	readonly imagePerUnit?: number;
	/** USD per web search call, when the model supports web search. */
	readonly webSearchPerUnit?: number;
	/** True when every price line is zero (a `:free` catalog variant). */
	readonly free: boolean;
}

function parsePriceField(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.max(0, value);
	}
	if (typeof value === 'string') {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
	}
	return 0;
}

/**
 * Parse an OpenRouter catalog `pricing` object. Returns `undefined` when the
 * payload is not an object (catalog entries without pricing). All-zero lines
 * are preserved and flagged via {@link OpenRouterModelPricing.free} so callers
 * can render a `Free` label instead of `$0`.
 */
export function parseOpenRouterPricing(raw: unknown): OpenRouterModelPricing | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const promptPerMTok = parsePriceField(record.prompt);
	const completionPerMTok = parsePriceField(record.completion);
	const cacheReadPerMTok = parsePriceField(record.cache_read);
	const requestFee = parsePriceField(record.request);
	const imagePerUnit = parsePriceField(record.image);
	const webSearchPerUnit = parsePriceField(record.web_search);
	return {
		promptPerMTok,
		completionPerMTok,
		cacheReadPerMTok,
		requestFee,
		...(imagePerUnit > 0 ? { imagePerUnit } : {}),
		...(webSearchPerUnit > 0 ? { webSearchPerUnit } : {}),
		free: promptPerMTok === 0 && completionPerMTok === 0 && cacheReadPerMTok === 0 && requestFee === 0 && imagePerUnit === 0 && webSearchPerUnit === 0,
	};
}

/**
 * Format a USD amount, e.g. `$0.44`, `$1.32`, `$12.5`, `$0.0002`. Sub-cent
 * values keep enough significant digits to be meaningful (`0.00005` →
 * `$0.00005`, `0.0000001` → `$0.0000001`), and a zero amount renders as `$0`
 * — never a trailing-dot `$0.` from stripping zeros off a rounded value.
 */
export function formatUsdAmount(amount: number): string {
	if (!Number.isFinite(amount) || amount <= 0) {
		return '$0';
	}
	if (amount >= 100) {
		return `$${amount.toFixed(0)}`;
	}
	if (amount >= 0.01) {
		return `$${amount.toFixed(2).replace(/\.?0+$/, '')}`;
	}
	// Sub-cent: show ~2 significant digits, trimming trailing zeros but never
	// leaving a bare `0.` (e.g. 0.00005 → `$0.00005`, 0.0000001 → `$0.0000001`).
	const decimals = Math.max(2, Math.min(8, -Math.floor(Math.log10(amount)) + 2));
	const trimmed = amount.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
	return `$${trimmed}`;
}

/**
 * Compact human-readable OpenRouter price label for the model picker, hover,
 * status bar, and Usage dashboard. Free models render as `Free`; everything
 * else as e.g. `$0.44/M in · $1.32/M out · cache $0.02/M · $0.05/req`.
 */
export function formatOpenRouterPriceLabel(pricing: OpenRouterModelPricing): string {
	if (pricing.free) {
		return 'Free';
	}
	const parts: string[] = [
		`${formatUsdAmount(pricing.promptPerMTok)}/M in`,
		`${formatUsdAmount(pricing.completionPerMTok)}/M out`,
	];
	if (pricing.cacheReadPerMTok > 0) {
		parts.push(`cache ${formatUsdAmount(pricing.cacheReadPerMTok)}/M`);
	}
	if (pricing.requestFee > 0) {
		parts.push(`${formatUsdAmount(pricing.requestFee)}/req`);
	}
	return parts.join(' · ');
}

/**
 * Compute the USD cost of an OpenRouter request from catalog pricing. There is
 * no peak/off-peak split: the catalog price applies at all hours. Input tokens
 * split into cache reads and cache misses; the flat per-request fee (when the
 * model charges one) is added once.
 */
export function getOpenRouterTokenCost(
	pricing: OpenRouterModelPricing,
	options: { cachedTokens: number; cacheMissTokens: number; outputTokens: number },
): number {
	const cost = (
		(options.cacheMissTokens / 1_000_000) * pricing.promptPerMTok
		+ (options.cachedTokens / 1_000_000) * pricing.cacheReadPerMTok
		+ (options.outputTokens / 1_000_000) * pricing.completionPerMTok
		+ pricing.requestFee
	);
	return Math.max(0, cost);
}
