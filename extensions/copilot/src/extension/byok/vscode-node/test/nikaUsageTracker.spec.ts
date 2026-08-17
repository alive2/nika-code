/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CustomDataPartMimeTypes } from '../../../../platform/endpoint/common/endpointTypes';
import type { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { APIUsage } from '../../../../platform/networking/common/openai';
import { NikaUsageTracker, TokenTrackingProgress } from '../nikaUsageTracker';

vi.mock('vscode', () => {
	class EventEmitter<T> {
		private readonly _listeners = new Set<(e: T) => void>();
		readonly event = (listener: (e: T) => void) => {
			this._listeners.add(listener);
			return { dispose: () => this._listeners.delete(listener) };
		};
		fire(e: T): void {
			for (const listener of this._listeners) {
				listener(e);
			}
		}
		dispose(): void {
			this._listeners.clear();
		}
	}
	class LanguageModelTextPart {
		constructor(public value: string) { }
	}
	class LanguageModelThinkingPart {
		constructor(public value: string | string[], public id?: string, public metadata?: unknown) { }
	}
	class LanguageModelDataPart {
		constructor(public data: Uint8Array, public mimeType: string) { }
	}
	const configurationChange = new EventEmitter<unknown>();
	return {
		EventEmitter,
		LanguageModelTextPart,
		LanguageModelThinkingPart,
		LanguageModelDataPart,
		workspace: {
			getConfiguration: vi.fn(() => ({ get: (_key: string, fallback: unknown) => fallback })),
			onDidChangeConfiguration: configurationChange.event,
		},
	};
});

interface FakeMemento {
	readonly get: <T>(key: string, fallback?: T) => T | undefined;
	readonly update: (key: string, value: unknown) => Promise<void>;
}

function createFakeGlobalState(): FakeMemento {
	const store = new Map<string, unknown>();
	return {
		get: <T>(key: string, fallback?: T): T | undefined => (store.has(key) ? store.get(key) as T : fallback),
		update: async (key: string, value: unknown): Promise<void> => {
			if (value === undefined) {
				store.delete(key);
			} else {
				store.set(key, value);
			}
		},
	};
}

function createContext(globalState: FakeMemento): IVSCodeExtensionContext {
	return { globalState } as unknown as IVSCodeExtensionContext;
}

describe('NikaUsageTracker', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(Date.UTC(2026, 7, 16, 2, 0, 0))); // peak hour
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createTracker(): { tracker: NikaUsageTracker; globalState: FakeMemento } {
		const globalState = createFakeGlobalState();
		return { tracker: new NikaUsageTracker(createContext(globalState)), globalState };
	}

	it('records an event with peak-aware cost', () => {
		const { tracker } = createTracker();
		tracker.record({
			model: 'deepseek-v4-flash',
			sessionId: 'session-1',
			workspace: 'my-app',
			title: 'Refactor the parser',
			promptTokens: 100_000,
			completionTokens: 50_000,
			totalTokens: 150_000,
			cachedTokens: 40_000,
			reasoningTokens: 5_000,
		});
		const events = tracker.events;
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event.sessionId).toBe('session-1');
		expect(event.workspace).toBe('my-app');
		expect(event.peak).toBe(true);
		// 0.04M*0.014 + 0.06M*0.44 + 0.05M*1.32 (peak) = 0.00056 + 0.0264 + 0.066 = 0.09296
		expect(event.cost).toBeCloseTo(0.09296, 6);
		expect(event.cachedTokens).toBe(40_000);
		expect(event.reasoningTokens).toBe(5_000);
	});

	it('records off-peak cost at half rate', () => {
		vi.setSystemTime(new Date(Date.UTC(2026, 7, 16, 23, 0, 0))); // off-peak
		const { tracker } = createTracker();
		tracker.record({ model: 'deepseek-v4-flash', promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000, cachedTokens: 0, reasoningTokens: 0, sessionId: 's' });
		const event = tracker.events[0];
		expect(event.peak).toBe(false);
		expect(event.cost).toBeCloseTo(0.022, 6); // half of 0.044 peak
	});

	it('does not record when tracking is disabled', () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
			get: (_key: string, fallback: unknown) => false,
		} as never);
		const { tracker } = createTracker();
		tracker.record({ model: 'deepseek-v4-flash', promptTokens: 10, completionTokens: 10, totalTokens: 20, cachedTokens: 0, reasoningTokens: 0 });
		expect(tracker.events).toHaveLength(0);
	});

	it('aggregates per day, session, and workspace', () => {
		const { tracker } = createTracker();
		tracker.record({ model: 'deepseek-v4-flash', sessionId: 'a', workspace: 'w1', title: 'First', promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000, cachedTokens: 0, reasoningTokens: 0 });
		tracker.record({ model: 'deepseek-v4-pro', sessionId: 'a', workspace: 'w1', title: 'First', promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000, cachedTokens: 0, reasoningTokens: 0 });
		vi.setSystemTime(new Date(Date.UTC(2026, 7, 16, 3, 0, 0)));
		tracker.record({ model: 'deepseek-v4-flash', sessionId: 'b', workspace: 'w2', title: 'Second', promptTokens: 500, completionTokens: 500, totalTokens: 1_000, cachedTokens: 0, reasoningTokens: 0 });

		const daily = tracker.getDailySummary(30);
		expect(daily).toHaveLength(1);
		expect(daily[0]).toMatchObject({ requests: 3, totalTokens: 5_000 });

		const sessions = tracker.getSessionSummaries(10);
		expect(sessions).toHaveLength(2);
		expect(sessions[0].sessionId).toBe('b'); // most recent first
		expect(sessions[1]).toMatchObject({ sessionId: 'a', requests: 2, totalTokens: 4_000, workspace: 'w1' });

		const workspaces = tracker.getWorkspaceSummaries();
		expect(workspaces).toHaveLength(2);
		expect(workspaces[0]).toMatchObject({ workspace: 'w1', sessions: 1, requests: 2, totalTokens: 4_000 });
		expect(workspaces[1]).toMatchObject({ workspace: 'w2', sessions: 1, requests: 1, totalTokens: 1_000 });
	});

	it('persists events to globalState and reloads them', () => {
		const { tracker, globalState } = createTracker();
		tracker.record({ model: 'deepseek-v4-flash', sessionId: 's1', promptTokens: 100, completionTokens: 100, totalTokens: 200, cachedTokens: 0, reasoningTokens: 0 });
		const reloaded = new NikaUsageTracker(createContext(globalState));
		expect(reloaded.events).toHaveLength(1);
		expect(reloaded.events[0].sessionId).toBe('s1');
	});

	it('prunes events beyond the cap', () => {
		const { tracker } = createTracker();
		for (let i = 0; i < NikaUsageTracker.MAX_EVENTS + 100; i++) {
			tracker.record({ model: 'deepseek-v4-flash', sessionId: `s${i}`, promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, reasoningTokens: 0 });
		}
		expect(tracker.events.length).toBe(NikaUsageTracker.MAX_EVENTS);
	});

	it('reuses a heuristic session id within the 30-minute window', () => {
		const { tracker } = createTracker();
		tracker.record({ model: 'deepseek-v4-flash', workspace: 'w1', initiator: 'vscode.chat', promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, reasoningTokens: 0 });
		const first = tracker.events[0].sessionId;
		expect(first.startsWith('heur:')).toBe(true);
		vi.setSystemTime(new Date(Date.UTC(2026, 7, 16, 2, 20, 0))); // 20 min later
		tracker.record({ model: 'deepseek-v4-flash', workspace: 'w1', initiator: 'vscode.chat', promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, reasoningTokens: 0 });
		expect(tracker.events[1].sessionId).toBe(first);
		vi.setSystemTime(new Date(Date.UTC(2026, 7, 16, 3, 0, 0))); // 40 min after start
		tracker.record({ model: 'deepseek-v4-flash', workspace: 'w1', initiator: 'vscode.chat', promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, reasoningTokens: 0 });
		expect(tracker.events[2].sessionId).not.toBe(first);
	});

	it('clears all recorded usage', () => {
		const { tracker } = createTracker();
		tracker.record({ model: 'deepseek-v4-flash', sessionId: 's1', promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, reasoningTokens: 0 });
		tracker.clear();
		expect(tracker.events).toHaveLength(0);
		expect(tracker.getDailySummary(30)).toHaveLength(0);
	});

	it('records openrouter events with a pricing snapshot and catalog cost', () => {
		const { tracker } = createTracker();
		tracker.record({
			model: 'openrouter/anthropic/claude-sonnet-4',
			sessionId: 's1',
			provider: 'openrouter',
			pricing: { promptPerMTok: 3, completionPerMTok: 15, cacheReadPerMTok: 0.3, requestFee: 0.005, free: false },
			promptTokens: 500_000,
			completionTokens: 200_000,
			totalTokens: 700_000,
			cachedTokens: 100_000,
			reasoningTokens: 0,
		});
		const event = tracker.events[0];
		expect(event.provider).toBe('openrouter');
		expect(event.peak).toBe(false); // no peak/off-peak for OpenRouter
		// 0.4M*3 + 0.1M*0.3 + 0.2M*15 + 0.005 = 4.235
		expect(event.cost).toBeCloseTo(4.235, 6);
		expect(event.pricing).toEqual(expect.objectContaining({ promptPerMTok: 3 }));
	});

	it('does not cost gemini or ollama events', () => {
		const { tracker } = createTracker();
		tracker.record({ model: 'gemini-2.5-flash', sessionId: 's1', provider: 'gemini', promptTokens: 100, completionTokens: 100, totalTokens: 200, cachedTokens: 0, reasoningTokens: 0 });
		tracker.record({ model: 'gemma4:31b', sessionId: 's2', provider: 'ollama', promptTokens: 100, completionTokens: 100, totalTokens: 200, cachedTokens: 0, reasoningTokens: 0 });
		expect(tracker.events[0].cost).toBe(0);
		expect(tracker.events[1].cost).toBe(0);
		expect(tracker.events[0].provider).toBe('gemini');
	});

	it('defaults legacy persisted events to the deepseek provider', () => {
		const { tracker, globalState } = createTracker();
		tracker.record({ model: 'deepseek-v4-flash', sessionId: 's1', promptTokens: 100, completionTokens: 100, totalTokens: 200, cachedTokens: 0, reasoningTokens: 0 });
		const reloaded = new NikaUsageTracker(createContext(globalState));
		expect(reloaded.events[0].provider).toBe('deepseek');
	});
});

describe('TokenTrackingProgress', () => {
	it('intercepts text, thinking, and usage parts while forwarding verbatim', () => {
		const forwarded: vscode.LanguageModelResponsePart2[] = [];
		const delegate: vscode.Progress<vscode.LanguageModelResponsePart2> = { report: part => forwarded.push(part) };
		const progress = new TokenTrackingProgress(delegate, () => { });

		progress.report(new vscode.LanguageModelTextPart('hello world'));
		progress.report(new vscode.LanguageModelThinkingPart(['think', 'ing']));
		// 11 + 9 = 20 chars → ~5 tokens at 4 chars/token
		expect(progress.liveEstimateTokens).toBe(5);

		const usage: APIUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
		progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(usage)), CustomDataPartMimeTypes.Usage));
		expect(progress.exactUsage).toEqual(usage);
		expect(forwarded).toHaveLength(3);
		expect(forwarded[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
		expect(forwarded[2]).toBeInstanceOf(vscode.LanguageModelDataPart);
	});

	it('ignores malformed usage payloads', () => {
		const delegate: vscode.Progress<vscode.LanguageModelResponsePart2> = { report: () => { } };
		const progress = new TokenTrackingProgress(delegate, () => { });
		progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode('not json'), CustomDataPartMimeTypes.Usage));
		expect(progress.exactUsage).toBeUndefined();
	});
});
