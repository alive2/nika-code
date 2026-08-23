/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BYOKKnownModels, BYOKModelCapabilities, resolveModelInfo, resolveModelTokenLimits } from '../common/byokProvider';
import { NIKA_DEEPSEEK_WEB_MODEL_PREFIX, NIKA_PROVIDER_NAME } from './nikaModels';
import { DeepSeekWebClient } from '../node/deepSeekWebClient';
import { DeepSeekWebEndpoint } from '../node/deepSeekWebEndpoint';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';

/** Context window and output ceiling for the web chat models. */
const DEEP_SEEK_WEB_CONTEXT_WINDOW = 128_000;
const DEEP_SEEK_WEB_MAX_OUTPUT_TOKENS = 8_000;

/** How long an idle web chat session is kept before it is dropped. */
const WEB_SESSION_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

interface WebSessionEntry {
	readonly sessionId: string;
	lastUsedAt: number;
}

/**
 * DeepSeek web chat (chat.deepseek.com) support for the Nika provider group.
 *
 * The web API is not OpenAI-compatible, so instead of a catalog + endpoint
 * pair this provider owns a {@link DeepSeekWebClient} (auth token, PoW
 * solving, SSE parsing) and hands out {@link DeepSeekWebEndpoint} instances
 * that speak the web protocol directly. One web chat session is created per
 * Nika chat session key and reused across requests of that chat.
 */
export class NikaDeepSeekWebProvider extends Disposable {
	private readonly _clients = new Map<string, DeepSeekWebClient>();
	private readonly _sessions = new Map<string, WebSessionEntry>();

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

/**
 * The web chat models exposed through the Nika group, mirroring the three
 * radios on chat.deepseek.com: Instant (`model_type: default`), Expert
 * (`model_type: expert`; no file uploads), and Vision (`model_type: vision`;
 * image understanding). DeepThink is the thinking toggle, which Nika controls
 * through the reasoning-effort setting instead of a model choice.
 */
getKnownModels(): BYOKKnownModels {
	const limits = resolveModelTokenLimits({
		contextWindow: DEEP_SEEK_WEB_CONTEXT_WINDOW,
		maxInputTokens: DEEP_SEEK_WEB_CONTEXT_WINDOW - DEEP_SEEK_WEB_MAX_OUTPUT_TOKENS,
		maxOutputTokens: DEEP_SEEK_WEB_MAX_OUTPUT_TOKENS,
	});
	const base: Omit<BYOKModelCapabilities, 'name' | 'vision'> = {
		contextWindow: limits.contextWindow,
		maxInputTokens: limits.maxInputTokens,
		maxOutputTokens: limits.maxOutputTokens,
		// The web API has no tool-calling surface; agents fall back to
		// text-only conversation with this model.
		toolCalling: false,
		thinking: true,
	};
	return {
		[NIKA_DEEPSEEK_WEB_MODEL_PREFIX + 'deepseek-chat']: {
			...base,
			name: 'DeepSeek Web (Instant)',
			// Images are uploaded to DeepSeek's servers and analyzed natively.
			vision: true,
		},
		[NIKA_DEEPSEEK_WEB_MODEL_PREFIX + 'deepseek-expert']: {
			...base,
			name: 'DeepSeek Web (Expert)',
			// Expert mode accepts no file uploads on the webapp.
			vision: false,
		},
		[NIKA_DEEPSEEK_WEB_MODEL_PREFIX + 'deepseek-vision']: {
			...base,
			name: 'DeepSeek Web (Vision)',
			vision: true,
		},
	};
}

	/**
	 * Builds a chat endpoint for a web model id. The token is required (the
	 * webapp's `userToken`); an invalid one fails the first request with a
	 * clear error.
	 */
	createEndpoint(modelId: string, token: string, sessionKey: string | undefined): DeepSeekWebEndpoint {
		const capabilities = this.getKnownModels()[modelId];
		const modelInfo = resolveModelInfo(modelId, NIKA_PROVIDER_NAME, { [modelId]: capabilities });
		const client = this._clientFor(token);
		const cacheKey = sessionKey ?? '__default__';
		return this._instantiationService.createInstance(DeepSeekWebEndpoint, modelInfo, client, {
			getOrCreate: (key: string) => this._getOrCreateSession(client, key),
		}, cacheKey);
	}

	/** Drops cached clients and sessions (e.g. after the token changed). */
	invalidateCache(): void {
		this._clients.clear();
		this._sessions.clear();
	}

	/**
	 * Describes an image through the web vision model, used when a DeepSeek
	 * Web model is picked as the Nika image-description backend (the
	 * `nika.visionModel` setting). Uploads the image, streams one vision
	 * completion, and returns the trimmed answer.
	 */
	async describeImage(data: Uint8Array, mimeType: string, prompt: string, token: string): Promise<string> {
		const client = this._clientFor(token);
		const extension = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : mimeType.includes('gif') ? 'gif' : 'png';
		const fileId = await client.uploadFile(data, `vision-${Date.now()}.${extension}`, mimeType);
		// Descriptions share one web chat session so repeated image asks do not
		// create a new DeepSeek conversation every time.
		const sessionId = await this._getOrCreateSession(client, '__vision__');
		let text = '';
		for await (const chunk of client.streamCompletion({
			chatSessionId: sessionId,
			prompt,
			thinkingEnabled: true,
			refFileIds: [fileId],
			modelType: 'vision',
		}, CancellationToken.None)) {
			text += chunk;
		}
		const trimmed = text.trim();
		if (!trimmed) {
			throw new Error('DeepSeek Web vision returned no description.');
		}
		return trimmed;
	}


	private _clientFor(token: string): DeepSeekWebClient {
		let client = this._clients.get(token);
		if (!client) {
			client = new DeepSeekWebClient(token, this._fetcherService);
			this._clients.set(token, client);
		}
		return client;
	}

	private async _getOrCreateSession(client: DeepSeekWebClient, key: string): Promise<string> {
		const now = Date.now();
		const existing = this._sessions.get(key);
		if (existing) {
			existing.lastUsedAt = now;
			return existing.sessionId;
		}
		// Drop idle sessions so the cache cannot grow unbounded.
		for (const [k, entry] of this._sessions) {
			if (now - entry.lastUsedAt > WEB_SESSION_IDLE_TTL_MS) {
				this._sessions.delete(k);
			}
		}
		const sessionId = await client.createChatSession();
		this._sessions.set(key, { sessionId, lastUsedAt: now });
		return sessionId;
	}
}
