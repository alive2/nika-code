/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import type { Response as FetcherResponse } from '../../../platform/networking/common/fetcherService';
import type { ICreateEndpointBodyOptions, IEndpointBody, IEndpointFetchOptions } from '../../../platform/networking/common/networking';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKKnownModels, BYOKModelCapabilities, resolveModelInfo } from '../common/byokProvider';
import { NIKA_CHATGPT_MODEL_PREFIX, NIKA_PROVIDER_NAME, NikaChatGptSubscriptionToken, NikaTokenLimits, parseNikaChatGptSubscriptionToken } from './nikaModels';
import { CustomEndpointOAIEndpoint } from './customEndpointProvider';
import { fetchDeviceStartWithRetry, normalizeDeviceErrorCode, readSubErrorDetail } from './nikaSubFetcher';
import { codexFetch, CODEX_CLI_VERSION, codexUserAgent } from './nikaCodexFetcher';

/**
 * The codex OAuth client id used by the official codex CLI for ChatGPT
 * subscription (device-code) sign-in. Pinned from openai/codex
 * (`codex-rs/login/src/auth/manager.rs`).
 */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Starts a device-code flow. */
export const CHATGPT_DEVICE_AUTH_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';

/** Polls a device-code flow for approval. */
export const CHATGPT_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';

/** PKCE exchange + token refresh. */
export const CHATGPT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/** Revokes a refresh token (sign-out). */
export const CHATGPT_REVOKE_URL = 'https://auth.openai.com/oauth/revoke';

/** The codex backend the subscription rides on. */
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** Where the user enters their user code. */
export const CHATGPT_DEVICE_VERIFICATION_URL = 'https://auth.openai.com/codex/device';

/** How long a device-code flow stays valid before it must be restarted. */
const DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1000;

/** Poll cadence floor (seconds) — the server suggests a lower interval. */
const MIN_POLL_INTERVAL_SECONDS = 5;

/**
 * Static catalog of ChatGPT subscription (codex backend) models exposed
 * through the Nika provider. Pinned from the codex CLI's bundled catalog
 * (`codex-rs/models-manager/models.json`, openai/codex main): the visible
 * GPT-5.6 family (Sol flagship / Terra balanced / Luna fast), GPT-5.5 and
 * GPT-5.2, plus the legacy GPT-5-Codex family the backend still accepts
 * (the CLI hides them from its picker but they keep working via `-m`).
 * Capabilities are uniform across the family.
 */
export const NIKA_CHATGPT_SUB_MODEL_IDS: readonly string[] = [
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
];

/**
 * Resolves the BYOK capabilities Nika exposes a ChatGPT subscription model
 * with. The codex backend serves the whole GPT-5-Codex family with native
 * vision, tool calling, and reasoning-effort control; token budgets follow
 * the user-configured Nika limits like the other catalog families.
 */
export function resolveChatGptSubModelCapabilities(rawId: string, limits: NikaTokenLimits): BYOKModelCapabilities {
	const displayName = rawId
		.replace(/^gpt-/i, 'GPT-')
		.replace(/-codex/i, ' Codex')
		.replace(/-mini/i, ' Mini')
		.replace(/-max/i, ' Max')
		.replace(/-sol/i, ' Sol')
		.replace(/-terra/i, ' Terra')
		.replace(/-luna/i, ' Luna')
		.trim();
	return {
		name: displayName || 'GPT-5.6 Sol',
		contextWindow: limits.contextWindow,
		maxInputTokens: limits.maxInputTokens,
		maxOutputTokens: limits.maxOutputTokens,
		toolCalling: true,
		vision: true,
		thinking: true,
		// The codex backend accepts the full reasoning-effort range for the
		// GPT-5.x family (`supported_reasoning_levels`: low..ultra), matching
		// the codex CLI's model popup (e.g. "5.6 Sol Extra High").
		supportsReasoningEffort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
		defaultReasoningEffort: 'medium',
		reasoningEffortFormat: 'responses',
		supportedEndpoints: [ModelSupportedEndpoint.Responses],
		// The codex backend refuses to store responses unless asked; match the
		// codex CLI (`store: false`) and never chain via previous_response_id.
		zeroDataRetentionEnabled: true,
	};
}

/**
 * The ChatGPT subscription model catalog as a `BYOKKnownModels` map keyed by
 * raw model id, for use with `byokKnownModelToAPIInfo`-style conversion.
 */
export function chatGptSubKnownModels(limits: NikaTokenLimits): BYOKKnownModels {
	return Object.fromEntries(NIKA_CHATGPT_SUB_MODEL_IDS.map(id => [id, resolveChatGptSubModelCapabilities(id, limits)]));
}

/** The workbench-facing id of a raw ChatGPT subscription model id. */
export function nikaChatGptModelId(rawId: string): string {
	return `${NIKA_CHATGPT_MODEL_PREFIX}${rawId}`;
}

/** A model entry from the codex backend's live `/models` catalog. */
export interface ChatGptLiveModelInfo {
	readonly slug: string;
	readonly displayName?: string;
	readonly visibility?: 'list' | 'hide';
	readonly priority?: number;
}

/**
 * Fetches the live model catalog from the codex backend, mirroring the
 * codex CLI's `ModelsClient::list_models` (`GET {base}/models?client_version=`
 * with the subscription credentials). Returns the raw entries, or
 * `undefined` when the request fails so callers fall back to the bundled
 * static catalog.
 */
export async function fetchChatGptSubModels(token: NikaChatGptSubscriptionToken): Promise<ChatGptLiveModelInfo[] | undefined> {
	try {
		const response = await codexFetch(
			`${CHATGPT_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(CODEX_CLI_VERSION)}`,
			{
				headers: {
					'Authorization': `Bearer ${token.accessToken}`,
					'ChatGPT-Account-ID': token.accountId ?? '',
					'OAI-Product-Sku': 'codex',
					'originator': 'codex_cli_rs',
				},
				timeoutMs: 10_000,
			},
			codexUserAgent()
		);
		if (!response.ok) {
			return undefined;
		}
		const body = await readJson(response);
		const models = body?.models;
		if (!Array.isArray(models)) {
			return undefined;
		}
		const entries: ChatGptLiveModelInfo[] = [];
		for (const raw of models) {
			if (!raw || typeof raw !== 'object') {
				continue;
			}
			const m = raw as Record<string, unknown>;
			if (typeof m.slug !== 'string' || m.slug.length === 0) {
				continue;
			}
			entries.push({
				slug: m.slug,
				displayName: typeof m.display_name === 'string' ? m.display_name : undefined,
				visibility: m.visibility === 'hide' ? 'hide' : 'list',
				priority: typeof m.priority === 'number' ? m.priority : undefined,
			});
		}
		return entries;
	} catch {
		return undefined;
	}
}

/** Per-account cache of the last live catalog, with a TTL. */
const liveCatalogCache = new Map<string, { at: number; models: BYOKKnownModels }>();
const LIVE_CATALOG_TTL_MS = 10 * 60 * 1000;

/** Clears the live-catalog cache (test hook / sign-out). */
export function clearChatGptSubCatalogCache(): void {
	liveCatalogCache.clear();
}

/**
 * Merges the live backend catalog over the bundled static one. Models the
 * backend lists as visible (or omits a visibility flag) win in server
 * order; `hide` models (e.g. the cyber `gpt-daybreak-*` lineup) are
 * skipped, matching the CLI picker. Static ids the live list does not
 * contain (the legacy `-codex` family) stay available so saved selections
 * keep working.
 */
export function mergeChatGptSubModels(limits: NikaTokenLimits, live: ChatGptLiveModelInfo[] | undefined): BYOKKnownModels {
	const merged: BYOKKnownModels = {};
	if (live) {
		for (const model of live) {
			if (model.visibility === 'hide') {
				continue;
			}
			merged[model.slug] = resolveChatGptSubModelCapabilities(model.slug, limits);
		}
	}
	for (const id of NIKA_CHATGPT_SUB_MODEL_IDS) {
		if (!merged[id]) {
			merged[id] = resolveChatGptSubModelCapabilities(id, limits);
		}
	}
	return merged;
}

/** The device-code flow start, as returned by the usercode endpoint. */
export interface ChatGptDeviceFlowStart {
	readonly userCode: string;
	readonly deviceAuthId: string;
	readonly interval: number;
}

/** Result of polling + exchanging the device-code flow. */
export interface ChatGptDeviceFlowResult {
	readonly token: NikaChatGptSubscriptionToken;
	/** Where the user must type their code. */
	readonly verificationUrl: string;
	readonly userCode: string;
}

/**
 * Extracts `chatgpt_account_id` and `chatgpt_plan_type` from a ChatGPT
 * id_token's unverified JWT payload (the same claims the codex CLI reads).
 * Returns an empty object when the claims are absent or unparseable.
 */
export function parseChatGptIdTokenClaims(idToken: string): { accountId?: string; planType?: string } {
	try {
		const payloadPart = idToken.split('.')[1];
		if (!payloadPart) {
			return {};
		}
		const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
		const claims = JSON.parse(json) as Record<string, unknown>;
		const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
		const accountId = typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined;
		const planType = typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined;
		return { accountId, planType };
	} catch {
		return {};
	}
}

/**
 * Reads the `exp` claim (epoch seconds) from an access-token JWT payload as
 * epoch millis, or `undefined` when unparseable. The codex CLI uses this
 * claim to decide when to refresh proactively (`should_refresh_proactively`).
 */
export function parseChatGptTokenExpiry(accessToken: string): number | undefined {
	try {
		const payloadPart = accessToken.split('.')[1];
		if (!payloadPart) {
			return undefined;
		}
		const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
		const claims = JSON.parse(json) as { exp?: unknown };
		return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Sleeps for `ms` milliseconds, rejecting early when the token is cancelled.
 */
async function sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
	if (token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		token.onCancellationRequested(() => {
			clearTimeout(timer);
			reject(new vscode.CancellationError());
		});
	});
}

/** Reads a JSON body defensively (error bodies may be HTML or empty). */
async function readJson(response: FetcherResponse): Promise<Record<string, unknown> | undefined> {
	try {
		const body = await response.json();
		return body && typeof body === 'object' ? body as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Starts a ChatGPT subscription device-code flow.
 *
 * Wire contract (pinned from openai/codex):
 * - `POST auth.openai.com/api/accounts/deviceauth/usercode` with
 *   `{"client_id": "app_EMoamEEZ73f0CkXaXp7hrann"}` returns
 *   `{user_code, device_auth_id, interval}`.
 * - The user approves at `https://auth.openai.com/codex/device`.
 */
export async function startChatGptDeviceFlow(): Promise<ChatGptDeviceFlowStart> {
	const response = await fetchDeviceStartWithRetry(CHATGPT_DEVICE_AUTH_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
	}, codexUserAgent());
	if (!response.ok) {
		throw new Error(vscode.l10n.t('ChatGPT device sign-in returned HTTP {0}: {1}', response.status, await readSubErrorDetail(response)));
	}
	const body = await readJson(response);
	const userCode = body?.user_code;
	const deviceAuthId = body?.device_auth_id;
	if (typeof userCode !== 'string' || userCode.length === 0 || typeof deviceAuthId !== 'string' || deviceAuthId.length === 0) {
		throw new Error(vscode.l10n.t('The ChatGPT device sign-in response was malformed.'));
	}
	return {
		userCode,
		deviceAuthId,
		interval: typeof body?.interval === 'number' && body.interval > 0 ? body.interval : MIN_POLL_INTERVAL_SECONDS,
	};
}

/**
 * Polls a ChatGPT device-code flow until the user approves (or the flow
 * expires). `onStatus` receives human-readable progress for the wizard UI.
 *
 * Wire contract (pinned from openai/codex):
 * - `POST auth.openai.com/api/accounts/deviceauth/token` with
 *   `{device_auth_id, user_code}`. While pending it returns
 *   `{"error": "authorization_pending"}` (or `slow_down`); once approved it
 *   returns `{code_verifier, code_challenge, authorization_code}`.
 * - The flow times out server-side after ~15 minutes.
 */
export async function pollChatGptDeviceFlow(
	start: ChatGptDeviceFlowStart,
	token: vscode.CancellationToken,
	onStatus?: (message: string) => void,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
	const deadline = Date.now() + DEVICE_FLOW_TIMEOUT_MS;
	let intervalSeconds = Math.max(start.interval, MIN_POLL_INTERVAL_SECONDS);
	for (;;) {
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		if (Date.now() > deadline) {
			throw new Error(vscode.l10n.t('ChatGPT device sign-in timed out. Start over.'));
		}
		onStatus?.(vscode.l10n.t('Waiting for you to approve the sign-in…'));
		const response = await codexFetch(CHATGPT_DEVICE_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ device_auth_id: start.deviceAuthId, user_code: start.userCode }),
		}, codexUserAgent());
		const body = await readJson(response);
		// The server reports flow state either as a plain error string
		// ('authorization_pending') or as an object with a `code` field
		// ({code: 'deviceauth_authorization_pending'}) — and pending is sent
		// with HTTP 403, not 200. Normalize both forms so a pending flow keeps
		// polling instead of being misread as a fatal error.
		const errorCode = normalizeDeviceErrorCode(body?.error);
		if (typeof body?.authorization_code === 'string' && body.authorization_code.length > 0 && typeof body?.code_verifier === 'string' && body.code_verifier.length > 0) {
			return { authorizationCode: body.authorization_code, codeVerifier: body.code_verifier };
		}
		if (errorCode === 'slow_down' || errorCode === 'deviceauth_slow_down') {
			// The server asks the client to slow down: extend the interval.
			intervalSeconds += 5;
		} else if (errorCode === 'access_denied' || errorCode === 'deviceauth_access_denied') {
			throw new Error(vscode.l10n.t('The ChatGPT sign-in was declined.'));
		} else if (errorCode === 'expired_token' || errorCode === 'deviceauth_expired_token') {
			throw new Error(vscode.l10n.t('The ChatGPT sign-in expired. Start over.'));
		} else if (errorCode !== 'authorization_pending' && errorCode !== 'deviceauth_authorization_pending' && !response.ok) {
			throw new Error(vscode.l10n.t('ChatGPT device sign-in returned HTTP {0}: {1}', response.status, await readSubErrorDetail(response)));
		}
		await sleep(intervalSeconds * 1000, token);
	}
}

/**
 * Exchanges an approved device-code flow for real tokens.
 *
 * Wire contract (pinned from openai/codex `exchange_code_for_tokens`): a
 * form-urlencoded PKCE authorization_code grant against
 * `auth.openai.com/oauth/token` with `redirect_uri` =
 * `https://auth.openai.com/deviceauth/callback`.
 */
export async function exchangeChatGptDeviceCode(authorizationCode: string, codeVerifier: string): Promise<NikaChatGptSubscriptionToken> {
	const form = new URLSearchParams({
		grant_type: 'authorization_code',
		code: authorizationCode,
		redirect_uri: 'https://auth.openai.com/deviceauth/callback',
		client_id: CHATGPT_CLIENT_ID,
		code_verifier: codeVerifier,
	}).toString();
	const response = await codexFetch(CHATGPT_OAUTH_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: form,
	}, codexUserAgent());
	if (!response.ok) {
		throw new Error(vscode.l10n.t('ChatGPT sign-in exchange returned HTTP {0}: {1}', response.status, await readSubErrorDetail(response)));
	}
	const body = await readJson(response);
	const accessToken = body?.access_token;
	const refreshToken = body?.refresh_token;
	const idToken = body?.id_token;
	if (typeof accessToken !== 'string' || accessToken.length === 0 || typeof refreshToken !== 'string' || refreshToken.length === 0) {
		throw new Error(vscode.l10n.t('The ChatGPT sign-in exchange was malformed.'));
	}
	const claims = typeof idToken === 'string' ? parseChatGptIdTokenClaims(idToken) : {};
	return {
		accessToken,
		refreshToken,
		idToken: typeof idToken === 'string' ? idToken : undefined,
		accountId: claims.accountId,
		planType: claims.planType,
		expiresAt: parseChatGptTokenExpiry(accessToken),
	};
}

/**
 * Refreshes a ChatGPT subscription access token.
 *
 * Wire contract (pinned from openai/codex `request_chatgpt_token_refresh`):
 * a JSON grant `{"client_id", "grant_type": "refresh_token",
 * "refresh_token"}` against `auth.openai.com/oauth/token`. The response may
 * omit any of `id_token`/`access_token`/`refresh_token`; absent fields keep
 * their previous values.
 */
export async function refreshChatGptAccessToken(current: NikaChatGptSubscriptionToken): Promise<NikaChatGptSubscriptionToken> {
	const response = await codexFetch(CHATGPT_OAUTH_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_id: CHATGPT_CLIENT_ID,
			grant_type: 'refresh_token',
			refresh_token: current.refreshToken,
		}),
	}, codexUserAgent());
	if (!response.ok) {
		throw new Error(vscode.l10n.t('ChatGPT token refresh returned HTTP {0}: {1}', response.status, await readSubErrorDetail(response)));
	}
	const body = await readJson(response);
	const accessToken = typeof body?.access_token === 'string' && body.access_token.length > 0 ? body.access_token : current.accessToken;
	const refreshToken = typeof body?.refresh_token === 'string' && body.refresh_token.length > 0 ? body.refresh_token : current.refreshToken;
	const idToken = typeof body?.id_token === 'string' && body.id_token.length > 0 ? body.id_token : current.idToken;
	const claims = idToken && idToken !== current.idToken ? parseChatGptIdTokenClaims(idToken) : {};
	return {
		accessToken,
		refreshToken,
		idToken,
		accountId: claims.accountId ?? current.accountId,
		planType: claims.planType ?? current.planType,
		expiresAt: parseChatGptTokenExpiry(accessToken) ?? current.expiresAt,
	};
}

/**
 * Revokes the ChatGPT refresh token (best effort — the endpoint may be
 * unreachable or already invalidated server-side).
 */
export async function revokeChatGptToken(current: NikaChatGptSubscriptionToken): Promise<void> {
	try {
		await codexFetch(CHATGPT_REVOKE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: CHATGPT_CLIENT_ID,
				token: current.refreshToken,
				token_type_hint: 'refresh_token',
			}),
		}, codexUserAgent());
	} catch {
		// Best-effort sign-out: the local secret is deleted regardless.
	}
}

/**
 * ChatGPT subscription endpoint: the codex-backend Responses API with the
 * official codex CLI identity (user agent, product sku, originator).
 *
 * `suppressCopilotHeaders` drops every GitHub Copilot platform header from
 * the request so the traffic presents as the official codex CLI at the HTTP
 * layer.
 */
export class NikaChatGptSubEndpoint extends CustomEndpointOAIEndpoint {
	override getEndpointFetchOptions(): IEndpointFetchOptions {
		return { suppressCopilotHeaders: true };
	}

	/**
	 * `User-Agent` is on the reserved-header list, so it cannot ride in
	 * `requestHeaders` (the sanitizer strips it and the platform fetcher would
	 * stamp `GitHubCopilotChat/...` instead). Attaching it here, after
	 * sanitization, guarantees the official codex CLI user agent reaches the
	 * wire.
	 */
	override getExtraHeaders(): Record<string, string> {
		const headers = super.getExtraHeaders();
		headers['User-Agent'] = codexUserAgent();
		return headers;
	}

	/**
	 * Shapes the Responses body the way the codex backend requires:
	 * - The backend rejects `system` messages in `input` with
	 *   `400 {"detail":"System messages are not allowed"}`. The chat pipeline
	 *   injects a system message (safety rules / system prompt), which must
	 *   not ride to ChatGPT — the codex backend applies its own default
	 *   system prompt instead (the real CLI sends its prompt via
	 *   `instructions`; we send none to avoid leaking Copilot branding).
	 * - The backend strictly validates request parameters against the codex
	 *   CLI's `ResponsesApiRequest` wire shape and rejects anything the CLI
	 *   never sends with `400 {"detail":"Unsupported parameter: ..."}`. The
	 *   Copilot Responses pipeline adds several extras that must be dropped:
	 *   `max_output_tokens` (the CLI lets the backend apply its own output
	 *   policy), `top_logprobs`, `prompt_cache_options` (codex uses the
	 *   `prompt_cache_key` string instead), `context_management` (codex has
	 *   a separate compaction endpoint) and `truncation`.
	 * - The codex Speed control (Standard / Fast) maps to the Responses
	 *   `service_tier` field: Fast = the `priority` tier ("1.5x speed,
	 *   increased usage"), exactly like the codex CLI.
	 */
	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		const body = super.createRequestBody(options);
		if (Array.isArray(body.input)) {
			body.input = body.input.filter(item => {
				if (!item || typeof item !== 'object') {
					return true;
				}
				const typed = item as { type?: string; role?: string };
				return !(typed.type === 'message' && typed.role === 'system');
			});
		}
		delete body.instructions;
		delete body.max_output_tokens;
		delete body.top_logprobs;
		delete body.prompt_cache_options;
		delete body.context_management;
		delete body.truncation;
		const speed = options.modelCapabilities?.speed ?? this._configurationService.getNonExtensionConfig<string>('nika.codexSpeed');
		if (speed === 'fast') {
			body.service_tier = 'priority';
		} else {
			delete body.service_tier;
		}
		return body;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): NikaChatGptSubEndpoint {
		const newModelInfo = { ...this.modelMetadata, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(NikaChatGptSubEndpoint, newModelInfo, this._apiKey, this._modelUrl);
	}
}

/**
 * ChatGPT subscription provider: device-code sign-in and codex-backend chat.
 *
 * The chat path reuses `CustomEndpointOAIEndpoint` so the upstream Responses
 * API shaping (tool calls, reasoning effort, streaming, usage parts) applies
 * unchanged, with the codex-specific headers attached via model metadata.
 */
export class NikaChatGptSubProvider extends Disposable {
	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	/**
	 * Runs the full device-code sign-in: starts the flow, polls until the
	 * user approves, exchanges for tokens, and returns the ready-to-store
	 * token payload. `onStatus` receives human-readable progress and
	 * `onStart` fires as soon as the flow is live (verification URL + code)
	 * so the wizard UI can display them while polling is in flight.
	 */
	async signIn(token: vscode.CancellationToken, onStatus?: (message: string) => void, onStart?: (start: { verificationUrl: string; userCode: string }) => void): Promise<ChatGptDeviceFlowResult> {
		const start = await startChatGptDeviceFlow();
		const verificationUrl = CHATGPT_DEVICE_VERIFICATION_URL;
		onStart?.({ verificationUrl, userCode: start.userCode });
		onStatus?.(vscode.l10n.t('Open {0} and enter the code to approve the sign-in.', verificationUrl));
		const { authorizationCode, codeVerifier } = await pollChatGptDeviceFlow(start, token, onStatus);
		const tokenPayload = await exchangeChatGptDeviceCode(authorizationCode, codeVerifier);
		return { token: tokenPayload, verificationUrl, userCode: start.userCode };
	}

	/** Refreshes the access token, returning an updated payload to store. */
	async refreshToken(current: NikaChatGptSubscriptionToken): Promise<NikaChatGptSubscriptionToken> {
		return refreshChatGptAccessToken(current);
	}

	/** Revokes the refresh token (best effort). */
	async revoke(current: NikaChatGptSubscriptionToken): Promise<void> {
		return revokeChatGptToken(current);
	}

	/** The static ChatGPT subscription model catalog keyed by raw id. */
	getKnownModels(limits: NikaTokenLimits): BYOKKnownModels {
		return chatGptSubKnownModels(limits);
	}

	/**
	 * The ChatGPT subscription model catalog: the live backend catalog
	 * (cached per account with a TTL) merged over the bundled static one.
	 * A failed fetch degrades to the static catalog, so this never rejects.
	 */
	async getLiveKnownModels(token: NikaChatGptSubscriptionToken, limits: NikaTokenLimits): Promise<BYOKKnownModels> {
		const accountId = token.accountId ?? '';
		const cached = liveCatalogCache.get(accountId);
		if (cached && Date.now() - cached.at < LIVE_CATALOG_TTL_MS) {
			return cached.models;
		}
		const live = await fetchChatGptSubModels(token);
		const models = mergeChatGptSubModels(limits, live);
		liveCatalogCache.set(accountId, { at: Date.now(), models });
		return models;
	}

	/**
	 * Creates the codex-backend endpoint for a request. The access token
	 * rides as the Bearer credential; the account id, product sku, and
	 * originator go out as extra headers.
	 */
	createEndpoint(rawModelId: string, current: NikaChatGptSubscriptionToken, limits: NikaTokenLimits): NikaChatGptSubEndpoint {
		const capabilities = resolveChatGptSubModelCapabilities(rawModelId, limits);
		const modelInfo = resolveModelInfo(rawModelId, NIKA_PROVIDER_NAME, undefined, {
			...capabilities,
			requestHeaders: {
				'ChatGPT-Account-ID': current.accountId ?? '',
				'OAI-Product-Sku': 'codex',
				'originator': 'codex_cli_rs',
			},
		});
		return this._instantiationService.createInstance(NikaChatGptSubEndpoint, modelInfo, current.accessToken, `${CHATGPT_CODEX_BASE_URL}/responses`);
	}
}

/** Parses a stored secret payload, or `undefined` when invalid. */
export function parseChatGptSubSecret(value: string | undefined): NikaChatGptSubscriptionToken | undefined {
	return parseNikaChatGptSubscriptionToken(value);
}
