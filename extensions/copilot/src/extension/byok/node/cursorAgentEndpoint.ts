/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { ChatCompletionContentPartKind } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import type { CancellationToken } from 'vscode';
import { ChatFetchResponseType, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ChatEndpoint } from '../../../platform/endpoint/node/chatEndpoint';
import { ILogService } from '../../../platform/log/common/logService';
import { IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { IChatWebSocketManager } from '../../../platform/networking/node/chatWebSocketManager';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CursorAgentRegistry, CursorModelVariant, CursorPromptImage, CursorRunCanceledError } from './cursorAgentClient';

/** Maximum number of prompt images the Cloud Agents API accepts. */
const MAX_PROMPT_IMAGES = 5;

/** The current user turn extracted from the rendered message list. */
export interface CursorTurnPrompt {
	readonly text: string;
	readonly images: CursorPromptImage[];
}

function dataUrlImage(part: Raw.ChatCompletionContentPart): CursorPromptImage | undefined {
	if (part.type !== ChatCompletionContentPartKind.Image) {
		return undefined;
	}
	const url = part.imageUrl?.url;
	if (typeof url !== 'string' || !url.startsWith('data:image/')) {
		return undefined;
	}
	const commaIndex = url.indexOf(',');
	if (commaIndex < 0) {
		return undefined;
	}
	const meta = url.slice(0, commaIndex);
	const mime = meta.slice('data:'.length, meta.indexOf(';') >= 0 ? meta.indexOf(';') : undefined);
	return { mimeType: mime || 'image/png', data: url.slice(commaIndex + 1) };
}

/**
 * A chat endpoint that talks to Cursor's Cloud Agents API. Cursor removed
 * its OpenAI-compatible chat-completions route; the replacement is a
 * conversation agent per chat session: the current user turn becomes a run
 * on that agent (`POST /v1/agents` for the first turn, `POST …/runs` for
 * follow-ups) and the run's SSE stream (`assistant` deltas, `result`)
 * becomes the LM response. The agent keeps its own memory, so only the
 * current user message is sent — replaying the whole transcript would
 * double every turn's context inside the agent.
 *
 * The run's tool calls execute inside Cursor's sandbox and are not surfaced
 * as VS Code tool calls; the model therefore advertises no tool-calling
 * capability and the VS Code chat loop runs text-only with these models.
 */
export class CursorAgentEndpoint extends ChatEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		private readonly _apiKey: string,
		private readonly _sessionKey: string | undefined,
		private readonly _variants: readonly CursorModelVariant[],
		private readonly _registry: CursorAgentRegistry,
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
	}

	/**
	 * The current user turn: the last user message with any content, plus up
	 * to {@link MAX_PROMPT_IMAGES} base64 images from it. Tool/assistant
	 * transcripts are intentionally dropped — the Cursor agent keeps its own
	 * conversation memory server-side.
	 */
	private _buildPrompt(messages: Raw.ChatMessage[]): CursorTurnPrompt {
		const images: CursorPromptImage[] = [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== Raw.ChatRole.User) {
				continue;
			}
			const textParts: string[] = [];
			for (const part of message.content) {
				if (part.type === ChatCompletionContentPartKind.Text) {
					textParts.push(part.text);
				} else {
					const image = dataUrlImage(part);
					if (image && images.length < MAX_PROMPT_IMAGES) {
						images.push(image);
					}
				}
			}
			const text = textParts.join('').trim();
			if (text || images.length > 0) {
				return {
					// The API requires prompt text; a pure-image prompt gets a
					// neutral instruction instead of an empty string.
					text: text || 'Analyze the attached image(s).',
					images,
				};
			}
		}
		throw new Error('The request contained no user message to send to Cursor.');
	}

	override async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		const requestId = `nika-cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		try {
			const { text, images } = this._buildPrompt(options.messages ?? []);
			const reasoningEffort = options.modelCapabilities?.reasoningEffort;
			const finishedCb = options.finishedCb;
			let fullText = '';
			const result = await this._registry.runTurn({
				apiKey: this._apiKey,
				modelId: this.model,
				variants: this._variants,
				reasoningEffort,
				sessionKey: this._sessionKey,
				prompt: text,
				images,
				onAssistantDelta: (delta) => {
					fullText += delta;
					if (finishedCb) {
						// A non-undefined return stops the stream (matching the
						// ChatML fetcher contract); the run itself cannot be
						// stopped mid-flight, so the returned value is ignored.
						void finishedCb(fullText, 0, { text: delta });
					}
				},
				token,
			});
			if (!result.text && fullText) {
				return {
					type: ChatFetchResponseType.Success,
					value: fullText,
					requestId,
					serverRequestId: undefined,
					usage: undefined,
					resolvedModel: this.model,
				};
			}
			return {
				type: ChatFetchResponseType.Success,
				value: result.text || fullText,
				requestId,
				serverRequestId: undefined,
				usage: undefined,
				resolvedModel: this.model,
			};
		} catch (error) {
			if (token.isCancellationRequested || error instanceof CursorRunCanceledError) {
				return {
					type: ChatFetchResponseType.Canceled,
					reason: 'Canceled',
					requestId,
					serverRequestId: undefined,
				};
			}
			const reason = error instanceof Error ? error.message : String(error);
			this.logService.error(`Cursor request failed: ${reason}`);
			return {
				type: ChatFetchResponseType.Failed,
				reason,
				requestId,
				serverRequestId: undefined,
			};
		}
	}
}
