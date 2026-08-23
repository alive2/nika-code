/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { NikaDeepSeekWebProvider } from '../nikaDeepSeekWebProvider';

vi.mock('vscode', async (importOriginal) => {
	const actual = await importOriginal<typeof import('vscode')>();
	// These are type-only exports in the test shim, so the spread below cannot
	// copy them — but `vscodeTypes.ts` re-exports them at module load, which
	// would throw on the mock's proxy. Define them explicitly.
	const typeOnly = (key: string) => (actual as Record<string, unknown>)[key];
	return {
		...actual,
		ChatHookType: typeOnly('ChatHookType'),
		ChatRequest: typeOnly('ChatRequest'),
		LanguageModelToolInformation: typeOnly('LanguageModelToolInformation'),
		Extension: typeOnly('Extension'),
		ChatMcpToolInvocationData: typeOnly('ChatMcpToolInvocationData'),
		workspace: {
			...actual.workspace,
			getConfiguration: vi.fn(() => ({ get: (_key: string, fallback: unknown) => fallback })),
		},
	};
});

function fakeResponse(status: number, body: unknown, sseText = ''): unknown {
	const ok = status >= 200 && status < 300;
	return {
		ok,
		status,
		json: async () => body,
		body: (() => {
			const bytes = new TextEncoder().encode(sseText);
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

/** Captured real PoW challenge (solvable by the WASM solver). */
const FAKE_CHALLENGE = {
	data: {
		biz_data: {
			challenge: {
				algorithm: 'DeepSeekHashV1',
				challenge: 'b0000b22959bad0cc1ecbbfa07f97191b20332fa10d7341ff9c7ba6e7ed927f1',
				salt: 'dde3ed472be5a2494ee0',
				difficulty: 144000,
				expire_at: 1_777_057_596_443,
				signature: 'test',
				target_path: '/api/v0/chat/completion',
			},
		},
	},
};

const CAT_SSE = [
	'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"A tabby cat."}]}}}\n',
	'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n',
].join('');

interface DeleteRouteState {
	calls: number;
}

/** Fetcher stub routing by URL substring, tracking delete calls. */
function makeFetcher(deleteHandler?: () => unknown): { fetcher: IFetcherService; deleteCalls: () => number } {
	const state: DeleteRouteState = { calls: 0 };
	const routes: Array<[string, (init: RequestInit) => unknown]> = [
		['/chat/create_pow_challenge', () => fakeResponse(200, FAKE_CHALLENGE)],
		['hif-leim', () => fakeResponse(200, { data: { biz_data: { value: 'leim-value' } } })],
		['/file/upload_file', () => fakeResponse(200, { data: { biz_data: { id: 'file-1' } } })],
		['/file/fetch_files', () => fakeResponse(200, { data: { biz_data: { files: [{ status: 'SUCCESS' }] } } })],
		['/chat_session/create', () => fakeResponse(200, { data: { biz_data: { id: 'session-1' } } })],
		['/chat/completion', () => fakeResponse(200, {}, CAT_SSE)],
	];
	if (deleteHandler) {
		routes.push(['/chat_session/delete', (init) => { state.calls += 1; return deleteHandler(); }]);
	}
	const fetcher = {
		fetch: vi.fn(async (url: string, init: RequestInit) => {
			const hit = routes.find(([pattern]) => url.includes(pattern));
			if (!hit) {
				throw new Error(`Unexpected fetch: ${url}`);
			}
			return hit[1](init);
		}),
	} as unknown as IFetcherService;
	return { fetcher, deleteCalls: () => state.calls };
}

function createProvider(fetcher: IFetcherService): NikaDeepSeekWebProvider {
	return new NikaDeepSeekWebProvider(fetcher, {} as unknown as IInstantiationService);
}

/** Restores the default (delete-on) configuration after an override. */
function resetConfig(): void {
	vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
		get: (_key: string, fallback: unknown) => fallback,
	} as never);
}

describe('NikaDeepSeekWebProvider.describeImage', () => {
	it('deletes the web chat session after a successful description by default', async () => {
		const { fetcher, deleteCalls } = makeFetcher(() => fakeResponse(200, { code: 0, data: { biz_code: 0, biz_data: null } }));
		const provider = createProvider(fetcher);
		const text = await provider.describeImage(new Uint8Array([1, 2, 3]), 'image/png', 'Describe this image precisely.', 'token');
		expect(text).toBe('A tabby cat.');
		expect(deleteCalls()).toBe(1);
	});

	it('keeps the session when the delete-after-vision setting is off', async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: (key: string, fallback: unknown) => key === 'deepseekWeb.deleteSessionsAfterVision' ? false : fallback,
		} as never);
		const { fetcher, deleteCalls } = makeFetcher(() => fakeResponse(200, { code: 0, data: { biz_code: 0 } }));
		const provider = createProvider(fetcher);
		const text = await provider.describeImage(new Uint8Array([1]), 'image/png', 'Describe.', 'token');
		expect(text).toBe('A tabby cat.');
		expect(deleteCalls()).toBe(0);
		resetConfig();
	});

	it('does not delete when the description stream fails', async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: (key: string, fallback: unknown) => key === 'deepseekWeb.deleteSessionsAfterVision' ? true : fallback,
		} as never);
		// No `/chat/completion` content: the stream ends with FINISHED but no
		// text, which `describeImage` treats as a failure.
		const routes: Array<[string, (init: RequestInit) => unknown]> = [
			['/chat/create_pow_challenge', () => fakeResponse(200, FAKE_CHALLENGE)],
			['hif-leim', () => fakeResponse(200, { data: { biz_data: { value: 'leim-value' } } })],
			['/file/upload_file', () => fakeResponse(200, { data: { biz_data: { id: 'file-1' } } })],
			['/file/fetch_files', () => fakeResponse(200, { data: { biz_data: { files: [{ status: 'SUCCESS' }] } } })],
			['/chat_session/create', () => fakeResponse(200, { data: { biz_data: { id: 'session-1' } } })],
			['/chat/completion', () => fakeResponse(200, {}, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n')],
			['/chat_session/delete', () => { throw new Error('should not be called'); }],
		];
		const fetcher = {
			fetch: vi.fn(async (url: string, init: RequestInit) => {
				const hit = routes.find(([pattern]) => url.includes(pattern));
				if (!hit) {
					throw new Error(`Unexpected fetch: ${url}`);
				}
				return hit[1](init);
			}),
		} as unknown as IFetcherService;
		const provider = createProvider(fetcher);
		await expect(provider.describeImage(new Uint8Array([1]), 'image/png', 'Describe.', 'token')).rejects.toThrow('no description');
		resetConfig();
	});
});
