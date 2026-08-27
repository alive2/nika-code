/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Identity-mirrored fetching for the subscription providers.
 *
 * The platform `IFetcherService` stamps every request with
 * `User-Agent: GitHubCopilotChat/<version>` and
 * `X-VSCode-User-Agent-Library-Version` — a signature the ChatGPT/Claude
 * auth and API hosts can fingerprint as "not the official CLI". The
 * subscription flows therefore bypass the platform fetcher and go through
 * `globalThis.fetch` with the official client's exact User-Agent:
 * - ChatGPT: the codex CLI's `codex_cli_rs/<version> (OS; arch) terminal`
 * - Claude: the Claude Code CLI's `claude-cli/<version>`
 *
 * `globalThis.fetch` in the extension host is still the VS Code proxy/CA
 * patched fetch, so corporate proxies and custom certificate stores keep
 * working.
 */

import * as os from 'os';

/** The codex CLI release we present as (pinned from openai/codex releases). */
export const CODEX_CLI_VERSION = '0.149.1';

/** The Claude Code CLI release we present as (pinned from claude.exe 2.1.246). */
export const CLAUDE_CLI_VERSION = '2.1.246';

/** Maps Node's `process.arch` to the arch spelling the CLIs report. */
function archForUserAgent(): string {
	switch (process.arch) {
		case 'x64': return 'x86_64';
		case 'arm64': return 'aarch64';
		default: return process.arch;
	}
}

/** The codex CLI user agent: `codex_cli_rs/<version> (OS release; arch) terminal`. */
export function codexUserAgent(): string {
	const osName = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
	const release = os.release();
	const terminal = process.platform === 'win32' ? 'windows-terminal' : (process.env.TERM_PROGRAM || 'unknown-terminal');
	return `codex_cli_rs/${CODEX_CLI_VERSION} (${osName} ${release}; ${archForUserAgent()}) ${terminal}`;
}

/** The Claude Code CLI user agent: `claude-cli/<version>`. */
export function claudeCliUserAgent(): string {
	return `claude-cli/${CLAUDE_CLI_VERSION}`;
}

/** Options mirroring the subset of `FetchOptions` the sub-providers use. */
export interface CodexFetchInit {
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	headers?: { [name: string]: string };
	body?: string;
	signal?: AbortSignal;
	/** Timeout for the request; defaults to 60s. */
	timeoutMs?: number;
}

/**
 * Fetches via the (proxy-patched) global fetch with the given official
 * client User-Agent. The UA is only defaulted when the caller did not
 * provide one explicitly.
 */
export async function codexFetch(url: string, init: CodexFetchInit, userAgent: string): Promise<Response> {
	const headers: { [name: string]: string } = { ...init.headers };
	if (!headers['User-Agent'] && !headers['user-agent']) {
		headers['User-Agent'] = userAgent;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 60_000);
	const onAbort = () => controller.abort();
	init.signal?.addEventListener('abort', onAbort);
	try {
		return await globalThis.fetch(url, {
			method: init.method ?? 'GET',
			headers,
			body: init.body,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
		init.signal?.removeEventListener('abort', onAbort);
	}
}
