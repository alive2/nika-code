/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CustomDataPartMimeTypes } from '../../../platform/endpoint/common/endpointTypes';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { APIUsage, isApiUsage } from '../../../platform/networking/common/openai';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { getDeepSeekTokenCost, getOpenRouterTokenCost, isDeepSeekPeakHour, OpenRouterModelPricing } from './nikaPricing';

/**
 * Which Nika provider produced a usage event. Legacy events (recorded before
 * provider tracking existed) default to `'deepseek'` when loaded.
 */
export type NikaUsageProvider = 'deepseek' | 'gemini' | 'ollama' | 'openrouter' | 'llamacpp' | 'cursor';

/**
 * A single recorded DeepSeek request. Persisted in extension `globalState` so
 * totals survive restarts and can be aggregated per message, session,
 * workspace, and day.
 */
export interface NikaUsageEvent {
	/** Monotonic id used for React keys / ordering. */
	readonly id: number;
	/** Request completion timestamp (ms since epoch). */
	readonly t: number;
	/** Real chat session id (or a stable heuristic id when none was threaded). */
	readonly sessionId: string;
	/** Short snippet of the user prompt that started this request. */
	readonly title?: string;
	/** Workspace folder name the request happened in, when known. */
	readonly workspace?: string;
	/** Model id as used on the wire (e.g. `deepseek-v4-pro-responses`). */
	readonly model: string;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
	/** Input tokens served from the context cache. */
	readonly cachedTokens: number;
	/** Reasoning tokens included in the completion total. */
	readonly reasoningTokens: number;
	/** Provider that served the request (`deepseek` for legacy events). */
	readonly provider: NikaUsageProvider;
	/** True when the request landed in a DeepSeek peak billing window. */
	readonly peak: boolean;
	/** USD cost (already off-peak adjusted); 0 when not computable. */
	readonly cost: number;
	/** OpenRouter catalog pricing snapshot at request time (OpenRouter events only). */
	readonly pricing?: OpenRouterModelPricing;
	/** True when the request failed before producing a usage report. */
	readonly error?: boolean;
}

export interface NikaUsageRecordOptions {
	readonly model: string;
	readonly sessionId?: string;
	/** Request initiator (extension id) — used to build heuristic session ids. */
	readonly initiator?: string;
	readonly title?: string;
	readonly workspace?: string;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
	readonly cachedTokens: number;
	readonly reasoningTokens: number;
	/** Provider that served the request; defaults to `deepseek`. */
	readonly provider?: NikaUsageProvider;
	/** OpenRouter catalog pricing snapshot; drives cost for OpenRouter events. */
	readonly pricing?: OpenRouterModelPricing;
	readonly error?: boolean;
}

export interface NikaSessionSummary {
	sessionId: string;
	title?: string;
	workspace?: string;
	/** First request timestamp (ms). */
	start: number;
	/** Last request timestamp (ms). */
	end: number;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cost: number;
}

export interface NikaWorkspaceSummary {
	workspace: string;
	sessions: number;
	requests: number;
	totalTokens: number;
	cost: number;
}

/**
 * Wraps the `Progress` reporter handed to the LM provider. It forwards every
 * part verbatim while (a) accumulating streamed text/thinking characters for a
 * throttled live token estimate and (b) capturing the exact server-reported
 * `APIUsage` that arrives as a `'usage'` data part at the end of a request.
 */
export class TokenTrackingProgress implements vscode.Progress<vscode.LanguageModelResponsePart2> {
	private _liveChars = 0;
	private _exactUsage: APIUsage | undefined;
	private readonly _startedAt = Date.now();
	private _firstCharAt: number | undefined;

	constructor(
		private readonly _delegate: vscode.Progress<vscode.LanguageModelResponsePart2>,
		private readonly _onLiveChange: () => void,
	) { }

	/** Live estimate: ~4 chars per token, corrected by {@link exactUsage}. */
	get liveEstimateTokens(): number {
		return Math.round(this._liveChars / 4);
	}

	/** Milliseconds since this stream began. */
	get elapsedMs(): number {
		return Date.now() - this._startedAt;
	}

	/** Live output rate: estimated tokens streamed per second since the first token. */
	get liveTokensPerSecond(): number {
		const sinceFirstChar = this._firstCharAt ? Date.now() - this._firstCharAt : 0;
		const seconds = sinceFirstChar > 0 ? sinceFirstChar / 1000 : 0;
		return seconds > 0 ? this.liveEstimateTokens / seconds : 0;
	}

	/** Exact server-reported usage, once the stream completes. */
	get exactUsage(): APIUsage | undefined {
		return this._exactUsage;
	}

	report(part: vscode.LanguageModelResponsePart2): void {
		if (part instanceof vscode.LanguageModelTextPart) {
			this._liveChars += part.value.length;
			this._firstCharAt ??= Date.now();
			this._onLiveChange();
		} else if (part instanceof vscode.LanguageModelThinkingPart) {
			const value = part.value;
			if (typeof value === 'string') {
				this._liveChars += value.length;
			} else {
				for (const chunk of value) {
					this._liveChars += chunk.length;
				}
			}
			this._firstCharAt ??= Date.now();
			this._onLiveChange();
		} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.Usage) {
			try {
				const parsed: unknown = JSON.parse(new TextDecoder().decode(part.data));
				if (isApiUsage(parsed)) {
					this._exactUsage = parsed;
				}
			} catch {
				// Malformed usage payload — ignore and keep the live estimate.
			}
		}
		this._delegate.report(part);
	}
}

/** Heuristic session id lifetime: requests within this window reuse the id. */
const HEURISTIC_SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * Persistent ledger of Nika DeepSeek token usage, aggregated per message,
 * session, workspace, and day. All requests are recorded through
 * {@link record}; live streaming state is tracked via {@link trackStream}.
 */
export class NikaUsageTracker extends Disposable {
	static readonly MAX_EVENTS = 5000;

	private static readonly EVENTS_KEY = 'nika.usage.events';
	private static readonly NEXT_ID_KEY = 'nika.usage.nextId';

	private readonly _onDidChange = this._register(new vscode.EventEmitter<void>());
	/** Fires whenever the ledger or live-stream totals change. */
	readonly onDidChange = this._onDidChange.event;

	private _events: NikaUsageEvent[] = [];
	private _nextId = 1;
	private _enabled = true;

	/** Session id resolution state for callers that didn't thread a real id. */
	private readonly _lastHeuristic: Map<string, { id: string; t: number }> = new Map();

	/** Live streams currently in flight, keyed by a local stream id. */
	private readonly _liveStreams: Map<number, TokenTrackingProgress> = new Map();
	private _nextStreamId = 1;

	constructor(@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext) {
		super();
		this._enabled = vscode.workspace.getConfiguration('nika').get<boolean>('usage.enabled', true);
		this._load();
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('nika.usage.enabled')) {
				this._enabled = vscode.workspace.getConfiguration('nika').get<boolean>('usage.enabled', true);
				this._onDidChange.fire();
			}
		}));
	}

	get enabled(): boolean {
		return this._enabled;
	}

	/** Fire a lightweight change notification (e.g. live stream progress). */
	notifyLiveChange(): void {
		this._onDidChange.fire();
	}

	/** Current live (in-flight) output token estimate summed across streams. */
	get liveTokenEstimate(): number {
		let total = 0;
		for (const stream of this._liveStreams.values()) {
			total += stream.liveEstimateTokens;
		}
		return total;
	}

	/** Aggregate live output rate across all in-flight streams (tokens/sec). */
	get liveTokensPerSecond(): number {
		let rate = 0;
		for (const stream of this._liveStreams.values()) {
			rate += stream.liveTokensPerSecond;
		}
		return rate;
	}

	get liveStreamCount(): number {
		return this._liveStreams.size;
	}

	get events(): readonly NikaUsageEvent[] {
		return this._events;
	}

	/**
	 * Register a live stream for status-bar display. Returns a dispose handle
	 * that removes the stream (call it when the request settles).
	 */
	trackStream(progress: TokenTrackingProgress): () => void {
		const id = this._nextStreamId++;
		this._liveStreams.set(id, progress);
		this._onDidChange.fire();
		return () => {
			if (this._liveStreams.delete(id)) {
				this._onDidChange.fire();
			}
		};
	}

	/**
	 * Persist a finished request. If the server reported exact usage, it wins;
	 * otherwise the caller's estimates are used verbatim.
	 */
	record(options: NikaUsageRecordOptions): void {
		if (!this._enabled) {
			return;
		}
		const t = Date.now();
		const sessionId = this._resolveSessionId(options.sessionId, options.workspace, options.initiator, t);
		const provider = options.provider ?? 'deepseek';
		const peak = provider === 'deepseek' ? isDeepSeekPeakHour(new Date(t)) : false;
		const cost = provider === 'openrouter'
			// OpenRouter has no peak/off-peak billing; the catalog price snapshot
			// applies at all hours.
			? options.pricing
				? getOpenRouterTokenCost(options.pricing, {
					cachedTokens: options.cachedTokens,
					cacheMissTokens: Math.max(0, options.promptTokens - options.cachedTokens),
					outputTokens: options.completionTokens,
				})
				: 0
			: provider === 'deepseek'
				? getDeepSeekTokenCost(options.model, {
					inputTokens: options.promptTokens,
					outputTokens: options.completionTokens,
					cachedTokens: options.cachedTokens,
				}, new Date(t))?.cost ?? 0
				: 0;

		const event: NikaUsageEvent = {
			id: this._nextId++,
			t,
			sessionId,
			title: options.title,
			workspace: options.workspace,
			model: options.model,
			promptTokens: options.promptTokens,
			completionTokens: options.completionTokens,
			totalTokens: options.totalTokens,
			cachedTokens: options.cachedTokens,
			reasoningTokens: options.reasoningTokens,
			provider,
			peak,
			cost,
			pricing: options.pricing,
			error: options.error,
		};

		this._events.push(event);
		this._prune();
		this._save();
		this._onDidChange.fire();
	}

	/** Wipe the entire usage ledger. */
	clear(): void {
		this._events = [];
		this._lastHeuristic.clear();
		this._save();
		this._onDidChange.fire();
	}

	/** Per-day aggregation, oldest first. */
	getDailySummary(days = 30): NikaDailySummary[] {
		const byDay = new Map<string, NikaDailySummary>();
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		for (const event of this._events) {
			if (event.t < cutoff) {
				continue;
			}
			const date = toUtcDateKey(event.t);
			let summary = byDay.get(date);
			if (!summary) {
				summary = { date, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
				byDay.set(date, summary);
			}
			summary.requests += 1;
			summary.promptTokens += event.promptTokens;
			summary.completionTokens += event.completionTokens;
			summary.totalTokens += event.totalTokens;
			summary.cost += event.cost;
		}
		return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
	}

	/** Per-session aggregation, most recent first. */
	getSessionSummaries(limit = 50): NikaSessionSummary[] {
		const bySession = new Map<string, NikaSessionSummary>();
		for (const event of this._events) {
			let summary = bySession.get(event.sessionId);
			if (!summary) {
				summary = {
					sessionId: event.sessionId,
					title: event.title,
					workspace: event.workspace,
					start: event.t,
					end: event.t,
					requests: 0,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cost: 0,
				};
				bySession.set(event.sessionId, summary);
			}
			summary.start = Math.min(summary.start, event.t);
			summary.end = Math.max(summary.end, event.t);
			summary.requests += 1;
			summary.promptTokens += event.promptTokens;
			summary.completionTokens += event.completionTokens;
			summary.totalTokens += event.totalTokens;
			summary.cost += event.cost;
			if (!summary.title && event.title) {
				summary.title = event.title;
			}
		}
		return [...bySession.values()].sort((a, b) => b.end - a.end).slice(0, limit);
	}

	/** Per-workspace aggregation, most active first. */
	getWorkspaceSummaries(): NikaWorkspaceSummary[] {
		const byWorkspace = new Map<string, NikaWorkspaceSummary>();
		const sessions = new Map<string, Set<string>>();
		for (const event of this._events) {
			const workspace = event.workspace ?? 'No workspace';
			let summary = byWorkspace.get(workspace);
			if (!summary) {
				summary = { workspace, sessions: 0, requests: 0, totalTokens: 0, cost: 0 };
				byWorkspace.set(workspace, summary);
				sessions.set(workspace, new Set());
			}
			sessions.get(workspace)!.add(event.sessionId);
			summary.requests += 1;
			summary.totalTokens += event.totalTokens;
			summary.cost += event.cost;
		}
		for (const [workspace, summary] of byWorkspace) {
			summary.sessions = sessions.get(workspace)!.size;
		}
		return [...byWorkspace.values()].sort((a, b) => b.totalTokens - a.totalTokens);
	}

	/** Most recent individual requests (message-level history). */
	getMessageHistory(limit = 50): NikaUsageEvent[] {
		return [...this._events].reverse().slice(0, limit);
	}

	private _resolveSessionId(sessionId: string | undefined, workspace: string | undefined, initiator: string | undefined, t: number): string {
		if (sessionId) {
			return sessionId;
		}
		// No real session id was threaded (e.g. MCP sampling, chat-editing
		// explanations). Bucket requests from the same workspace + initiator
		// within a 30-minute window under one stable heuristic id.
		const key = `${workspace ?? 'no-workspace'}|${initiator ?? 'core'}`;
		const previous = this._lastHeuristic.get(key);
		if (previous && t - previous.t < HEURISTIC_SESSION_GAP_MS) {
			previous.t = t;
			return previous.id;
		}
		const id = `heur:${key}:${new Date(t).toISOString().slice(0, 13)}`;
		this._lastHeuristic.set(key, { id, t });
		return id;
	}

	private _prune(): void {
		if (this._events.length <= NikaUsageTracker.MAX_EVENTS) {
			return;
		}
		this._events = this._events.slice(this._events.length - NikaUsageTracker.MAX_EVENTS);
	}

	private _load(): void {
		this._events = [];
		try {
			const stored = this._context.globalState.get<NikaUsageEvent[]>(NikaUsageTracker.EVENTS_KEY);
			if (Array.isArray(stored)) {
				// Legacy events predate provider tracking; they were all DeepSeek.
				this._events = stored.map(event => event.provider === undefined ? { ...event, provider: 'deepseek' as const } : event);
			}
			const nextId = this._context.globalState.get<number>(NikaUsageTracker.NEXT_ID_KEY);
			if (typeof nextId === 'number' && nextId > 0) {
				this._nextId = nextId;
			}
		} catch {
			this._events = [];
		}
	}

	private _save(): void {
		void this._context.globalState.update(NikaUsageTracker.EVENTS_KEY, this._events);
		void this._context.globalState.update(NikaUsageTracker.NEXT_ID_KEY, this._nextId);
	}
}

/** Format a timestamp as a UTC `YYYY-MM-DD` key for daily aggregation. */
export function toUtcDateKey(t: number): string {
	const d = new Date(t);
	const month = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `${d.getUTCFullYear()}-${month}-${day}`;
}
