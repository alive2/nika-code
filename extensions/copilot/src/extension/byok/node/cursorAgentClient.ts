/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { ILogService } from '../../../platform/log/common/logService';

/**
 * Cursor's current public API surface. Cursor used to offer an
 * OpenAI-compatible `POST /v1/chat/completions` endpoint; it no longer does
 * (verified live: the route returns 404). The replacement is the Cloud
 * Agents API (cursor.com/docs/cloud-agent/api/endpoints.md):
 *
 * - `GET /v1/models` returns the catalog under `{ items: [...] }` (no
 *   OpenAI `data` array), where each entry declares `id`, `displayName`,
 *   optional `parameters` (e.g. `effort`, `reasoning`, `context`,
 *   `thinking`, `fast`) and precomputed `variants`.
 * - `POST /v1/agents` creates a conversation agent and enqueues its initial
 *   run (`prompt` + optional `model`). Omitting `repos`/`env` starts a
 *   no-repo (conversational) agent.
 * - `POST /v1/agents/{id}/runs` sends a follow-up prompt to an existing
 *   agent; the run keeps the agent's conversation memory.
 * - `GET /v1/agents/{id}/runs/{runId}/stream` replays/streams the run as
 *   SSE (`assistant`, `thinking`, `tool_call`, `result`, `error`, `done`).
 * - `DELETE /v1/agents/{id}` permanently deletes an agent.
 *
 * Only one run may be active per agent (`409 agent_busy`), so this client
 * serializes runs per agent and reuses one agent per (chat session, model,
 * reasoning level) — the same session-key discipline as the DeepSeek web
 * provider, so a Nika chat conversation maps onto one Cursor conversation.
 */
export const CURSOR_API_BASE_URL = 'https://api.cursor.com';

/** One permitted value of a Cursor model parameter (catalog `parameters[].values[]`). */
export interface CursorParameterValue {
	readonly value: string;
	readonly displayName?: string;
}

/** A model parameter declared by the Cursor catalog, e.g. `effort` or `context`. */
export interface CursorWireParameter {
	readonly id: string;
	readonly displayName?: string;
	readonly values: readonly CursorParameterValue[];
}

/** An image to attach to a run prompt (`prompt.images[]`). */
export interface CursorPromptImage {
	readonly mimeType: string;
	/** Base64-encoded bytes. */
	readonly data: string;
}

/** Options for one chat turn executed against a Cursor conversation agent. */
export interface CursorAgentTurnOptions {
	readonly apiKey: string;
	/** Raw Cursor model id (as listed by `/v1/models`), e.g. `claude-opus-5`. */
	readonly modelId: string;
	/**
	 * The catalog's precomputed variants for the model. The Cloud Agents API
	 * only accepts a model together with the exact params of one known
	 * variant, so the agent is always created with a catalog variant.
	 */
	readonly variants: readonly CursorModelVariant[];
	/**
	 * Canonical Nika reasoning level (`none`…`max`), or undefined to run the
	 * model's default variant. The level is matched against the catalog's
	 * variants before it is put on the wire.
	 */
	readonly reasoningEffort: string | undefined;
	/**
	 * Chat session key (the Nika chat conversation id). Undefined means the
	 * turn is ephemeral: a throwaway agent is created, used once, and
	 * deleted so no orphaned conversation agents pile up on the account.
	 */
	readonly sessionKey: string | undefined;
	/** The user prompt text (the current turn only — the agent keeps memory). */
	readonly prompt: string;
	/** Images for the prompt (base64 data URIs); optional, max 5. */
	readonly images: readonly CursorPromptImage[];
	/** Called with each assistant text delta as the run streams. */
	readonly onAssistantDelta: (delta: string) => void;
	readonly token: CancellationToken;
}

/** Outcome of a completed run. */
export interface CursorAgentTurnResult {
	readonly text: string;
	readonly agentId: string;
	readonly runId: string;
}

/**
 * Parameter ids that carry a reasoning-effort magnitude on the Cursor wire.
 * Claude models use `effort`, GPT-5.x and Kimi/GLM use `reasoning`, and some
 * Gemini releases use `reasoning_effort`; the catalog declares which one a
 * model accepts. `thinking` is the separate binary Claude switch.
 */
const EFFORT_PARAM_IDS = new Set(['effort', 'reasoning', 'reasoning_effort']);
const THINKING_PARAM_ID = 'thinking';

/** Canonical Nika level order; Cursor-only aliases collapse onto these. */
const CANONICAL_LEVELS = ['none', 'low', 'medium', 'high', 'max'] as const;
type CanonicalLevel = (typeof CANONICAL_LEVELS)[number];

/** Cursor-only effort aliases mapped onto Nika levels. */
const LEVEL_ALIASES: Readonly<Record<string, string>> = {
	'xhigh': 'max',
	'extra-high': 'max',
	'x-high': 'max',
};

/** True for raw ids of the frontier multimodal families the catalog serves. */
export function isCursorVisionModelId(id: string): boolean {
	return /^(claude|gpt|gemini|grok|composer)/i.test(id);
}

function canonicalLevel(value: string): string | undefined {
	const lower = value.toLowerCase();
	const direct = CANONICAL_LEVELS.find(level => level === lower);
	if (direct) {
		return direct;
	}
	return LEVEL_ALIASES[lower];
}

function parseContextValue(value: string): number | undefined {
	const trimmed = value.trim().toLowerCase();
	const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(trimmed);
	if (!match) {
		return undefined;
	}
	const number = Number(match[1]);
	if (!Number.isFinite(number) || number <= 0) {
		return undefined;
	}
	return match[2] === 'm' ? number * 1_000_000 : match[2] === 'k' ? number * 1_000 : Math.round(number);
}

/**
 * The largest `context` window a model advertises (e.g. `200k`, `1m`), or
 * undefined when the catalog entry does not publish one.
 */
export function cursorContextWindowFromParameters(parameters: readonly CursorWireParameter[]): number | undefined {
	let max: number | undefined;
	for (const parameter of parameters) {
		if (parameter.id !== 'context') {
			continue;
		}
		for (const { value } of parameter.values) {
			const parsed = parseContextValue(value);
			if (parsed !== undefined && (max === undefined || parsed > max)) {
				max = parsed;
			}
		}
	}
	return max;
}

/**
 * The canonical reasoning levels a model supports, derived from its catalog
 * parameters (`effort` / `reasoning` / `reasoning_effort` values, plus the
 * binary `thinking` switch — a `thinking: false` option implies `none` is
 * achievable). Levels are returned in Nika canonical order, so the picker
 * shows a stable list across providers.
 */
export function cursorReasoningLevels(parameters: readonly CursorWireParameter[]): string[] | undefined {
	const levels = new Set<string>();
	let hasThinkingToggle = false;
	for (const parameter of parameters) {
		if (EFFORT_PARAM_IDS.has(parameter.id)) {
			for (const { value } of parameter.values) {
				const canonical = canonicalLevel(value);
				if (canonical) {
					levels.add(canonical);
				}
			}
		} else if (parameter.id === THINKING_PARAM_ID) {
			hasThinkingToggle = parameter.values.some(({ value }) => value.toLowerCase() === 'false');
		}
	}
	if (levels.size === 0 && !hasThinkingToggle) {
		return undefined;
	}
	const ordered = CANONICAL_LEVELS.filter(level => levels.has(level));
	if (ordered.length === 0 && hasThinkingToggle) {
		// Binary thinking switch with no effort knob: off/on map to none/high.
		return ['none', 'high'];
	}
	// A binary thinking toggle adds `none` to an effort magnitude list.
	if (hasThinkingToggle && !ordered.includes('none')) {
		return ['none', ...ordered];
	}
	return ordered;
}

/**
 * One precomputed configuration of a Cursor model as listed by the catalog
 * (`variants[]`). The Cloud Agents API only accepts `model.id` together with
 * the exact `params` of a known variant (`Model '…' does not match a known
 * variant`), so every agent creation reuses one catalog variant verbatim.
 */
export interface CursorModelVariant {
	/** Exact `{ id, value }` parameter set; must be sent as-is. */
	readonly params: readonly { id: string; value: string }[];
	/** The catalog flags one variant as the model's default configuration. */
	readonly isDefault?: boolean;
}

function variantEffortLevel(variant: CursorModelVariant): string | undefined {
	for (const param of variant.params) {
		if (EFFORT_PARAM_IDS.has(param.id)) {
			return canonicalLevel(param.value);
		}
	}
	return undefined;
}

/**
 * Picks the variant whose params go on the wire for one agent run. Without
 * an explicit level the model's default variant is used. A requested level
 * prefers the variant that matches it at the default context window, falling
 * back to any matching variant; `none` on a Claude-style model resolves to a
 * `thinking: false` variant. Levels the catalog cannot honor (no such
 * variant) silently fall back to the default configuration — the UI only
 * offers levels the schema advertises, but variants enumerate a subset.
 */
export function selectCursorVariantParams(variants: readonly CursorModelVariant[], reasoningEffort: string | undefined): { id: string; value: string }[] | undefined {
	if (variants.length === 0) {
		return undefined;
	}
	const def = variants.find(variant => variant.isDefault) ?? variants[0];
	if (!reasoningEffort) {
		return def.params;
	}
	const requested = canonicalLevel(reasoningEffort) ?? reasoningEffort.toLowerCase();
	const defContext = def.params.find(param => param.id === 'context')?.value;
	const matches = (variant: CursorModelVariant, level: string): boolean => {
		const variantLevel = variantEffortLevel(variant);
		if (variantLevel === level) {
			return true;
		}
		// `none` on a Claude-style model resolves to a `thinking: false`
		// variant (the catalog pairs it with an effort level anyway).
		return level === 'none' && variant.params.some(param => param.id === THINKING_PARAM_ID && param.value.toLowerCase() === 'false');
	};
	let sameContext: CursorModelVariant | undefined;
	let anyMatch: CursorModelVariant | undefined;
	for (const variant of variants) {
		if (!matches(variant, requested)) {
			continue;
		}
		if (defContext !== undefined && variant.params.find(param => param.id === 'context')?.value === defContext) {
			if (!sameContext) {
				sameContext = variant;
			}
		} else if (!anyMatch) {
			anyMatch = variant;
		}
	}
	return (sameContext ?? anyMatch ?? def).params;
}

/** Marker error thrown when the user cancels a run. */
export class CursorRunCanceledError extends Error {
	constructor() {
		super('Canceled');
		this.name = 'CursorRunCanceledError';
	}
}

interface AgentEntry {
	agentId: string | undefined;
	lastUsedAt: number;
	chain: Promise<unknown>;
}

/** Idle time after which a conversation agent mapping is dropped. */
const AGENT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

/** True while a run may still be terminalizing; polling cadence for fallback. */
const RUN_POLL_INTERVAL_MS = 750;

function headers(apiKey: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
		'content-type': 'application/json',
	};
}

function readErrorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { message?: unknown; error?: { message?: unknown } | string };
		if (typeof parsed.message === 'string' && parsed.message) {
			return parsed.message;
		}
		if (typeof parsed.error === 'string' && parsed.error) {
			return parsed.error;
		}
		if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
			return parsed.error.message;
		}
	} catch {
		// Non-JSON body — fall through to the generic status message.
	}
	return '';
}

/**
 * Owns Cursor conversation agents for the Nika provider: one agent per
 * (session key, model, reasoning level), runs serialized per agent (Cursor
 * allows a single active run), and streaming of assistant deltas.
 */
export class CursorAgentRegistry {
	private readonly _entries = new Map<string, AgentEntry>();

	constructor(
		private readonly _fetcherService: IFetcherService,
		private readonly _logService: ILogService,
	) { }

	/** Drop all agent mappings (e.g. after the API key changed). */
	invalidate(): void {
		this._entries.clear();
	}

	/** Runs one chat turn, streaming assistant deltas; resolves with the reply. */
	async runTurn(options: CursorAgentTurnOptions): Promise<CursorAgentTurnResult> {
		const key = options.sessionKey
			? `${options.sessionKey}::${options.modelId}::${options.reasoningEffort ?? 'default'}`
			: undefined;
		if (!key) {
			// No stable chat session: one throwaway agent per turn, deleted
			// afterwards so idle agents do not accumulate on the account.
			const entry: AgentEntry = { agentId: undefined, lastUsedAt: Date.now(), chain: Promise.resolve() };
			try {
				return await this._runOne(entry, options);
			} finally {
				if (entry.agentId) {
					void this._deleteAgent(entry.agentId, options.apiKey);
				}
			}
		}
		const now = Date.now();
		let entry = this._entries.get(key);
		if (!entry) {
			// Sweep idle mappings so the registry cannot grow unbounded.
			for (const [k, candidate] of this._entries) {
				if (now - candidate.lastUsedAt > AGENT_IDLE_TTL_MS) {
					this._entries.delete(k);
				}
			}
			entry = { agentId: undefined, lastUsedAt: now, chain: Promise.resolve() };
			this._entries.set(key, entry);
		} else {
			entry.lastUsedAt = now;
		}
		const turn = entry.chain.then(() => this._runOne(entry as AgentEntry, options));
		// The chain swallows failures so one failed turn does not wedge the
		// agent for every later request; the caller still sees the rejection.
		entry.chain = turn.then(() => undefined, () => undefined);
		return turn;
	}

	private async _runOne(entry: AgentEntry, options: CursorAgentTurnOptions): Promise<CursorAgentTurnResult> {
		const modelParams = selectCursorVariantParams(options.variants, options.reasoningEffort);
		const prompt: Record<string, unknown> = { text: options.prompt };
		if (options.images.length > 0) {
			prompt.images = options.images.map(image => ({ mimeType: image.mimeType, data: image.data }));
		}
		let agentId = entry.agentId;
		let runId: string;
		if (agentId) {
			const body = { prompt };
			const response = await this._postJson(`${CURSOR_API_BASE_URL}/v1/agents/${agentId}/runs`, body, options.apiKey, options.token);
			const json = await response.json() as { run?: { id?: unknown; status?: unknown } };
			runId = typeof json.run?.id === 'string' ? json.run.id : '';
			if (!runId) {
				throw new Error('Cursor API returned an invalid run response.');
			}
		} else {
			// First turn of the conversation: create the agent (which enqueues
			// its initial run) with the exact catalog variant params. No
			// repo/env means a conversational agent. A model with no declared
			// variants (agent-style ids) goes bare — Cursor accepts those.
			const model = options.modelId === 'default'
				? undefined
				: { id: options.modelId, ...(modelParams && modelParams.length > 0 ? { params: modelParams } : {}) };
			const body = {
				prompt,
				name: 'Nika chat',
				...(model ? { model } : {}),
			};
			const response = await this._postJson(`${CURSOR_API_BASE_URL}/v1/agents`, body, options.apiKey, options.token);
			const json = await response.json() as { agent?: { id?: unknown }; run?: { id?: unknown; status?: unknown } };
			agentId = typeof json.agent?.id === 'string' ? json.agent.id : '';
			runId = typeof json.run?.id === 'string' ? json.run.id : '';
			if (!agentId || !runId) {
				throw new Error('Cursor API returned an invalid agent response.');
			}
			entry.agentId = agentId;
		}
		return this._streamRun(entry.agentId, runId, options);
	}

	private async _streamRun(agentId: string, runId: string, options: CursorAgentTurnOptions): Promise<CursorAgentTurnResult> {
		const url = `${CURSOR_API_BASE_URL}/v1/agents/${agentId}/runs/${runId}/stream`;
		let response;
		try {
			response = await this._fetcherService.fetch(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'text/event-stream' },
				callSite: 'nika-cursor-run-stream',
			});
		} catch (error) {
			// A transport failure while opening the stream: fall back to
			// polling the run's terminal state below.
			this._logService.warn(`[Nika] Cursor run stream failed to open, polling run instead: ${error instanceof Error ? error.message : String(error)}`);
			return this._pollRun(agentId, runId, options);
		}
		if (response.status === 401) {
			throw new Error('Invalid Cursor API key.');
		}
		if (response.status === 404 || response.status === 410) {
			this._logService.warn(`[Nika] Cursor run stream unavailable (HTTP ${response.status}), polling run instead`);
			return this._pollRun(agentId, runId, options);
		}
		if (response.status === 429) {
			throw new Error('Cursor API rate limit exceeded.');
		}
		if (!response.ok) {
			const detail = readErrorMessage(await response.text());
			throw new Error(detail || `Cursor run stream failed with HTTP ${response.status}.`);
		}
		return this._consumeSse(agentId, runId, response, options);
	}

	private async _consumeSse(agentId: string, runId: string, response: { body: AsyncIterable<Uint8Array> & { destroy?: () => unknown } }, options: CursorAgentTurnOptions): Promise<CursorAgentTurnResult> {
		let text = '';
		let sawTerminalEvent = false;
		let terminalText = '';
		const onCancel = (): void => {
			void this._cancelRun(agentId, runId, options.apiKey);
			response.body.destroy?.();
		};
		options.token.onCancellationRequested(onCancel);
		try {
			const decoder = new TextDecoder('utf-8');
			let buffer = '';
			let event: string | undefined;
			let dataLine: string | undefined;
			const flush = (): void => {
				if (!event || dataLine === undefined) {
					event = undefined;
					dataLine = undefined;
					return;
				}
				const eventName = event;
				const payload = dataLine;
				event = undefined;
				dataLine = undefined;
				this._handleSseEvent(eventName, payload, {
					onAssistantDelta: (delta) => {
						text += delta;
						options.onAssistantDelta(delta);
					},
					onResult: (resultText) => {
						sawTerminalEvent = true;
						terminalText = resultText;
					},
					onError: (message) => { throw new Error(message); },
				});
			};
			for await (const chunk of response.body) {
				if (options.token.isCancellationRequested) {
					throw new CursorRunCanceledError();
				}
				buffer += decoder.decode(chunk, { stream: true });
				let newlineIndex: number;
				while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
					buffer = buffer.slice(newlineIndex + 1);
					if (!line) {
						flush();
						continue;
					}
					if (line.startsWith('event: ')) {
						event = line.slice('event: '.length).trim();
					} else if (line.startsWith('data: ')) {
						dataLine = line.slice('data: '.length).trim();
					}
					// `id:` and `:` comment lines carry no payload.
				}
			}
			flush();
			if (options.token.isCancellationRequested) {
				throw new CursorRunCanceledError();
			}
			if (!sawTerminalEvent) {
				// No terminal event captured (truncated stream): fall back to
				// the run's terminal state, which carries the full reply.
				const polled = await this._pollRun(agentId, runId, options);
				terminalText = polled.text;
			}
			// The terminal result holds the full reply; when the stream was
			// truncated, deliver any tail that was never streamed so the
			// caller's cumulative text matches the returned value.
			if (terminalText && terminalText.length > text.length) {
				const tail = terminalText.slice(text.length);
				text += tail;
				options.onAssistantDelta(tail);
			}
			return { text: terminalText || text, agentId, runId };
		} finally {
			options.token.onCancellationRequested(undefined);
		}
	}

	private _handleSseEvent(event: string, payload: string, handlers: { onAssistantDelta: (delta: string) => void; onResult: (resultText: string) => void; onError: (message: string) => void }): void {
		if (!payload) {
			return;
		}
		let data: unknown;
		try {
			data = JSON.parse(payload);
		} catch {
			return;
		}
		if (!data || typeof data !== 'object') {
			return;
		}
		const record = data as Record<string, unknown>;
		if (event === 'result') {
			if (typeof record.text === 'string') {
				handlers.onResult(record.text);
			}
			return;
		}
		if (event === 'error') {
			handlers.onError(typeof record.message === 'string' ? record.message : String(record.code ?? 'Cursor run failed.'));
			return;
		}
		// Only assistant deltas carry streamed reply text; `status`,
		// `thinking`, `tool_call`, and `interaction_update` events are
		// transient bookkeeping and never become user-visible text.
		if (event === 'assistant' && typeof record.text === 'string') {
			handlers.onAssistantDelta(record.text);
		}
	}

	private async _pollRun(agentId: string, runId: string, options: CursorAgentTurnOptions): Promise<{ text: string }> {
		const url = `${CURSOR_API_BASE_URL}/v1/agents/${agentId}/runs/${runId}`;
		for (;;) {
			if (options.token.isCancellationRequested) {
				throw new CursorRunCanceledError();
			}
			const response = await this._postJson(url, undefined, options.apiKey, options.token);
			const json = await response.json() as { status?: unknown; result?: unknown; error?: unknown };
			const status = String(json.status ?? '');
			if (status === 'FINISHED') {
				const result = typeof json.result === 'string' ? json.result : '';
				if (!result) {
					throw new Error('Cursor run finished without a result.');
				}
				return { text: result };
			}
			if (status === 'ERROR' || status === 'CANCELLED' || status === 'EXPIRED') {
				const detail = readErrorMessage(JSON.stringify(json));
				throw new Error(detail || `Cursor run ${status.toLowerCase()}.`);
			}
			await new Promise(resolve => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
		}
	}

	private async _cancelRun(agentId: string, runId: string, apiKey: string): Promise<void> {
		try {
			await this._fetcherService.fetch(`${CURSOR_API_BASE_URL}/v1/agents/${agentId}/runs/${runId}/cancel`, {
				method: 'POST',
				headers: headers(apiKey),
				callSite: 'nika-cursor-run-cancel',
			});
		} catch (error) {
			this._logService.warn(`[Nika] Failed to cancel Cursor run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _deleteAgent(agentId: string, apiKey: string): Promise<void> {
		try {
			await this._fetcherService.fetch(`${CURSOR_API_BASE_URL}/v1/agents/${agentId}`, {
				method: 'DELETE',
				headers: headers(apiKey),
				callSite: 'nika-cursor-agent-delete',
			});
		} catch (error) {
			this._logService.warn(`[Nika] Failed to delete ephemeral Cursor agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _postJson(url: string, body: unknown, apiKey: string, token: CancellationToken): Promise<import('../../../platform/networking/common/fetcherService').Response> {
		if (token.isCancellationRequested) {
			throw new CursorRunCanceledError();
		}
		const response = await this._fetcherService.fetch(url, {
			method: 'POST',
			headers: headers(apiKey),
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			callSite: 'nika-cursor-run',
		});
		if (token.isCancellationRequested) {
			throw new CursorRunCanceledError();
		}
		if (response.status === 401) {
			throw new Error('Invalid Cursor API key.');
		}
		if (response.status === 429) {
			throw new Error('Cursor API rate limit exceeded.');
		}
		if (response.status === 409) {
			const detail = readErrorMessage(await response.text());
			throw new Error(detail || 'The Cursor conversation agent is busy with another run. Try again in a moment.');
		}
		if (!response.ok) {
			const detail = readErrorMessage(await response.text());
			throw new Error(detail || `Cursor API request failed with HTTP ${response.status}.`);
		}
		return response;
	}
}
