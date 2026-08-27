/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import type { Response as FetcherResponse } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { BYOKKnownModels, BYOKModelCapabilities, resolveModelInfo } from '../common/byokProvider';
import { NIKA_CLAUDE_SUB_MODEL_PREFIX, NIKA_PROVIDER_NAME, NikaClaudeSubscriptionToken, NikaTokenLimits, parseNikaClaudeSubscriptionToken } from './nikaModels';
import { CustomEndpointOAIEndpoint } from './customEndpointProvider';
import { fetchDeviceStartWithRetry, normalizeDeviceErrorCode, readSubErrorDetail } from './nikaSubFetcher';
import { claudeCliUserAgent, codexFetch } from './nikaCodexFetcher';
import { IEndpointBody, IEndpointFetchOptions } from '../../../platform/networking/common/networking';

/**
 * The OAuth client id used by the official Claude Code client for Claude
 * subscription sign-in. Pinned from the claude.exe 2.1.246 binary
 * (`CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"`).
 */
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** The consumer OAuth issuer (device flow). */
export const CLAUDE_ISSUER = 'https://claude.ai';

/** Starts a device-code flow. */
export const CLAUDE_DEVICE_AUTH_URL = 'https://claude.ai/oauth/device_authorization';

/** Polls a device-code flow for approval. */
export const CLAUDE_DEVICE_TOKEN_URL = 'https://claude.ai/oauth/token';

/** Token refresh (as used by the official client's browser OAuth flow). */
export const CLAUDE_REFRESH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/** The Anthropic Messages API. */
export const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/**
 * The exact system prompt the Anthropic API accepts for OAuth subscription
 * requests. Pinned byte-for-byte from the claude.exe binary and the Claude
 * Code SDK — the API verifies known Claude Code prefixes, so nothing may be
 * appended. The apostrophe is the plain ASCII `'` (0x27).
 */
export const CLAUDE_CODE_SYSTEM_PROMPT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/** The beta header the subscription API requires. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

/**
 * OAuth scopes the official client requests for subscription tokens (used on
 * refresh). Pinned from the claude.exe binary's scope constant.
 */
export const CLAUDE_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/** How long a device-code flow stays valid before it must be restarted. */
const DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1000;

/** Poll cadence floor (seconds) — the server defaults to 5. */
const MIN_POLL_INTERVAL_SECONDS = 5;

/**
 * Static catalog of Claude subscription models exposed through the Nika
 * provider. The subscription API serves the current Claude lineup; ids are
 * the aliases the official Claude Code client uses.
 */
export const NIKA_CLAUDE_SUB_MODEL_IDS: readonly string[] = [
	'claude-sonnet-4-5',
	'claude-opus-4-5',
	'claude-haiku-4-5',
];

/**
 * Resolves the BYOK capabilities Nika exposes a Claude subscription model
 * with. The whole lineup has native vision, tool calling, and extended
 * thinking; token budgets follow the user-configured Nika limits like the
 * other catalog families. Claude has no reasoning-effort control.
 */
export function resolveClaudeSubModelCapabilities(rawId: string, limits: NikaTokenLimits): BYOKModelCapabilities {
	const displayName = rawId
		.replace(/^claude-/i, 'Claude ')
		.replace(/-/g, ' ')
		.replace(/\b\w/g, c => c.toUpperCase());
	return {
		name: displayName || 'Claude',
		contextWindow: limits.contextWindow,
		maxInputTokens: limits.maxInputTokens,
		maxOutputTokens: limits.maxOutputTokens,
		toolCalling: true,
		vision: true,
		thinking: true,
		// Claude has no reasoning-effort control (extended thinking is a
		// budget the agent host manages, never exposed as an effort level).
		supportsReasoningEffort: [],
		reasoningEffortFormat: 'messages',
		supportedEndpoints: [ModelSupportedEndpoint.Messages],
	};
}

/**
 * The Claude subscription model catalog as a `BYOKKnownModels` map keyed by
 * raw model id, for use with `byokKnownModelToAPIInfo`-style conversion.
 */
export function claudeSubKnownModels(limits: NikaTokenLimits): BYOKKnownModels {
	return Object.fromEntries(NIKA_CLAUDE_SUB_MODEL_IDS.map(id => [id, resolveClaudeSubModelCapabilities(id, limits)]));
}

/** The workbench-facing id of a raw Claude subscription model id. */
export function nikaClaudeModelId(rawId: string): string {
	return `${NIKA_CLAUDE_SUB_MODEL_PREFIX}${rawId}`;
}

/** The device-code flow start, as returned by the device endpoint. */
export interface ClaudeDeviceFlowStart {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly verificationUri: string;
	readonly verificationUriComplete?: string;
	readonly interval: number;
}

/** Result of polling + exchanging the device-code flow. */
export interface ClaudeDeviceFlowResult {
	readonly token: NikaClaudeSubscriptionToken;
	/** Where the user must type their code. */
	readonly verificationUrl: string;
	readonly userCode: string;
}

/** Sleeps for `ms` milliseconds, rejecting early when the token is cancelled. */
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
 * Starts a Claude subscription device-code flow.
 *
 * Wire contract (pinned from the claude.exe binary): a form-urlencoded POST
 * to `{issuer}/oauth/device_authorization` (issuer = `https://claude.ai`)
 * returns `{device_code, user_code, verification_uri, verification_uri_complete,
 * expires_in, interval}`. The user approves at `https://claude.ai/device`.
 */
export async function startClaudeDeviceFlow(): Promise<ClaudeDeviceFlowStart> {
	const form = new URLSearchParams({ client_id: CLAUDE_CLIENT_ID }).toString();
	const response = await fetchDeviceStartWithRetry(CLAUDE_DEVICE_AUTH_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: form,
	}, claudeCliUserAgent());
	if (!response.ok) {
		throw new Error(vscode.l10n.t('Claude device sign-in returned HTTP {0}: {1}', response.status, await readSubErrorDetail(response)));
	}
	const body = await readJson(response);
	const deviceCode = body?.device_code;
	const userCode = body?.user_code;
	const verificationUri = body?.verification_uri;
	if (typeof deviceCode !== 'string' || deviceCode.length === 0 || typeof userCode !== 'string' || userCode.length === 0 || typeof verificationUri !== 'string' || verificationUri.length === 0) {
		throw new Error(vscode.l10n.t('The Claude device sign-in response was malformed.'));
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete: typeof body?.verification_uri_complete === 'string' ? body.verification_uri_complete : undefined,
		interval: typeof body?.interval === 'number' && body.interval > 0 ? body.interval : MIN_POLL_INTERVAL_SECONDS,
	};
}

/**
 * Polls a Claude device-code flow until the user approves (or the flow
 * expires). `onStatus` receives human-readable progress for the wizard UI.
 *
 * Wire contract (pinned from the claude.exe binary): a form-urlencoded
 * device_code grant against `{issuer}/oauth/token` returns the token set on
 * success, or `{error}` = `authorization_pending` / `slow_down` /
 * `expired_token` / `access_denied` otherwise. The flow times out
 * server-side after ~15 minutes.
 */
export async function pollClaudeDeviceFlow(
	start: ClaudeDeviceFlowStart,
	token: vscode.CancellationToken,
	onStatus?: (message: string) => void,
): Promise<NikaClaudeSubscriptionToken> {
	const deadline = Date.now() + DEVICE_FLOW_TIMEOUT_MS;
	let intervalSeconds = Math.max(start.interval, MIN_POLL_INTERVAL_SECONDS);
	for (;;) {
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		if (Date.now() > deadline) {
			throw new Error(vscode.l10n.t('Claude device sign-in timed out. Start over.'));
		}
		onStatus?.(vscode.l10n.t('Waiting for you to approve the sign-in…'));
		const form = new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			device_code: start.deviceCode,
			client_id: CLAUDE_CLIENT_ID,
		}).toString();
		const response = await codexFetch(CLAUDE_DEVICE_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form,
		}, claudeCliUserAgent());
		const body = await readJson(response);
		const accessToken = body?.access_token;
		const refreshToken = body?.refresh_token;
		if (typeof accessToken === 'string' && accessToken.length > 0 && typeof refreshToken === 'string' && refreshToken.length > 0) {
			return {
				accessToken,
				refreshToken,
				expiresAt: typeof body?.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : undefined,
			};
		}
		const errorCode = normalizeDeviceErrorCode(body?.error);
		if (errorCode === 'slow_down') {
			// The server asks the client to slow down: extend the interval.
			intervalSeconds += 5;
		} else if (errorCode === 'access_denied') {
			throw new Error(vscode.l10n.t('The Claude sign-in was declined.'));
		} else if (errorCode === 'expired_token') {
			throw new Error(vscode.l10n.t('The Claude sign-in expired. Start over.'));
		} else if (errorCode !== 'authorization_pending' && !response.ok) {
			throw new Error(vscode.l10n.t('Claude device sign-in returned HTTP {0}: {1}', response.status, await readSubErrorDetail(response)));
		}
		await sleep(intervalSeconds * 1000, token);
	}
}

/**
 * Refreshes a Claude subscription access token.
 *
 * Wire contract (pinned from the claude.exe binary): a JSON refresh_token
 * grant against `platform.claude.com/v1/oauth/token` with the client id and
 * scope. On `invalid_grant` the flow falls back to the device-flow issuer's
 * token endpoint before giving up.
 */
export async function refreshClaudeAccessToken(current: NikaClaudeSubscriptionToken): Promise<NikaClaudeSubscriptionToken> {
	const body = JSON.stringify({
		grant_type: 'refresh_token',
		refresh_token: current.refreshToken,
		client_id: CLAUDE_CLIENT_ID,
		scope: CLAUDE_SCOPES,
	});
	for (const url of [CLAUDE_REFRESH_TOKEN_URL, `${CLAUDE_ISSUER}/oauth/token`]) {
		const response = await codexFetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		}, claudeCliUserAgent());
		if (!response.ok) {
			// Try the issuer endpoint once before failing (the device-issued
			// refresh token may live on a different authorization server).
			continue;
		}
		const parsed = await readJson(response);
		const accessToken = typeof parsed?.access_token === 'string' && parsed.access_token.length > 0 ? parsed.access_token : undefined;
		if (!accessToken) {
			continue;
		}
		return {
			accessToken,
			refreshToken: typeof parsed?.refresh_token === 'string' && parsed.refresh_token.length > 0 ? parsed.refresh_token : current.refreshToken,
			expiresAt: typeof parsed?.expires_in === 'number' ? Date.now() + parsed.expires_in * 1000 : undefined,
			planType: current.planType,
			displayName: current.displayName,
		};
	}
	throw new Error(vscode.l10n.t('Claude token refresh failed. Sign in again.'));
}

/**
 * Best-effort account status fetch for the sign-in status row: reads the
 * subscription plan type and display name from the account endpoint. Failures
 * (bot protection, offline) degrade to `undefined` — the token itself is
 * still valid and chat works without this data.
 */
export async function fetchClaudeAccountStatus(accessToken: string): Promise<{ planType?: string; displayName?: string } | undefined> {
	try {
		const response = await codexFetch('https://claude.ai/api/organization/', {
			method: 'GET',
			headers: { Authorization: `Bearer ${accessToken}` },
		}, claudeCliUserAgent());
		if (!response.ok) {
			return undefined;
		}
		const body = await readJson(response);
		if (!body) {
			return undefined;
		}
		const organization = body.organization as Record<string, unknown> | undefined;
		const account = body.account as Record<string, unknown> | undefined;
		const planType = typeof organization?.subscriptionType === 'string'
			? organization.subscriptionType
			: typeof organization?.organization_type === 'string'
				? organization.organization_type
				: typeof organization?.seat_tier === 'string'
					? organization.seat_tier
					: undefined;
		const displayName = typeof account?.display_name === 'string' ? account.display_name : undefined;
		if (planType === undefined && displayName === undefined) {
			return undefined;
		}
		return { planType, displayName };
	} catch {
		return undefined;
	}
}

/**
 * Claude subscription endpoint: Messages API with the exact Claude Code SDK
 * system prompt and the `oauth-2025-04-20` beta.
 *
 * The Messages body would normally carry the client's own system prompt,
 * which the subscription API rejects — it verifies the Claude Code SDK
 * prefix. `customizeMessagesBody` therefore replaces `system` with the exact
 * SDK string (nothing appended).
 */
export class NikaClaudeSubEndpoint extends CustomEndpointOAIEndpoint {
	/**
	 * Presents as the official Claude Code CLI at the HTTP layer: no GitHub
	 * Copilot platform headers, no VS Code user-agent-library header.
	 */
	override getEndpointFetchOptions(): IEndpointFetchOptions {
		return { suppressCopilotHeaders: true };
	}

	/**
	 * `User-Agent` is on the reserved-header list, so it cannot ride in
	 * `requestHeaders` (the sanitizer strips it and the platform fetcher would
	 * stamp `GitHubCopilotChat/...` instead). Attaching it here, after
	 * sanitization, guarantees the official Claude CLI user agent reaches the
	 * wire.
	 */
	override getExtraHeaders(): Record<string, string> {
		const headers = super.getExtraHeaders();
		headers['User-Agent'] = claudeCliUserAgent();
		return headers;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): NikaClaudeSubEndpoint {
		const newModelInfo = { ...this.modelMetadata, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(NikaClaudeSubEndpoint, newModelInfo, this._apiKey, this._modelUrl);
	}

	protected override customizeMessagesBody(body: IEndpointBody): IEndpointBody {
		const result = super.customizeMessagesBody(body);
		// `system` is part of the Messages body at runtime (spread in by
		// `createMessagesRequestBody`) but not declared on `IEndpointBody`.
		const messagesBody = result as IEndpointBody & { system?: unknown };
		messagesBody.system = [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }];
		return result;
	}
}

/**
 * Claude subscription provider: device-code sign-in and Messages API chat.
 *
 * The chat path reuses `NikaClaudeSubEndpoint` so the upstream Messages API
 * shaping (tool calls, thinking, streaming, usage parts) applies unchanged,
 * with the OAuth bearer credential and beta header attached via model
 * metadata.
 */
export class NikaClaudeSubProvider extends Disposable {
	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	/**
	 * Runs the full device-code sign-in: starts the flow, polls until the
	 * user approves, and returns the ready-to-store token payload.
	 * `onStatus` receives human-readable progress and `onStart` fires as
	 * soon as the flow is live (verification URL + code) so the wizard UI
	 * can display them while polling is in flight.
	 */
	async signIn(token: vscode.CancellationToken, onStatus?: (message: string) => void, onStart?: (start: { verificationUrl: string; userCode: string }) => void): Promise<ClaudeDeviceFlowResult> {
		const start = await startClaudeDeviceFlow();
		const verificationUrl = start.verificationUriComplete ?? start.verificationUri;
		onStart?.({ verificationUrl, userCode: start.userCode });
		onStatus?.(vscode.l10n.t('Open {0} and enter the code to approve the sign-in.', start.verificationUri));
		const tokenPayload = await pollClaudeDeviceFlow(start, token, onStatus);
		return { token: tokenPayload, verificationUrl, userCode: start.userCode };
	}

	/** Refreshes the access token, returning an updated payload to store. */
	async refreshToken(current: NikaClaudeSubscriptionToken): Promise<NikaClaudeSubscriptionToken> {
		return refreshClaudeAccessToken(current);
	}

	/** Best-effort plan/display-name lookup for the status row. */
	async fetchAccountStatus(accessToken: string): Promise<{ planType?: string; displayName?: string } | undefined> {
		return fetchClaudeAccountStatus(accessToken);
	}

	/** The static Claude subscription model catalog keyed by raw id. */
	getKnownModels(limits: NikaTokenLimits): BYOKKnownModels {
		return claudeSubKnownModels(limits);
	}

	/**
	 * Creates the Messages API endpoint for a request. The access token rides
	 * as a Bearer credential (not `x-api-key`) and the OAuth beta header is
	 * attached; the exact SDK system prompt is forced at body time.
	 */
	createEndpoint(rawModelId: string, current: NikaClaudeSubscriptionToken, limits: NikaTokenLimits): NikaClaudeSubEndpoint {
		const capabilities = resolveClaudeSubModelCapabilities(rawModelId, limits);
		const modelInfo = resolveModelInfo(rawModelId, NIKA_PROVIDER_NAME, undefined, {
			...capabilities,
			// `authorization` overrides the default `x-api-key` credential
			// (the literal `${apiKey}` is interpolated at request time); the
			// `anthropic-beta` custom header replaces the generic beta set.
			requestHeaders: {
				'authorization': 'Bearer ${apiKey}',
				'anthropic-beta': CLAUDE_OAUTH_BETA,
			},
		});
		return this._instantiationService.createInstance(NikaClaudeSubEndpoint, modelInfo, current.accessToken, CLAUDE_MESSAGES_URL);
	}
}

/** Parses a stored secret payload, or `undefined` when invalid. */
export function parseClaudeSubSecret(value: string | undefined): NikaClaudeSubscriptionToken | undefined {
	return parseNikaClaudeSubscriptionToken(value);
}
