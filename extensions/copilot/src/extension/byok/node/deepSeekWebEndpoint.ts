/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { ChatFetchResponseType, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ChatEndpoint } from '../../../platform/endpoint/node/chatEndpoint';
import { ILogService } from '../../../platform/log/common/logService';
import { IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { Raw } from '@vscode/prompt-tsx';
import { ChatCompletionContentPartKind } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IChatWebSocketManager } from '../../../platform/networking/node/chatWebSocketManager';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { DeepSeekWebClient, DeepSeekWebModelType } from './deepSeekWebClient';

/**
 * Resolves (creating on first use) the web chat session id for a Nika chat
 * session key, so all requests of one chat reuse the same DeepSeek session.
 */
export interface DeepSeekWebSessionCache {
	getOrCreate(key: string): Promise<string>;
}

/** Builds the flattened prompt text for a message list. */
export interface DeepSeekWebPrompt {
	readonly prompt: string;
	/** File ids of uploaded images, for `ref_file_ids` (vision). */
	readonly refFileIds: string[];
}

function imageDataUrl(part: Raw.ChatCompletionContentPart): string | undefined {
	if (part.type !== ChatCompletionContentPartKind.Image) {
		return undefined;
	}
	const url = part.imageUrl?.url;
	return typeof url === 'string' && url.startsWith('data:') ? url : undefined;
}

/**
 * A chat endpoint that talks to DeepSeek's unofficial web chat API
 * (chat.deepseek.com). Unlike the OpenAI-compatible endpoints, it cannot
 * reuse the ChatML fetcher: requests need the webapp auth token, a solved
 * proof-of-work challenge, and the response arrives as a JSON-patch SSE
 * stream. `makeChatRequest2` implements that flow end-to-end.
 */
export class DeepSeekWebEndpoint extends ChatEndpoint {
	private readonly _modelId: string;

	constructor(
		modelMetadata: IChatModelInformation,
		private readonly _client: DeepSeekWebClient,
		private readonly _sessionCache: DeepSeekWebSessionCache,
		private readonly _sessionKey: string,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@IChatWebSocketManager chatWebSocketService: IChatWebSocketManager,
		@ILogService protected readonly logService: ILogService,
	) {
		super(
			modelMetadata,
			domainService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			expService,
			chatWebSocketService,
			logService,
		);
		this._modelId = modelMetadata.id;
	}

	/**
	 * The webapp model mode for this endpoint, derived from the model id:
	 * `deepseek-chat` is the "Instant" radio, `deepseek-expert` the "Expert"
	 * radio, `deepseek-vision` the "Vision" radio.
	 */
	private _webModelType(): DeepSeekWebModelType {
		const id = this._modelId;
		if (id.endsWith('deepseek-expert')) {
			return 'expert';
		}
		if (id.endsWith('deepseek-vision')) {
			return 'vision';
		}
		return 'default';
	}

	/**
	 * Flattens the message list into a plain-text transcript the web API can
	 * follow, uploading any image parts so they become `ref_file_ids`.
	 */
	private async _buildPrompt(messages: Raw.ChatMessage[]): Promise<DeepSeekWebPrompt> {
		const parts: string[] = [];
		const refFileIds: string[] = [];
		let imageIndex = 0;
		const modelType = this._webModelType();
		for (const message of messages) {
			const role = message.role === Raw.ChatRole.System ? 'System'
				: message.role === Raw.ChatRole.Assistant ? 'Assistant'
					: message.role === Raw.ChatRole.Tool ? 'Tool' : 'User';
			// Content is always a part array in this prompt-tsx version; a
			// message without any text or images contributes nothing.
			const textParts: string[] = [];
			for (const part of message.content) {
				const dataUrl = imageDataUrl(part);
				if (dataUrl) {
					if (modelType === 'expert') {
						// The webapp's Expert mode does not accept file uploads.
						throw new Error('DeepSeek Web Expert mode does not accept images; use the Chat or Vision model instead.');
					}
					const commaIndex = dataUrl.indexOf(',');
					const mime = commaIndex > 0 ? dataUrl.slice(5, dataUrl.indexOf(';')) : 'image/png';
					const bytes = Buffer.from(dataUrl.slice(commaIndex + 1), 'base64');
					const extension = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'png';
					imageIndex += 1;
					const fileId = await this._client.uploadFile(bytes, `image-${imageIndex}.${extension}`, mime);
					refFileIds.push(fileId);
					textParts.push(`[Image ${imageIndex}]`);
				} else if (part.type === ChatCompletionContentPartKind.Text) {
					textParts.push(part.text);
				} else if (part.type === ChatCompletionContentPartKind.Document) {
					// Nika converts PDFs to text before this endpoint is reached;
					// anything still here cannot be sent to the web API.
					textParts.push('[Document]');
				}
			}
			const text = textParts.join('').trim();
			if (text) {
				parts.push(`${role}: ${text}`);
			}
		}
		return { prompt: parts.join('\n\n'), refFileIds };
	}

	override async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		const requestId = `nika-deepseek-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const messages = options.messages ?? [];
		let fullText = '';
		try {
			const { prompt, refFileIds } = await this._buildPrompt(messages);
			const chatSessionId = await this._sessionCache.getOrCreate(this._sessionKey);
			const reasoningEffort = options.modelCapabilities?.reasoningEffort;
			// The web API only has a boolean thinking toggle; map the Nika
			// effort levels onto it (anything but `none` thinks).
			const thinkingEnabled = reasoningEffort !== 'none';
			const finishedCb = options.finishedCb;
			for await (const chunk of this._client.streamCompletion({
				chatSessionId,
				prompt,
				thinkingEnabled,
				refFileIds,
				modelType: this._webModelType(),
			}, token)) {
				fullText += chunk;
				if (finishedCb) {
					// A non-undefined return stops the stream (matching the
					// ChatML fetcher contract).
					const stop = await finishedCb(fullText, 0, { text: chunk });
					if (stop !== undefined) {
						break;
					}
				}
			}
			return {
				type: ChatFetchResponseType.Success,
				value: fullText,
				requestId,
				serverRequestId: undefined,
				usage: undefined,
				resolvedModel: this.model,
			};
		} catch (error) {
			if (token.isCancellationRequested) {
				return {
					type: ChatFetchResponseType.Canceled,
					reason: 'Canceled',
					requestId,
					serverRequestId: undefined,
				};
			}
			const reason = error instanceof Error ? error.message : String(error);
			this.logService.error(`DeepSeek web request failed: ${reason}`);
			return {
				type: ChatFetchResponseType.Failed,
				reason,
				requestId,
				serverRequestId: undefined,
			};
		}
	}
}
