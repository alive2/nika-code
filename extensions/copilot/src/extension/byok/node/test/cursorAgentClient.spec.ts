/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { ChatCompletionContentPartKind } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFetchResponseType } from '../../../../platform/chat/common/commonTypes';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../../platform/endpoint/common/endpointProvider';
import { FinishedCallback } from '../../../../platform/networking/common/fetch';
import { IMakeChatRequestOptions } from '../../../../platform/networking/common/networking';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { CursorAgentRegistry, CursorModelVariant, CursorWireParameter, cursorContextWindowFromParameters, cursorReasoningLevels, selectCursorVariantParams } from '../cursorAgentClient';
import { CursorAgentEndpoint } from '../cursorAgentEndpoint';

function metadata(id = 'cursor/claude-opus-5'): IChatModelInformation {
	return {
		id,
		name: id,
		vendor: 'Nika',
		version: '1.0',
		model_picker_enabled: true,
		is_chat_default: false,
		is_chat_fallback: false,
		supported_endpoints: [ModelSupportedEndpoint.ChatCompletions],
		capabilities: {
			type: 'chat', family: id, tokenizer: 'o200k_base' as any,
			supports: { streaming: true, tool_calls: false, vision: true, thinking: true, reasoning_effort: ['low', 'medium', 'high', 'max'] },
			limits: { max_prompt_tokens: 900_000, max_output_tokens: 8_192, max_context_window_tokens: 1_000_000 },
		},
	};
}

/** Realistic catalog parameter schema for a Claude-style model. */
function claudeParameters(): CursorWireParameter[] {
	return [
		{ id: 'thinking', values: [{ value: 'true' }, { value: 'false' }] },
		{ id: 'effort', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }] },
		{ id: 'context', values: [{ value: '200k' }, { value: '1m' }] },
	];
}

const OPUS_HIGH_1M = [
	{ id: 'thinking', value: 'true' },
	{ id: 'context', value: '1m' },
	{ id: 'effort', value: 'high' },
	{ id: 'fast', value: 'false' },
];
const OPUS_LOW_1M = [
	{ id: 'thinking', value: 'true' },
	{ id: 'context', value: '1m' },
	{ id: 'effort', value: 'low' },
	{ id: 'fast', value: 'false' },
];
const OPUS_HIGH_300K = [
	{ id: 'thinking', value: 'true' },
	{ id: 'context', value: '300k' },
	{ id: 'effort', value: 'high' },
	{ id: 'fast', value: 'false' },
];
const OPUS_XHIGH_1M = [
	{ id: 'thinking', value: 'true' },
	{ id: 'context', value: '1m' },
	{ id: 'effort', value: 'xhigh' },
	{ id: 'fast', value: 'false' },
];
const OPUS_NONE_1M = [
	{ id: 'thinking', value: 'false' },
	{ id: 'context', value: '1m' },
	{ id: 'effort', value: 'low' },
	{ id: 'fast', value: 'false' },
];

/** Catalog variants for a Claude Opus 5-like model (subset of the real 32). */
function opusVariants(): CursorModelVariant[] {
	return [
		{ params: OPUS_HIGH_1M, isDefault: true },
		{ params: OPUS_LOW_1M },
		{ params: OPUS_HIGH_300K },
		{ params: OPUS_XHIGH_1M },
		{ params: OPUS_NONE_1M },
	];
}

/** The current user turn from {@link requestOptions}, text only. */
function userTurn(overrides: Partial<IMakeChatRequestOptions> = {}): IMakeChatRequestOptions {
	return {
		debugName: 'nika-test',
		messages: [
			{ role: Raw.ChatRole.System, content: [{ type: ChatCompletionContentPartKind.Text, text: 'You are Nika.' }] },
			{ role: Raw.ChatRole.User, content: [{ type: ChatCompletionContentPartKind.Text, text: 'hello' }] },
			{ role: Raw.ChatRole.Assistant, content: [{ type: ChatCompletionContentPartKind.Text, text: 'previous reply' }] },
			{ role: Raw.ChatRole.User, content: [{ type: ChatCompletionContentPartKind.Text, text: 'hello' }] },
		],
		finishedCb: undefined,
		location: undefined as any,
		modelCapabilities: { reasoningEffort: 'high' },
		...overrides,
	};
}

function sseResponse(status: number, events: string[]): unknown {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => ({}),
		text: async () => '',
		body: (() => {
			const bytes = new TextEncoder().encode(events.join('\n') + '\n');
			return {
				async *[Symbol.asyncIterator]() {
					let index = 0;
					while (index < bytes.length) {
						const value = bytes.slice(index, index + 64);
						index += value.length;
						yield value;
					}
				},
				destroy: async () => { },
			};
		})(),
	};
}

/** SSE events for a run that says "hello there". */
function helloStreamEvents(): string[] {
	return [
		'event: status',
		'data: {"status":"STREAMING"}',
		'',
		'event: assistant',
		'data: {"text":"hello"}',
		'',
		'event: assistant',
		'data: {"text":" there"}',
		'',
		'event: result',
		'data: {"runId":"run-1","status":"FINISHED","text":"hello there","durationMs":1234}',
		'',
		'event: done',
		'data: {}',
	];
}

/**
 * SSE response that emits one assistant delta and then stalls until
 * {@link destroy} is called — simulates a mid-stream cancellation.
 */
function hangingSseResponse(): unknown {
	let release: () => void = () => { };
	return {
		ok: true,
		status: 200,
		json: async () => ({}),
		text: async () => '',
		body: (() => {
			const first = new TextEncoder().encode('event: assistant\ndata: {"text":"partial"}\n\n');
			return {
				async *[Symbol.asyncIterator]() {
					yield first;
					await new Promise<void>(resolve => { release = resolve; });
				},
				destroy: async () => { release(); },
			};
		})(),
	};
}

function jsonResponse(status: number, body: unknown): unknown {
	const ok = status >= 200 && status < 300;
	return {
		ok,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
		body: (() => {
			const bytes = new TextEncoder().encode('{}');
			return {
				async *[Symbol.asyncIterator]() {
					yield bytes;
				},
				destroy: async () => { },
			};
		})(),
	};
}

/** Fetcher stub routing by URL substring (tail matches beat substring ones). */
function fakeFetcher(routes: Array<[string, () => unknown]>): IFetcherService {
	return {
		fetch: vi.fn(async (url: string) => {
			const hits = routes.filter(([pattern]) => url.includes(pattern));
			if (hits.length === 0) {
				throw new Error(`Unexpected fetch: ${url}`);
			}
			// Every agent URL also contains `/v1/agents`, so a plain substring
			// match is ambiguous. A pattern matching the URL tail (the stream
			// URL ends `/stream`, follow-up runs end `/runs`) is unambiguous;
			// among equal matches the longest pattern wins.
			hits.sort((a, b) => {
				const aTail = url.endsWith(a[0]) ? 1 : 0;
				const bTail = url.endsWith(b[0]) ? 1 : 0;
				if (aTail !== bTail) {
					return bTail - aTail;
				}
				return b[0].length - a[0].length;
			});
			return hits[0][1]();
		}),
	} as unknown as IFetcherService;
}

function createRegistry(routes: Array<[string, () => unknown]>): { registry: CursorAgentRegistry; fetchMock: ReturnType<typeof vi.fn> } {
	const fetcher = fakeFetcher(routes);
	const fetchMock = fetcher.fetch as ReturnType<typeof vi.fn>;
	// The registry only needs a warn-capable log service.
	const logService = { warn: vi.fn(), error: vi.fn() } as never;
	return { registry: new CursorAgentRegistry(fetcher, logService), fetchMock };
}

describe('cursorAgentClient helpers', () => {
	it('derives the context window from the largest context parameter value', () => {
		expect(cursorContextWindowFromParameters(claudeParameters())).toBe(1_000_000);
		expect(cursorContextWindowFromParameters([])).toBeUndefined();
		expect(cursorContextWindowFromParameters([{ id: 'effort', values: [{ value: 'high' }] }])).toBeUndefined();
	});

	it('derives canonical reasoning levels from effort and thinking parameters', () => {
		expect(cursorReasoningLevels(claudeParameters())).toEqual(['none', 'low', 'medium', 'high', 'max']);
		expect(cursorReasoningLevels([{ id: 'reasoning', values: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] }])).toEqual(['low', 'high', 'max']);
		expect(cursorReasoningLevels([{ id: 'thinking', values: [{ value: 'true' }, { value: 'false' }] }])).toEqual(['none', 'high']);
		expect(cursorReasoningLevels([{ id: 'fast', values: [{ value: 'true' }] }])).toBeUndefined();
	});

	it('picks the default variant params when no level is chosen', () => {
		expect(selectCursorVariantParams(opusVariants(), undefined)).toEqual(OPUS_HIGH_1M);
		expect(selectCursorVariantParams([], undefined)).toBeUndefined();
	});

	it('matches a requested level at the default context window', () => {
		expect(selectCursorVariantParams(opusVariants(), 'high')).toEqual(OPUS_HIGH_1M);
		expect(selectCursorVariantParams(opusVariants(), 'low')).toEqual(OPUS_LOW_1M);
		expect(selectCursorVariantParams(opusVariants(), 'medium')).toEqual(OPUS_HIGH_1M); // no medium variant: default
		expect(selectCursorVariantParams(opusVariants(), 'none')).toEqual(OPUS_NONE_1M);
	});

	it('maps max onto the xhigh alias variant', () => {
		expect(selectCursorVariantParams(opusVariants(), 'max')).toEqual(OPUS_XHIGH_1M);
	});

	it('falls back to a matching variant at another context window', () => {
		// A catalog whose only `low` variant uses 300k (not the default 1m).
		const noLow1M = opusVariants().filter(variant => !variant.params.some(param => param.id === 'effort' && param.value === 'low'));
		expect(selectCursorVariantParams([...noLow1M, { params: [{ id: 'effort', value: 'low' }, { id: 'context', value: '300k' }, { id: 'thinking', value: 'true' }, { id: 'fast', value: 'false' }] }], 'low')).toEqual([
			{ id: 'effort', value: 'low' }, { id: 'context', value: '300k' }, { id: 'thinking', value: 'true' }, { id: 'fast', value: 'false' },
		]);
	});

	it('resolves GPT-style reasoning values (none/extra-high) onto variants', () => {
		const gptLike: CursorModelVariant[] = [
			{ params: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'none' }, { id: 'fast', value: 'false' }] },
			{ params: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'medium' }, { id: 'fast', value: 'false' }], isDefault: true },
			{ params: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'extra-high' }, { id: 'fast', value: 'false' }] },
		];
		expect(selectCursorVariantParams(gptLike, 'none')).toEqual([{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'none' }, { id: 'fast', value: 'false' }]);
		expect(selectCursorVariantParams(gptLike, 'max')).toEqual([{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'extra-high' }, { id: 'fast', value: 'false' }]);
		expect(selectCursorVariantParams(gptLike, 'high')).toEqual([{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'medium' }, { id: 'fast', value: 'false' }]); // no high variant: default
	});
});

describe('CursorAgentRegistry', () => {
	it('creates an agent on the first turn and streams the run to text', async () => {
		const { registry, fetchMock } = createRegistry([
			['/v1/agents', () => jsonResponse(201, {
				agent: { id: 'bc-1', status: 'IDLE' },
				run: { id: 'run-1', status: 'CREATING' },
			})],
			['/stream', () => sseResponse(200, helloStreamEvents())],
		]);

		let text = '';
		const result = await registry.runTurn({
			apiKey: 'key', modelId: 'claude-opus-5', variants: opusVariants(),
			reasoningEffort: 'high', sessionKey: 'conv-1', prompt: 'hello',
			images: [], onAssistantDelta: (delta) => { text += delta; }, token: CancellationToken.None,
		});

		expect(text).toBe('hello there');
		expect(result).toEqual({ text: 'hello there', agentId: 'bc-1', runId: 'run-1' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// Agent creation carries the model id and the full params of the
		// matching variant (high at the default 1m context — the default).
		const createBody = JSON.parse(fetchMock.mock.calls[0][1].body) as { model: { id: string; params: { id: string; value: string }[] } };
		expect(createBody.model).toEqual({ id: 'claude-opus-5', params: OPUS_HIGH_1M });
		expect(createBody.prompt).toEqual({ text: 'hello' });
	});

	it('reuses the agent for follow-up turns via runs', async () => {
		const calls: string[] = [];
		const { registry } = createRegistry([
			// Most-specific patterns first: every agent URL also contains the
			// bare `/v1/agents` substring.
			['/stream', () => sseResponse(200, helloStreamEvents())],
			['/v1/agents/bc-1/runs', () => {
				calls.push('run');
				return jsonResponse(201, { run: { id: 'run-2' } });
			}],
			['/v1/agents', () => {
				calls.push('create');
				return jsonResponse(201, { agent: { id: 'bc-1' }, run: { id: 'run-1' } });
			}],
		]);

		const options = (prompt: string) => ({
			apiKey: 'key', modelId: 'claude-opus-5', variants: opusVariants(),
			reasoningEffort: undefined, sessionKey: 'conv-1', prompt,
			images: [], onAssistantDelta: () => { }, token: CancellationToken.None,
		});
		await registry.runTurn(options('first'));
		await registry.runTurn(options('second'));

		expect(calls).toEqual(['create', 'run']);
		expect((await registry.runTurn(options('third'))).text).toBe('hello there');
	});

	it('sends only the current turn (agent keeps server-side memory)', async () => {
		const { registry, fetchMock } = createRegistry([
			['/v1/agents', () => jsonResponse(201, { agent: { id: 'bc-1' }, run: { id: 'run-1' } })],
			['/stream', () => sseResponse(200, helloStreamEvents())],
		]);

		await registry.runTurn({
			apiKey: 'key', modelId: 'claude-opus-5', variants: opusVariants(),
			reasoningEffort: undefined, sessionKey: 'conv-1', prompt: 'current turn only',
			images: [], onAssistantDelta: () => { }, token: CancellationToken.None,
		});
		const createBody = JSON.parse(fetchMock.mock.calls[0][1].body) as { prompt: { text: string } };
		expect(createBody.prompt.text).toBe('current turn only');
	});

	it('attaches images when the prompt carries them', async () => {
		const { registry, fetchMock } = createRegistry([
			['/v1/agents', () => jsonResponse(201, { agent: { id: 'bc-1' }, run: { id: 'run-1' } })],
			['/stream', () => sseResponse(200, helloStreamEvents())],
		]);

		await registry.runTurn({
			apiKey: 'key', modelId: 'claude-opus-5', variants: opusVariants(),
			reasoningEffort: undefined, sessionKey: 'conv-1', prompt: 'look',
			images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }], onAssistantDelta: () => { }, token: CancellationToken.None,
		});
		const createBody = JSON.parse(fetchMock.mock.calls[0][1].body) as { prompt: { text: string; images: unknown[] } };
		expect(createBody.prompt).toEqual({ text: 'look', images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }] });
	});

	it('deletes the throwaway agent after an ephemeral (session-less) turn', async () => {
		const deletes: string[] = [];
		const { registry, fetchMock } = createRegistry([]);
		fetchMock.mockImplementation(async (url: string, init: { method?: string }) => {
			if (url.includes('/v1/agents/bc-tmp') && init?.method === 'DELETE') {
				deletes.push(url);
				return jsonResponse(200, { success: true });
			}
			if (url.includes('/stream')) {
				return sseResponse(200, helloStreamEvents());
			}
			return jsonResponse(201, { agent: { id: 'bc-tmp' }, run: { id: 'run-1' } });
		});

		await registry.runTurn({
			apiKey: 'key', modelId: 'claude-opus-5', variants: opusVariants(),
			reasoningEffort: undefined, sessionKey: undefined, prompt: 'ephemeral',
			images: [], onAssistantDelta: () => { }, token: CancellationToken.None,
		});

		expect(deletes).toEqual(['https://api.cursor.com/v1/agents/bc-tmp']);
	});

	it('polls the run result when the stream ends without a terminal event', async () => {
		const { registry } = createRegistry([
			// Stream carries a truncated assistant prefix — no result/done;
			// the terminal state holds the full reply.
			['/stream', () => sseResponse(200, ['event: assistant', 'data: {"text":"complete rep"}', ''])],
			['/v1/agents/bc-1/runs/run-1', () => jsonResponse(200, { status: 'FINISHED', result: 'complete reply' })],
			['/v1/agents', () => jsonResponse(201, { agent: { id: 'bc-1' }, run: { id: 'run-1' } })],
		]);

		const result = await registry.runTurn({
			apiKey: 'key', modelId: 'claude-opus-5', variants: opusVariants(),
			reasoningEffort: undefined, sessionKey: 'conv-1', prompt: 'hello',
			images: [], onAssistantDelta: () => { }, token: CancellationToken.None,
		});
		expect(result.text).toBe('complete reply');
	});

	it('surfaces the API error message from an errored run', async () => {
		const { registry } = createRegistry([
			['/v1/agents', () => jsonResponse(201, { agent: { id: 'bc-1' }, run: { id: 'run-1' } })],
			['/stream', () => sseResponse(200, ['event: error', 'data: {"code":"agent_limit_reached","message":"You have reached the limit of active agents."}', ''])],
		]);

		await expect(registry.runTurn({
			apiKey: 'key', modelId: 'claude-opus-5', variants: opusVariants(),
			reasoningEffort: undefined, sessionKey: 'conv-1', prompt: 'hello',
			images: [], onAssistantDelta: () => { }, token: CancellationToken.None,
		})).rejects.toThrow('You have reached the limit of active agents.');
	});

	it('rejects invalid API keys with a clear message', async () => {
		const { registry } = createRegistry([
			['/v1/agents', () => jsonResponse(401, { code: 'error', message: 'Invalid User API Key' })],
		]);

		await expect(registry.runTurn({
			apiKey: 'bad', modelId: 'claude-opus-5', variants: opusVariants(),
			reasoningEffort: undefined, sessionKey: 'conv-1', prompt: 'hello',
			images: [], onAssistantDelta: () => { }, token: CancellationToken.None,
		})).rejects.toThrow('Invalid Cursor API key.');
	});
});

describe('CursorAgentEndpoint', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;

	beforeEach(async () => {
		accessor = disposables.add(createExtensionUnitTestingServices().createTestingAccessor());
		instantiationService = accessor.get(IInstantiationService);
	});

	afterEach(() => disposables.clear());

	function createEndpoint(registry: CursorAgentRegistry, variants: CursorModelVariant[] = [], sessionKey: string | undefined = 'conv-1'): CursorAgentEndpoint {
		return instantiationService.createInstance(CursorAgentEndpoint, metadata(), 'key', sessionKey, variants, registry);
	}

	function liveRegistry(): CursorAgentRegistry {
		return createRegistry([
			['/v1/agents', () => jsonResponse(201, { agent: { id: 'bc-1' }, run: { id: 'run-1' } })],
			['/stream', () => sseResponse(200, helloStreamEvents())],
		]).registry;
	}

	it('streams a Success response and reports incremental finished deltas', async () => {
		const endpoint = createEndpoint(liveRegistry(), opusVariants());
		const finishedCb = vi.fn<FinishedCallback>(async () => undefined);
		const response = await endpoint.makeChatRequest2(userTurn({ finishedCb }), CancellationToken.None);

		expect(response.type).toBe(ChatFetchResponseType.Success);
		if (response.type === ChatFetchResponseType.Success) {
			expect(response.value).toBe('hello there');
		}
		// Deltas are cumulative text with per-delta chunks.
		expect(finishedCb).toHaveBeenCalledTimes(2);
		expect(finishedCb.mock.calls[0][0]).toBe('hello');
		expect(finishedCb.mock.calls[1][0]).toBe('hello there');
	});

	it('sends only the last user turn to the agent', async () => {
		const { registry, fetchMock } = createRegistry([
			['/v1/agents', () => jsonResponse(201, { agent: { id: 'bc-1' }, run: { id: 'run-1' } })],
			['/stream', () => sseResponse(200, helloStreamEvents())],
		]);
		const endpoint = createEndpoint(registry, opusVariants());

		await endpoint.makeChatRequest2(userTurn(), CancellationToken.None);

		const createBody = JSON.parse(fetchMock.mock.calls[0][1].body) as { prompt: { text: string } };
		expect(createBody.prompt.text).toBe('hello');
	});

	it('extracts base64 image parts from the last user message', async () => {
		const { registry, fetchMock } = createRegistry([
			['/v1/agents', () => jsonResponse(201, { agent: { id: 'bc-1' }, run: { id: 'run-1' } })],
			['/stream', () => sseResponse(200, helloStreamEvents())],
		]);
		const endpoint = createEndpoint(registry, opusVariants());
		const options = userTurn();
		options.messages = [
			{ role: Raw.ChatRole.User, content: [
				{ type: ChatCompletionContentPartKind.Image, imageUrl: { url: 'data:image/png;base64,iVBORw0KGgo==' } },
				{ type: ChatCompletionContentPartKind.Text, text: 'describe' },
			] },
		];

		await endpoint.makeChatRequest2(options, CancellationToken.None);

		const createBody = JSON.parse(fetchMock.mock.calls[0][1].body) as { prompt: { text: string; images: { mimeType: string; data: string }[] } };
		expect(createBody.prompt).toEqual({ text: 'describe', images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo==' }] });
	});

	it('returns Canceled when cancellation is requested mid-run', async () => {
		const { registry } = createRegistry([
			['/v1/agents', () => jsonResponse(201, { agent: { id: 'bc-1' }, run: { id: 'run-1' } })],
			// The stream emits one delta then hangs until destroyed, which is
			// what the cancellation path triggers.
			['/stream', () => hangingSseResponse()],
		]);
		const endpoint = createEndpoint(registry, opusVariants());
		const source = new CancellationTokenSource();
		const pending = endpoint.makeChatRequest2(userTurn(), source.token);
		// Yield so the agent is created and the stream starts, then cancel.
		await new Promise(resolve => setTimeout(resolve, 10));
		source.cancel();

		const response = await pending;
		expect(response.type).toBe(ChatFetchResponseType.Canceled);
		source.dispose();
	});

	it('returns Failed with the error reason', async () => {
		const { registry } = createRegistry([
			['/v1/agents', () => jsonResponse(401, { code: 'error', message: 'Invalid User API Key' })],
		]);
		const endpoint = createEndpoint(registry, opusVariants());
		const response = await endpoint.makeChatRequest2(userTurn(), CancellationToken.None);

		expect(response.type).toBe(ChatFetchResponseType.Failed);
		if (response.type === ChatFetchResponseType.Failed) {
			expect(response.reason).toBe('Invalid Cursor API key.');
		}
	});

	it('fails cleanly when no user message is present', async () => {
		const endpoint = createEndpoint(liveRegistry(), opusVariants());
		const options = userTurn();
		options.messages = [
			{ role: Raw.ChatRole.System, content: [{ type: ChatCompletionContentPartKind.Text, text: 'You are Nika.' }] },
		];
		const response = await endpoint.makeChatRequest2(options, CancellationToken.None);

		expect(response.type).toBe(ChatFetchResponseType.Failed);
		if (response.type === ChatFetchResponseType.Failed) {
			expect(response.reason).toContain('no user message');
		}
	});
});
