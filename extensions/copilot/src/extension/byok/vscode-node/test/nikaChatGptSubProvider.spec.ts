/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Raw } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { NikaChatGptSubscriptionToken, NIKA_CHATGPT_MODEL_PREFIX, NIKA_PROVIDER_NAME, parseNikaChatGptSubscriptionToken, resolveNikaTokenLimits } from '../nikaModels';
import { resolveModelInfo } from '../../common/byokProvider';
import { CHATGPT_CLIENT_ID, CHATGPT_DEVICE_AUTH_URL, CHATGPT_OAUTH_TOKEN_URL, CHATGPT_REVOKE_URL, chatGptSubKnownModels, clearChatGptSubCatalogCache, exchangeChatGptDeviceCode, fetchChatGptSubModels, mergeChatGptSubModels, NikaChatGptSubEndpoint, NikaChatGptSubProvider, nikaChatGptModelId, parseChatGptIdTokenClaims, parseChatGptSubSecret, parseChatGptTokenExpiry, pollChatGptDeviceFlow, refreshChatGptAccessToken, resolveChatGptSubModelCapabilities, revokeChatGptToken, startChatGptDeviceFlow } from '../nikaChatGptSubProvider';

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

/** Builds a realistic id_token with the codex claims in the payload. */
function idTokenWithClaims(accountId: string, planType: string): string {
	const payload = Buffer.from(JSON.stringify({
		'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: planType },
		exp: 1_800_000_000,
	})).toString('base64url');
	return `header.${payload}.signature`;
}

/** A token JWT whose payload carries an `exp` claim. */
function accessTokenWithExpiry(expSeconds: number): string {
	const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
	return `header.${payload}.signature`;
}

const LIMITS = resolveNikaTokenLimits('128K', '8K');

describe('ChatGPT subscription device-code flow', () => {
	it('starts the flow with the pinned client id and parses the start payload', async () => {
		const fetchMock = stubFetch([
			['usercode', () => fakeResponse(200, { user_code: 'ABCD-EFGH', device_auth_id: 'dev-1', interval: 3 })],
		]);
		const start = await startChatGptDeviceFlow();
		expect(start).toEqual({ userCode: 'ABCD-EFGH', deviceAuthId: 'dev-1', interval: 3 });
		const [url, init] = vi.mocked(fetchMock).mock.calls[0];
		expect(url).toBe(CHATGPT_DEVICE_AUTH_URL);
		expect(JSON.parse(String(init?.body))).toEqual({ client_id: CHATGPT_CLIENT_ID });
		expect((init as { headers?: Record<string, string> }).headers?.['User-Agent']).toMatch(/^codex_cli_rs\//);
	});

	it('floors a degenerate interval at the minimum poll cadence', async () => {
		stubFetch([
			['usercode', () => fakeResponse(200, { user_code: 'ABCD-EFGH', device_auth_id: 'dev-1', interval: 0 })],
		]);
		const start = await startChatGptDeviceFlow();
		expect(start.interval).toBe(5);
	});

	it('rejects a malformed start payload', async () => {
		stubFetch([
			['usercode', () => fakeResponse(200, { user_code: 'ABCD-EFGH' })],
		]);
		await expect(startChatGptDeviceFlow()).rejects.toThrow(/malformed/i);
	});

	it('polls through authorization_pending and returns the approved exchange material', async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			stubFetch([
				['deviceauth/token', () => {
					calls += 1;
					return calls === 1
						? fakeResponse(200, { error: 'authorization_pending' })
						: fakeResponse(200, { authorization_code: 'auth-1', code_verifier: 'verifier-1' });
				}],
			]);
			const flow = pollChatGptDeviceFlow({ userCode: 'ABCD-EFGH', deviceAuthId: 'dev-1', interval: 2 }, new vscode.CancellationTokenSource().token);
			await vi.advanceTimersByTimeAsync(5_000);
			await expect(flow).resolves.toEqual({ authorizationCode: 'auth-1', codeVerifier: 'verifier-1' });
			expect(calls).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('polls through the object-form pending error (HTTP 403) the server actually sends', async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			stubFetch([
				['deviceauth/token', () => {
					calls += 1;
					return calls === 1
						? fakeResponse(403, { error: { message: 'Device authorization is pending. Please try again.', type: 'invalid_request_error', param: null, code: 'deviceauth_authorization_pending' } })
						: fakeResponse(200, { authorization_code: 'auth-1', code_verifier: 'verifier-1' });
				}],
			]);
			const flow = pollChatGptDeviceFlow({ userCode: 'ABCD-EFGH', deviceAuthId: 'dev-1', interval: 2 }, new vscode.CancellationTokenSource().token);
			await vi.advanceTimersByTimeAsync(5_000);
			await expect(flow).resolves.toEqual({ authorizationCode: 'auth-1', codeVerifier: 'verifier-1' });
			expect(calls).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('extends the poll interval on the object-form slow_down code', async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = stubFetch([
				['deviceauth/token', () => fakeResponse(403, { error: { code: 'deviceauth_slow_down' } })],
			]);
			const source = new vscode.CancellationTokenSource();
			const flow = pollChatGptDeviceFlow({ userCode: 'ABCD-EFGH', deviceAuthId: 'dev-1', interval: 2 }, source.token);
			await vi.advanceTimersByTimeAsync(10_000);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);
			source.cancel();
			await expect(flow).rejects.toBeInstanceOf(vscode.CancellationError);
			expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('throws when the object-form access_denied code is returned', async () => {
		stubFetch([
			['deviceauth/token', () => fakeResponse(403, { error: { code: 'deviceauth_access_denied' } })],
		]);
		await expect(pollChatGptDeviceFlow({ userCode: 'ABCD-EFGH', deviceAuthId: 'dev-1', interval: 2 }, new vscode.CancellationTokenSource().token)).rejects.toThrow(/declined/i);
	});

	it('extends the poll interval on slow_down', async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = stubFetch([
				['deviceauth/token', () => fakeResponse(200, { error: 'slow_down' })],
			]);
			const source = new vscode.CancellationTokenSource();
			const flow = pollChatGptDeviceFlow({ userCode: 'ABCD-EFGH', deviceAuthId: 'dev-1', interval: 2 }, source.token);
			// First sleep lasts the 5s floor, then the server asks to slow down
			// and the interval grows to 10s — so the first sleep is 10s and
			// poll 2 runs when it fires. Flush the post-timer microtasks so
			// poll 2 actually issues before we settle the flow.
			await vi.advanceTimersByTimeAsync(10_000);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);
			source.cancel();
			await expect(flow).rejects.toBeInstanceOf(vscode.CancellationError);
			expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('throws when the user declines the sign-in', async () => {
		stubFetch([
			['deviceauth/token', () => fakeResponse(200, { error: 'access_denied' })],
		]);
		await expect(pollChatGptDeviceFlow({ userCode: 'ABCD-EFGH', deviceAuthId: 'dev-1', interval: 2 }, new vscode.CancellationTokenSource().token)).rejects.toThrow(/declined/i);
	});

	it('throws when the flow expires', async () => {
		stubFetch([
			['deviceauth/token', () => fakeResponse(200, { error: 'expired_token' })],
		]);
		await expect(pollChatGptDeviceFlow({ userCode: 'ABCD-EFGH', deviceAuthId: 'dev-1', interval: 2 }, new vscode.CancellationTokenSource().token)).rejects.toThrow(/expired/i);
	});

	it('aborts polling when the cancellation token fires', async () => {
		vi.useFakeTimers();
		try {
			stubFetch([
				['deviceauth/token', () => fakeResponse(200, { error: 'authorization_pending' })],
			]);
			const source = new vscode.CancellationTokenSource();
			const flow = pollChatGptDeviceFlow({ userCode: 'ABCD-EFGH', deviceAuthId: 'dev-1', interval: 2 }, source.token);
			source.cancel();
			await expect(flow).rejects.toBeInstanceOf(vscode.CancellationError);
		} finally {
			vi.useRealTimers();
		}
	});

	it('exchanges the code as a PKCE authorization_code grant', async () => {
		const fetchMock = stubFetch([
			['oauth/token', () => fakeResponse(200, {
				access_token: accessTokenWithExpiry(1_800_000_000),
				refresh_token: 'rt-1',
				id_token: idTokenWithClaims('acc-123', 'chatgpt_plus'),
			})],
		]);
		const token = await exchangeChatGptDeviceCode('auth-1', 'verifier-1');
		const [url, init] = vi.mocked(fetchMock).mock.calls[0];
		expect(url).toBe(CHATGPT_OAUTH_TOKEN_URL);
		const form = new URLSearchParams(String(init?.body));
		expect(form.get('grant_type')).toBe('authorization_code');
		expect(form.get('code')).toBe('auth-1');
		expect(form.get('code_verifier')).toBe('verifier-1');
		expect(form.get('client_id')).toBe(CHATGPT_CLIENT_ID);
		expect(token).toMatchObject({
			accessToken: accessTokenWithExpiry(1_800_000_000),
			refreshToken: 'rt-1',
			accountId: 'acc-123',
			planType: 'chatgpt_plus',
		});
		expect(token.expiresAt).toBe(1_800_000_000_000);
	});

	it('rejects a malformed exchange payload', async () => {
		stubFetch([
			['oauth/token', () => fakeResponse(200, { access_token: 'at-1' })],
		]);
		await expect(exchangeChatGptDeviceCode('auth-1', 'verifier-1')).rejects.toThrow(/malformed/i);
	});

	it('refreshes with the JSON grant and keeps absent fields', async () => {
		const current: NikaChatGptSubscriptionToken = {
			accessToken: 'old-at',
			refreshToken: 'old-rt',
			accountId: 'acc-1',
			planType: 'chatgpt_plus',
			expiresAt: 123,
		};
		const fetchMock = stubFetch([
			['oauth/token', () => fakeResponse(200, { access_token: 'new-at' })],
		]);
		const refreshed = await refreshChatGptAccessToken(current);
		const [url, init] = vi.mocked(fetchMock).mock.calls[0];
		expect(url).toBe(CHATGPT_OAUTH_TOKEN_URL);
		expect(JSON.parse(String(init?.body))).toEqual({
			client_id: CHATGPT_CLIENT_ID,
			grant_type: 'refresh_token',
			refresh_token: 'old-rt',
		});
		expect(refreshed.accessToken).toBe('new-at');
		expect(refreshed.refreshToken).toBe('old-rt');
		expect(refreshed.accountId).toBe('acc-1');
		expect(refreshed.planType).toBe('chatgpt_plus');
		expect(refreshed.expiresAt).toBe(123); // no exp claim on the new token
	});

	it('throws when the refresh endpoint fails', async () => {
		stubFetch([
			['oauth/token', () => fakeResponse(401, { error: 'invalid_grant' })],
		]);
		await expect(refreshChatGptAccessToken({ accessToken: 'at', refreshToken: 'rt' })).rejects.toThrow(/HTTP 401/i);
	});

	it('revokes best-effort without throwing on network failure', async () => {
		const fetchMock = vi.fn(async () => { throw new Error('offline'); });
		vi.stubGlobal('fetch', fetchMock);
		await expect(revokeChatGptToken({ accessToken: 'at', refreshToken: 'rt' })).resolves.toBeUndefined();
		const [url, init] = vi.mocked(fetchMock).mock.calls[0];
		expect(url).toBe(CHATGPT_REVOKE_URL);
		expect(JSON.parse(String(init?.body))).toEqual({
			client_id: CHATGPT_CLIENT_ID,
			token: 'rt',
			token_type_hint: 'refresh_token',
		});
	});
});

describe('ChatGPT subscription token parsing', () => {
	it('reads the codex account claims from the id_token', () => {
		expect(parseChatGptIdTokenClaims(idTokenWithClaims('acc-9', 'chatgpt_team'))).toEqual({ accountId: 'acc-9', planType: 'chatgpt_team' });
		expect(parseChatGptIdTokenClaims('not-a-jwt')).toEqual({});
		expect(parseChatGptIdTokenClaims('a.b.c')).toEqual({});
	});

	it('reads the exp claim as epoch millis', () => {
		expect(parseChatGptTokenExpiry(accessTokenWithExpiry(1_700_000_000))).toBe(1_700_000_000_000);
		expect(parseChatGptTokenExpiry('no-payload')).toBeUndefined();
	});

	it('parses the stored secret payload', () => {
		const token: NikaChatGptSubscriptionToken = { accessToken: 'at', refreshToken: 'rt', planType: 'chatgpt_plus' };
		expect(parseChatGptSubSecret(JSON.stringify(token))).toEqual(token);
		expect(parseChatGptSubSecret('garbage')).toBeUndefined();
		expect(parseChatGptSubSecret(undefined)).toBeUndefined();
		expect(parseNikaChatGptSubscriptionToken(JSON.stringify({ accessToken: 'at' }))).toBeUndefined();
	});
});

describe('ChatGPT subscription model catalog', () => {
	it('exposes the codex family with full capabilities and zero data retention', () => {
		const capabilities = resolveChatGptSubModelCapabilities('gpt-5-codex', LIMITS);
		expect(capabilities.toolCalling).toBe(true);
		expect(capabilities.vision).toBe(true);
		expect(capabilities.thinking).toBe(true);
		expect(capabilities.supportsReasoningEffort).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
		expect(capabilities.defaultReasoningEffort).toBe('medium');
		expect(capabilities.zeroDataRetentionEnabled).toBe(true);
		expect(capabilities.name).toBe('GPT-5 Codex');
	});

	it('prettifies the raw ids', () => {
		expect(resolveChatGptSubModelCapabilities('gpt-5-codex-mini', LIMITS).name).toBe('GPT-5 Codex Mini');
		expect(resolveChatGptSubModelCapabilities('gpt-5.1-codex', LIMITS).name).toBe('GPT-5.1 Codex');
		expect(resolveChatGptSubModelCapabilities('gpt-5.1-codex-max', LIMITS).name).toBe('GPT-5.1 Codex Max');
		expect(resolveChatGptSubModelCapabilities('gpt-5.6-sol', LIMITS).name).toBe('GPT-5.6 Sol');
		expect(resolveChatGptSubModelCapabilities('gpt-5.6-terra', LIMITS).name).toBe('GPT-5.6 Terra');
		expect(resolveChatGptSubModelCapabilities('gpt-5.6-luna', LIMITS).name).toBe('GPT-5.6 Luna');
		expect(resolveChatGptSubModelCapabilities('gpt-5.5', LIMITS).name).toBe('GPT-5.5');
		expect(resolveChatGptSubModelCapabilities('gpt-5.2', LIMITS).name).toBe('GPT-5.2');
	});

	it('keys the catalog by raw id and prefixes the workbench ids', () => {
		const catalog = chatGptSubKnownModels(LIMITS);
		expect(Object.keys(catalog)).toEqual([
			'gpt-5.6-sol',
			'gpt-5.6-terra',
			'gpt-5.6-luna',
			'gpt-5.5',
			'gpt-5.2',
			'gpt-5.1-codex-max',
			'gpt-5.1-codex',
			'gpt-5.1-codex-mini',
			'gpt-5-codex',
			'gpt-5-codex-mini',
		]);
		expect(nikaChatGptModelId('gpt-5-codex')).toBe(`${NIKA_CHATGPT_MODEL_PREFIX}gpt-5-codex`);
	});

	it('fetches the live catalog with the codex client_version and subscription headers', async () => {
		const fetchMock = stubFetch([
			['/models?client_version=', () => fakeResponse(200, {
				models: [
					{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 1 },
					{ slug: 'gpt-daybreak-red-latest', visibility: 'hide', priority: 3 },
					{ slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 7 },
				],
			})],
		]);
		const token = { accessToken: 'at-1', refreshToken: 'rt-1', accountId: 'acc-123', planType: 'chatgpt_plus' };
		const live = await fetchChatGptSubModels(token);
		expect(live?.map(m => m.slug)).toEqual(['gpt-5.6-sol', 'gpt-daybreak-red-latest', 'gpt-5.5']);
		const [url, init] = vi.mocked(fetchMock).mock.calls[0];
		expect(url).toContain('/models?client_version=');
		expect(url).toContain('chatgpt.com/backend-api/codex/models');
		expect((init as { headers?: Record<string, string> }).headers).toMatchObject({
			'Authorization': 'Bearer at-1',
			'ChatGPT-Account-ID': 'acc-123',
			'OAI-Product-Sku': 'codex',
			'originator': 'codex_cli_rs',
		});
		expect((init as { headers?: Record<string, string> }).headers?.['User-Agent']).toMatch(/^codex_cli_rs\//);
	});

	it('returns undefined when the live catalog fetch fails', async () => {
		stubFetch([
			['/models?client_version=', () => fakeResponse(500, {})],
		]);
		const token = { accessToken: 'at-1', refreshToken: 'rt-1', accountId: 'acc-123', planType: 'chatgpt_plus' };
		await expect(fetchChatGptSubModels(token)).resolves.toBeUndefined();
	});

	it('merges live models over the static catalog, hiding hide-flagged and keeping legacy ids', () => {
		const merged = mergeChatGptSubModels(LIMITS, [
			{ slug: 'gpt-5.6-sol', visibility: 'list', priority: 1 },
			{ slug: 'gpt-5.7', visibility: 'list', priority: 0 },
			{ slug: 'gpt-daybreak-red-latest', visibility: 'hide' },
		]);
		expect(Object.keys(merged)).toEqual([
			'gpt-5.6-sol',
			'gpt-5.7',
			'gpt-5.6-terra',
			'gpt-5.6-luna',
			'gpt-5.5',
			'gpt-5.2',
			'gpt-5.1-codex-max',
			'gpt-5.1-codex',
			'gpt-5.1-codex-mini',
			'gpt-5-codex',
			'gpt-5-codex-mini',
		]);
		expect(merged['gpt-5.7'].name).toBe('GPT-5.7');
	});

	it('merging without a live list yields exactly the static catalog', () => {
		expect(mergeChatGptSubModels(LIMITS, undefined)).toEqual(chatGptSubKnownModels(LIMITS));
	});

	it('provider getLiveKnownModels uses the live catalog and caches per account', async () => {
		clearChatGptSubCatalogCache();
		const fetchMock = stubFetch([
			['/models?client_version=', () => fakeResponse(200, { models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }] })],
		]);
		const provider = new NikaChatGptSubProvider({} as unknown as IInstantiationService);
		const token = { accessToken: 'at-1', refreshToken: 'rt-1', accountId: 'acc-123', planType: 'chatgpt_plus' };
		const first = await provider.getLiveKnownModels(token, LIMITS);
		expect(Object.keys(first)).toContain('gpt-5.6-sol');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// A second call for the same account hits the TTL cache, not the network.
		await provider.getLiveKnownModels(token, LIMITS);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		clearChatGptSubCatalogCache();
	});

	it('provider getLiveKnownModels falls back to the static catalog when the fetch fails', async () => {
		clearChatGptSubCatalogCache();
		stubFetch([
			['/models?client_version=', () => fakeResponse(500, {})],
		]);
		const provider = new NikaChatGptSubProvider({} as unknown as IInstantiationService);
		const token = { accessToken: 'at-1', refreshToken: 'rt-1', accountId: 'acc-123', planType: 'chatgpt_plus' };
		const catalog = await provider.getLiveKnownModels(token, LIMITS);
		expect(catalog).toEqual(chatGptSubKnownModels(LIMITS));
		clearChatGptSubCatalogCache();
	});
});

describe('NikaChatGptSubProvider', () => {
	function createProvider(): NikaChatGptSubProvider {
		return new NikaChatGptSubProvider({} as unknown as IInstantiationService);
	}

	it('runs the sign-in end to end and reports the verification start', async () => {
		vi.useFakeTimers();
		try {
			let pollCalls = 0;
			stubFetch([
				['usercode', () => fakeResponse(200, { user_code: 'ABCD-EFGH', device_auth_id: 'dev-1', interval: 2 })],
				['deviceauth/token', () => {
					pollCalls += 1;
					return pollCalls === 1
						? fakeResponse(200, { error: 'authorization_pending' })
						: fakeResponse(200, { authorization_code: 'auth-1', code_verifier: 'verifier-1' });
				}],
				['oauth/token', () => fakeResponse(200, {
					access_token: 'at-1',
					refresh_token: 'rt-1',
					id_token: idTokenWithClaims('acc-123', 'chatgpt_plus'),
				})],
			]);
			const provider = createProvider();
			const onStart = vi.fn();
			const onStatus = vi.fn();
			const flow = provider.signIn(new vscode.CancellationTokenSource().token, onStatus, onStart);
			await vi.advanceTimersByTimeAsync(5_000);
			const result = await flow;
			expect(onStart).toHaveBeenCalledWith({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' });
			expect(onStatus).toHaveBeenCalled();
			expect(result.userCode).toBe('ABCD-EFGH');
			expect(result.token).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', accountId: 'acc-123', planType: 'chatgpt_plus' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('creates the codex endpoint with the account/product/originator headers', () => {
		const inst = { createInstance: vi.fn(() => ({})) } as unknown as IInstantiationService & { createInstance: ReturnType<typeof vi.fn> };
		const provider = new NikaChatGptSubProvider(inst);
		const token: NikaChatGptSubscriptionToken = { accessToken: 'at-1', refreshToken: 'rt-1', accountId: 'acc-123' };
		provider.createEndpoint('gpt-5-codex', token, LIMITS);
		expect(inst.createInstance).toHaveBeenCalledTimes(1);
		const [ctor, modelInfo, apiKey, url] = (inst.createInstance as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(ctor).toBe(NikaChatGptSubEndpoint);
		expect(apiKey).toBe('at-1');
		expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
		expect(modelInfo.requestHeaders).toMatchObject({
			'ChatGPT-Account-ID': 'acc-123',
			'OAI-Product-Sku': 'codex',
			'originator': 'codex_cli_rs',
		});
	});

	it('emits the official codex CLI identity on the wire', () => {
		const modelInfo = resolveModelInfo('gpt-5-codex', NIKA_PROVIDER_NAME, undefined, {
			...resolveChatGptSubModelCapabilities('gpt-5-codex', LIMITS),
			requestHeaders: {
				'ChatGPT-Account-ID': 'acc-123',
				'OAI-Product-Sku': 'codex',
				'originator': 'codex_cli_rs',
			},
		});
		const endpoint = new NikaChatGptSubEndpoint(
			modelInfo, 'at-1', 'https://chatgpt.com/backend-api/codex/responses',
			{} as never, {} as never, {} as never, {} as never,
			{ getConfig: () => undefined } as never, {} as never, {} as never, {} as never,
		);
		const headers = endpoint.getExtraHeaders();
		// `User-Agent` cannot ride in requestHeaders (reserved-header
		// sanitizer strips it) — it must come from getExtraHeaders.
		expect(headers['User-Agent']).toMatch(/^codex_cli_rs\//);
		expect(headers['ChatGPT-Account-ID']).toBe('acc-123');
		expect(headers['OAI-Product-Sku']).toBe('codex');
		expect(headers['originator']).toBe('codex_cli_rs');
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['Authorization']).toBe('Bearer at-1');
	});

	it('opts the codex endpoint out of the Copilot platform headers', () => {
		const modelInfo = resolveModelInfo('gpt-5-codex', NIKA_PROVIDER_NAME, undefined, resolveChatGptSubModelCapabilities('gpt-5-codex', LIMITS));
		const endpoint = new NikaChatGptSubEndpoint(
			modelInfo, 'at-1', 'https://chatgpt.com/backend-api/codex/responses',
			{} as never, {} as never, {} as never, {} as never,
			{ getConfig: () => undefined } as never, {} as never, {} as never, {} as never,
		);
		expect(endpoint.getEndpointFetchOptions?.()).toEqual({ suppressCopilotHeaders: true });
	});
});

describe('NikaChatGptSubEndpoint request body', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices();
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
	});

	afterEach(() => {
		disposables.clear();
	});

	function createEndpoint(): NikaChatGptSubEndpoint {
		const instaService = accessor.get(IInstantiationService);
		const modelInfo = resolveModelInfo('gpt-5.6-sol', NIKA_PROVIDER_NAME, undefined, {
			...resolveChatGptSubModelCapabilities('gpt-5.6-sol', LIMITS),
			requestHeaders: {
				'ChatGPT-Account-ID': 'acc-123',
				'OAI-Product-Sku': 'codex',
				'originator': 'codex_cli_rs',
			},
		});
		return instaService.createInstance(NikaChatGptSubEndpoint, modelInfo, 'at-1', 'https://chatgpt.com/backend-api/codex/responses');
	}

	function bodyOptions(speed?: string): never {
		return {
			debugName: 'test',
			messages: [
				{ role: Raw.ChatRole.System, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Copilot safety rules must not ride to ChatGPT' }] },
				{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'hello' }] },
			],
			requestId: 'test-1',
			postOptions: {},
			ignoreStatefulMarker: false,
			finishedCb: undefined,
			location: ChatLocation.Other,
			modelCapabilities: speed ? { speed } : undefined,
		} as never;
	}

	it('strips system messages from the Responses input (the codex backend rejects them)', () => {
		const body = createEndpoint().createRequestBody(bodyOptions());
		const input = body.input as Array<{ type?: string; role?: string }>;
		expect(input.filter(item => item.type === 'message' && item.role === 'system')).toEqual([]);
		expect(input.some(item => item.type === 'message' && item.role === 'user')).toBe(true);
		expect(body.instructions).toBeUndefined();
	});

	it('omits service_tier by default and with Standard speed', () => {
		const endpoint = createEndpoint();
		expect(endpoint.createRequestBody(bodyOptions()).service_tier).toBeUndefined();
		expect(endpoint.createRequestBody(bodyOptions('standard')).service_tier).toBeUndefined();
	});

	it('strips codex-unsupported Responses parameters the Copilot pipeline adds', () => {
		// The chat pipeline injects postOptions.max_tokens (= maxOutputTokens),
		// which createResponsesRequestBody maps to max_output_tokens. The codex
		// backend strictly validates against the codex CLI wire shape and
		// rejects it (and top_logprobs / prompt_cache_options /
		// context_management / truncation) with
		// `400 {"detail":"Unsupported parameter: ..."}`.
		const body = createEndpoint().createRequestBody({
			...bodyOptions(),
			postOptions: {
				max_tokens: 4096,
				logprobs: true,
			},
			conversationId: 'conv-1',
		} as never);
		expect(body.max_output_tokens).toBeUndefined();
		expect(body.top_logprobs).toBeUndefined();
		expect(body.prompt_cache_options).toBeUndefined();
		expect(body.context_management).toBeUndefined();
		expect(body.truncation).toBeUndefined();
	});

	it('maps Fast speed to the priority service tier', () => {
		const body = createEndpoint().createRequestBody(bodyOptions('fast'));
		expect(body.service_tier).toBe('priority');
	});

	it('falls back to the nika.codexSpeed setting when no per-request speed is set', async () => {
		await accessor.get(IConfigurationService).setNonExtensionConfig('nika.codexSpeed', 'fast');
		const body = createEndpoint().createRequestBody(bodyOptions());
		expect(body.service_tier).toBe('priority');
	});
});
