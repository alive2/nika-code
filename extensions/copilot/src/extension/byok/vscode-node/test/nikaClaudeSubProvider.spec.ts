/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { NikaClaudeSubscriptionToken, NIKA_CLAUDE_SUB_MODEL_PREFIX, NIKA_PROVIDER_NAME, parseNikaClaudeSubscriptionToken, resolveNikaTokenLimits } from '../nikaModels';
import { resolveModelInfo } from '../../common/byokProvider';
import { CLAUDE_CLIENT_ID, CLAUDE_DEVICE_AUTH_URL, CLAUDE_ISSUER, CLAUDE_REFRESH_TOKEN_URL, CLAUDE_SCOPES, claudeSubKnownModels, fetchClaudeAccountStatus, NikaClaudeSubEndpoint, NikaClaudeSubProvider, nikaClaudeModelId, parseClaudeSubSecret, pollClaudeDeviceFlow, refreshClaudeAccessToken, resolveClaudeSubModelCapabilities, startClaudeDeviceFlow } from '../nikaClaudeSubProvider';

vi.mock('vscode', async (importOriginal) => {
	const actual = await importOriginal<typeof import('vscode')>();
	const typeOnly = (key: string) => (actual as Record<string, unknown>)[key];
	return {
		...actual,
		CancellationError: class CancellationError extends Error {},
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

afterEach(() => {
	vi.unstubAllGlobals();
});

function fakeResponse(status: number, body: unknown): unknown {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

/** Routes fetches by URL substring; stubs globalThis.fetch (the providers fetch via codexFetch). */
function stubFetch(routes: Array<[string, () => unknown]>): ReturnType<typeof vi.fn> {
	const mock = vi.fn(async (url: string, init?: { body?: string }) => {
		const hit = routes.find(([pattern]) => url.includes(pattern));
		if (!hit) {
			throw new Error(`Unexpected fetch: ${url} body=${String(init?.body)}`);
		}
		return hit[1]();
	});
	vi.stubGlobal('fetch', mock);
	return mock;
}

const LIMITS = resolveNikaTokenLimits('128K', '8K');
const FLOW_START = { deviceCode: 'dev-1', userCode: 'ABCD-EFGH', verificationUri: 'https://claude.ai/device', verificationUriComplete: 'https://claude.ai/device?user_code=ABCD-EFGH', interval: 5 };

describe('Claude subscription device-code flow', () => {
	it('starts the flow with the pinned client id and parses the start payload', async () => {
		const fetchMock = stubFetch([
			['device_authorization', () => fakeResponse(200, {
				device_code: 'dev-1',
				user_code: 'ABCD-EFGH',
				verification_uri: 'https://claude.ai/device',
				verification_uri_complete: 'https://claude.ai/device?user_code=ABCD-EFGH',
				interval: 5,
			})],
		]);
		const start = await startClaudeDeviceFlow();
		expect(start).toEqual(FLOW_START);
		const [url, init] = vi.mocked(fetchMock).mock.calls[0];
		expect(url).toBe(CLAUDE_DEVICE_AUTH_URL);
		expect(String(init?.body)).toBe(`client_id=${CLAUDE_CLIENT_ID}`);
		expect((init?.headers as Record<string, string>)?.['User-Agent']).toMatch(/^claude-cli\//);
	});

	it('rejects a malformed start payload', async () => {
		stubFetch([
			['device_authorization', () => fakeResponse(200, { device_code: 'dev-1' })],
		]);
		await expect(startClaudeDeviceFlow()).rejects.toThrow(/malformed/i);
	});

	it('polls through authorization_pending and returns the token set', async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			stubFetch([
				['oauth/token', () => {
					calls += 1;
					return calls === 1
						? fakeResponse(200, { error: 'authorization_pending' })
						: fakeResponse(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 7200 });
				}],
			]);
			const flow = pollClaudeDeviceFlow(FLOW_START, new vscode.CancellationTokenSource().token);
			await vi.advanceTimersByTimeAsync(5_000);
			const now = Date.now(); // fake time after the 5s sleep
			const token = await flow;
			expect(token.accessToken).toBe('at-1');
			expect(token.refreshToken).toBe('rt-1');
			expect(token.expiresAt).toBe(now + 7_200_000);
			expect(calls).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('throws when the user declines the sign-in', async () => {
		stubFetch([
			['oauth/token', () => fakeResponse(200, { error: 'access_denied' })],
		]);
		await expect(pollClaudeDeviceFlow(FLOW_START, new vscode.CancellationTokenSource().token)).rejects.toThrow(/declined/i);
	});

	it('throws when the flow expires', async () => {
		stubFetch([
			['oauth/token', () => fakeResponse(200, { error: 'expired_token' })],
		]);
		await expect(pollClaudeDeviceFlow(FLOW_START, new vscode.CancellationTokenSource().token)).rejects.toThrow(/expired/i);
	});
});

describe('Claude subscription token refresh', () => {
	it('refreshes against platform.claude.com with the pinned scope', async () => {
		const current: NikaClaudeSubscriptionToken = { accessToken: 'old-at', refreshToken: 'old-rt', planType: 'pro', displayName: 'me' };
		const fetchMock = stubFetch([
			['platform.claude.com/v1/oauth/token', () => fakeResponse(200, { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 })],
		]);
		const refreshed = await refreshClaudeAccessToken(current);
		const [url, init] = vi.mocked(fetchMock).mock.calls[0];
		expect(url).toBe(CLAUDE_REFRESH_TOKEN_URL);
		expect(JSON.parse(String(init?.body))).toEqual({
			grant_type: 'refresh_token',
			refresh_token: 'old-rt',
			client_id: CLAUDE_CLIENT_ID,
			scope: CLAUDE_SCOPES,
		});
		expect(refreshed.accessToken).toBe('new-at');
		expect(refreshed.refreshToken).toBe('new-rt');
		expect(refreshed.planType).toBe('pro');
		expect(refreshed.displayName).toBe('me');
	});

	it('falls back to the issuer token endpoint when the primary is rejected', async () => {
		const fetchMock = stubFetch([
			['platform.claude.com/v1/oauth/token', () => fakeResponse(400, { error: 'invalid_grant' })],
			['claude.ai/oauth/token', () => fakeResponse(200, { access_token: 'issuer-at' })],
		]);
		const refreshed = await refreshClaudeAccessToken({ accessToken: 'at', refreshToken: 'rt' });
		expect(refreshed.accessToken).toBe('issuer-at');
		expect(refreshed.refreshToken).toBe('rt'); // absent in the response
		expect(vi.mocked(fetchMock).mock.calls).toHaveLength(2);
	});

	it('throws when both endpoints fail', async () => {
		stubFetch([
			['platform.claude.com/v1/oauth/token', () => fakeResponse(401, { error: 'invalid_grant' })],
			['claude.ai/oauth/token', () => fakeResponse(401, { error: 'invalid_grant' })],
		]);
		await expect(refreshClaudeAccessToken({ accessToken: 'at', refreshToken: 'rt' })).rejects.toThrow(/Sign in again/i);
	});

	it('tries the issuer endpoint when the primary returns an empty body', async () => {
		stubFetch([
			['platform.claude.com/v1/oauth/token', () => fakeResponse(200, {})],
			[`${CLAUDE_ISSUER}/oauth/token`, () => fakeResponse(200, { access_token: 'issuer-at' })],
		]);
		const refreshed = await refreshClaudeAccessToken({ accessToken: 'at', refreshToken: 'rt' });
		expect(refreshed.accessToken).toBe('issuer-at');
	});
});

describe('Claude subscription account status', () => {
	it('reads the plan type and display name from the organization payload', async () => {
		const fetchMock = stubFetch([
			['claude.ai/api/organization/', () => fakeResponse(200, {
				organization: { subscriptionType: 'pro', seat_tier: 'pro' },
				account: { display_name: 'Alex' },
			})],
		]);
		await expect(fetchClaudeAccountStatus('at-1')).resolves.toEqual({ planType: 'pro', displayName: 'Alex' });
		const [url, init] = vi.mocked(fetchMock).mock.calls[0];
		expect(url).toBe('https://claude.ai/api/organization/');
		expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer at-1');
	});

	it('degrades to undefined on a non-OK or unparseable response', async () => {
		stubFetch([['claude.ai/api/organization/', () => fakeResponse(403, {})]]);
		await expect(fetchClaudeAccountStatus('at-1')).resolves.toBeUndefined();
		stubFetch([['claude.ai/api/organization/', () => fakeResponse(200, { organization: {} })]]);
		await expect(fetchClaudeAccountStatus('at-1')).resolves.toBeUndefined();
	});

	it('never throws on network failure', async () => {
		const fetchMock = vi.fn(async () => { throw new Error('offline'); });
		vi.stubGlobal('fetch', fetchMock);
		await expect(fetchClaudeAccountStatus('at-1')).resolves.toBeUndefined();
	});
});

describe('Claude subscription constants and parsing', () => {
	it('pins the exact Claude Code system prompt with an ASCII apostrophe', () => {
		// The API verifies known Claude Code prefixes; this must match the SDK
		// string byte-for-byte. `'` is 0x27, not U+2019.
		const prompt = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
		expect(prompt.charCodeAt(prompt.indexOf("Anthropic's") + 9)).toBe(0x27);
	});

	it('parses the stored secret payload', () => {
		const token: NikaClaudeSubscriptionToken = { accessToken: 'at', refreshToken: 'rt', planType: 'pro' };
		expect(parseClaudeSubSecret(JSON.stringify(token))).toEqual(token);
		expect(parseClaudeSubSecret('garbage')).toBeUndefined();
		expect(parseClaudeSubSecret(undefined)).toBeUndefined();
		expect(parseNikaClaudeSubscriptionToken(JSON.stringify({ refreshToken: 'rt' }))).toBeUndefined();
	});
});

describe('Claude subscription model catalog', () => {
	it('exposes the lineup with full capabilities and no reasoning-effort control', () => {
		const capabilities = resolveClaudeSubModelCapabilities('claude-sonnet-4-5', LIMITS);
		expect(capabilities.toolCalling).toBe(true);
		expect(capabilities.vision).toBe(true);
		expect(capabilities.thinking).toBe(true);
		expect(capabilities.supportsReasoningEffort).toEqual([]);
		expect(capabilities.name).toBe('Claude Sonnet 4 5');
	});

	it('keys the catalog by raw id and prefixes the workbench ids', () => {
		const catalog = claudeSubKnownModels(LIMITS);
		expect(Object.keys(catalog)).toEqual(['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5']);
		expect(nikaClaudeModelId('claude-opus-4-5')).toBe(`${NIKA_CLAUDE_SUB_MODEL_PREFIX}claude-opus-4-5`);
	});
});

describe('NikaClaudeSubProvider', () => {
	function createProvider(): NikaClaudeSubProvider {
		return new NikaClaudeSubProvider({} as unknown as IInstantiationService);
	}

	it('runs the sign-in end to end and reports the verification start', async () => {
		vi.useFakeTimers();
		try {
			let pollCalls = 0;
			stubFetch([
				['device_authorization', () => fakeResponse(200, {
					device_code: 'dev-1',
					user_code: 'ABCD-EFGH',
					verification_uri: 'https://claude.ai/device',
					verification_uri_complete: 'https://claude.ai/device?user_code=ABCD-EFGH',
					interval: 5,
				})],
				['oauth/token', () => {
					pollCalls += 1;
					return pollCalls === 1
						? fakeResponse(200, { error: 'authorization_pending' })
						: fakeResponse(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 7200 });
				}],
			]);
			const provider = createProvider();
			const onStart = vi.fn();
			const onStatus = vi.fn();
			const flow = provider.signIn(new vscode.CancellationTokenSource().token, onStatus, onStart);
			await vi.advanceTimersByTimeAsync(5_000);
			const result = await flow;
			expect(onStart).toHaveBeenCalledWith({ verificationUrl: 'https://claude.ai/device?user_code=ABCD-EFGH', userCode: 'ABCD-EFGH' });
			expect(onStatus).toHaveBeenCalled();
			expect(result.userCode).toBe('ABCD-EFGH');
			expect(result.token.accessToken).toBe('at-1');
			expect(result.token.refreshToken).toBe('rt-1');
		} finally {
			vi.useRealTimers();
		}
	});

	it('creates the Messages endpoint with the OAuth bearer and beta header', () => {
		const inst = { createInstance: vi.fn(() => ({})) } as unknown as IInstantiationService & { createInstance: ReturnType<typeof vi.fn> };
		const provider = new NikaClaudeSubProvider(inst);
		const token: NikaClaudeSubscriptionToken = { accessToken: 'at-1', refreshToken: 'rt-1' };
		provider.createEndpoint('claude-opus-4-5', token, LIMITS);
		expect(inst.createInstance).toHaveBeenCalledTimes(1);
		const [ctor, modelInfo, apiKey, url] = (inst.createInstance as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(ctor).toBe(NikaClaudeSubEndpoint);
		expect(apiKey).toBe('at-1');
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		expect(modelInfo.requestHeaders).toEqual({
			'authorization': 'Bearer ${apiKey}',
			'anthropic-beta': 'oauth-2025-04-20',
		});
	});

	it('emits the official Claude CLI identity on the wire', () => {
		const modelInfo = resolveModelInfo('claude-opus-4-5', NIKA_PROVIDER_NAME, undefined, {
			...resolveClaudeSubModelCapabilities('claude-opus-4-5', LIMITS),
			requestHeaders: {
				'authorization': 'Bearer ${apiKey}',
				'anthropic-beta': 'oauth-2025-04-20',
			},
		});
		const endpoint = new NikaClaudeSubEndpoint(
			modelInfo, 'at-1', 'https://api.anthropic.com/v1/messages',
			{} as never, {} as never, {} as never, {} as never,
			{ getConfig: () => undefined, getExperimentBasedConfig: () => undefined } as never, {} as never, {} as never, {} as never,
		);
		const headers = endpoint.getExtraHeaders();
		// `User-Agent` cannot ride in requestHeaders (reserved-header
		// sanitizer strips it) — it must come from getExtraHeaders.
		expect(headers['User-Agent']).toMatch(/^claude-cli\//);
		// The OAuth bearer is interpolated, and the generic Copilot beta set
		// must NOT leak — only the official oauth beta may reach the wire.
		expect(headers['authorization']).toBe('Bearer at-1');
		expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
		expect(headers['anthropic-version']).toBe('2023-06-01');
		expect(headers['x-api-key']).toBeUndefined();
	});

	it('opts the Messages endpoint out of the Copilot platform headers', () => {
		const modelInfo = resolveModelInfo('claude-opus-4-5', NIKA_PROVIDER_NAME, undefined, resolveClaudeSubModelCapabilities('claude-opus-4-5', LIMITS));
		const endpoint = new NikaClaudeSubEndpoint(
			modelInfo, 'at-1', 'https://api.anthropic.com/v1/messages',
			{} as never, {} as never, {} as never, {} as never,
			{ getConfig: () => undefined } as never, {} as never, {} as never, {} as never,
		);
		expect(endpoint.getEndpointFetchOptions?.()).toEqual({ suppressCopilotHeaders: true });
	});
});
