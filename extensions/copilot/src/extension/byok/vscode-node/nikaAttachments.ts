/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { createSha256Hash } from '../../../util/common/crypto';
import { detectPdfPageRange, extractPdfText, hasPdfMagicBytes, isPdfMime } from '../node/nikaPdf';
import { NIKA_CURSOR_SECRET, NIKA_GEMINI_SECRET, NIKA_LLAMACPP_SECRET, NIKA_OPENROUTER_SECRET, getNikaModelProvider } from './nikaModels';
import { CURSOR_BASE_URL } from './nikaCursorProvider';
import { NikaSettingsEditor } from './nikaSettingsEditor';

const NIKA_VISION_REPLAY_MIME = 'application/vnd.nika.vision-replay+json';

interface VisionReplayMarker {
	readonly hash: string;
	readonly description: string;
}

export interface NikaAttachmentResult {
	readonly messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>;
	readonly replayMarkers: vscode.LanguageModelDataPart[];
}

export interface NikaAttachmentProcessOptions {
	/**
	 * When true, image parts pass through untouched as native data parts
	 * (used for multimodal llama.cpp models). Only PDFs are converted to
	 * text. Default: false (all media converted to text for text-only
	 * models).
	 */
	readonly preserveImages?: boolean;
}

/** Converts media attachments into deterministic text for DeepSeek. */
export class NikaAttachmentProcessor {
	private readonly _visionCache = new Map<string, string>();

	constructor(
		private readonly _settingsEditor: NikaSettingsEditor,
		@IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext,
		@IFetcherService private readonly _fetcherService: IFetcherService,
	) { }

	async process(messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>, token: vscode.CancellationToken, options: NikaAttachmentProcessOptions = {}): Promise<NikaAttachmentResult> {
		// `None (native vision)` passes images through untouched; otherwise the
		// caller decides (llama.cpp/Cursor preserve, the rest describe).
		const preserveImages = options.preserveImages ?? (vscode.workspace.getConfiguration('nika').get<string>('visionModel', 'gemini-2.5-flash') === 'none');
		const pdfCount = messages.reduce((count, message) => count + message.content.filter(part => part instanceof vscode.LanguageModelDataPart && isPdfMime(part.mimeType)).length, 0);
		if (pdfCount > 0) {
			this._settingsEditor.log('INFO', vscode.l10n.t('Received {0} PDF attachment(s) for Nika preprocessing.', pdfCount));
		}
		const replay = this._readReplayMarkers(messages);
		const lastUserIndex = messages.reduce((last, message, index) => message.role === vscode.LanguageModelChatMessageRole.User ? index : last, -1);
		const pageRequest = this._messageText(messages[lastUserIndex]);
		const generatedMarkers: vscode.LanguageModelDataPart[] = [];
		const result: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2> = [];

		for (let index = 0; index < messages.length; index++) {
			this._throwIfCancelled(token);
			const message = messages[index];
			const content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart | vscode.LanguageModelThinkingPart> = [];
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelDataPart) {
					if (part.mimeType === NIKA_VISION_REPLAY_MIME) {
						continue;
					}
					if (part.mimeType.startsWith('image/')) {
						if (preserveImages) {
							content.push(part);
							continue;
						}
						const replacement = await this._imageToText(part, index === lastUserIndex, replay, generatedMarkers, token);
						if (replacement) { content.push(replacement); }
						continue;
					}
					if (isPdfMime(part.mimeType)) {
						content.push(new vscode.LanguageModelTextPart(await this._pdfToText(part, pageRequest, token)));
						continue;
					}
				}
				if (part instanceof vscode.LanguageModelToolResultPart) {
					content.push(await this._processToolResult(part, index === lastUserIndex, pageRequest, replay, generatedMarkers, token, { ...options, preserveImages }));
					continue;
				}
				content.push(part);
			}
			// LanguageModelChatMessage2 is proposed and is not present in every
			// extension-host runtime. The stable message class preserves unknown
			// parts (including thinking) even though its public type is narrower.
			result.push(new vscode.LanguageModelChatMessage(message.role, content as vscode.LanguageModelInputPart[], message.name));
		}

		return { messages: result, replayMarkers: generatedMarkers };
	}

	private async _processToolResult(part: vscode.LanguageModelToolResultPart, current: boolean, pageRequest: string, replay: Map<string, string>, markers: vscode.LanguageModelDataPart[], token: vscode.CancellationToken, options: NikaAttachmentProcessOptions): Promise<vscode.LanguageModelToolResultPart> {
		const content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart | unknown> = [];
		for (const item of part.content) {
			if (item instanceof vscode.LanguageModelDataPart && item.mimeType.startsWith('image/')) {
				if (options.preserveImages) {
					content.push(item);
				} else {
					const replacement = await this._imageToText(item, current, replay, markers, token);
					if (replacement) { content.push(replacement); }
				}
			} else if (item instanceof vscode.LanguageModelDataPart && isPdfMime(item.mimeType)) {
				content.push(new vscode.LanguageModelTextPart(await this._pdfToText(item, pageRequest, token)));
			} else if (!(item instanceof vscode.LanguageModelDataPart && item.mimeType === NIKA_VISION_REPLAY_MIME)) {
				content.push(item);
			}
		}
		return new vscode.LanguageModelToolResultPart(part.callId, content);
	}

	private async _imageToText(part: vscode.LanguageModelDataPart, current: boolean, replay: Map<string, string>, markers: vscode.LanguageModelDataPart[], token: vscode.CancellationToken): Promise<vscode.LanguageModelTextPart | undefined> {
		const hash = await createSha256Hash(part.data);
		let description = this._visionCache.get(hash) ?? replay.get(hash);
		if (!description && !current) {
			this._settingsEditor.log('WARN', vscode.l10n.t('Omitted an older image because no safe Nika replay description was available.'));
			return new vscode.LanguageModelTextPart(vscode.l10n.t('[An older image was omitted because no safe cached description was available.]'));
		}
		if (!description) {
			try {
				description = await this._describeMedia(part.data, part.mimeType, vscode.l10n.t('Describe this image precisely for another coding model. Include visible text, UI structure, errors, diagrams, and details relevant to the user request.'), token);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this._settingsEditor.log('ERROR', vscode.l10n.t('Image description failed: {0}', reason));
				void vscode.window.showWarningMessage(vscode.l10n.t('Nika could not process an attached image: {0}', reason));
				return new vscode.LanguageModelTextPart(vscode.l10n.t('[Image processing failed: {0}]', reason));
			}
			this._putVisionCache(hash, description);
			const marker: VisionReplayMarker = { hash, description };
			markers.push(vscode.LanguageModelDataPart.json(marker, NIKA_VISION_REPLAY_MIME));
		}
		return new vscode.LanguageModelTextPart(vscode.l10n.t('[Image description generated by Nika vision:\n{0}\n]', description));
	}

	private async _pdfToText(part: vscode.LanguageModelDataPart, pageRequest: string, token: vscode.CancellationToken): Promise<string> {
		try {
			return await this._extractPdfToText(part, pageRequest, token);
		} catch (error) {
			if (token.isCancellationRequested) {
				throw error;
			}
			const reason = error instanceof Error ? error.message : String(error);
			this._settingsEditor.log('ERROR', vscode.l10n.t('PDF extraction failed: {0}', reason));
			return vscode.l10n.t('[Attached PDF could not be processed: {0}\n]', reason);
		}
	}

	private async _extractPdfToText(part: vscode.LanguageModelDataPart, pageRequest: string, token: vscode.CancellationToken): Promise<string> {
		const config = vscode.workspace.getConfiguration('nika');
		const maxBytes = config.get<number>('pdfMaxFileSizeMB', 100) * 1024 * 1024;
		if (part.data.byteLength > maxBytes) {
			throw new Error(vscode.l10n.t('PDF exceeds the configured {0} MB limit.', config.get<number>('pdfMaxFileSizeMB', 100)));
		}
		if (!hasPdfMagicBytes(part.data)) {
			throw new Error(vscode.l10n.t('The attachment is not a valid PDF.'));
		}
		this._throwIfCancelled(token);
		const pageRange = detectPdfPageRange(pageRequest);
		const result = await extractPdfText(part.data, {
			pageRange,
			maxPages: pageRange ? undefined : config.get<number>('pdfMaxPages', 60),
		});
		this._throwIfCancelled(token);
		let visual = '';
		const sparseThreshold = config.get<number>('pdfSparseThreshold', 3000);
		if (config.get<boolean>('pdfSparseFallback', true) && result.text.length < sparseThreshold) {
			const geminiKey = await this._context.secrets.get(NIKA_GEMINI_SECRET);
			if (geminiKey) {
				try {
					visual = await this._describeWithGemini(part.data, 'application/pdf', vscode.l10n.t('Read this sparse or scanned PDF visually. Transcribe important text and describe tables, figures, page layout, and document meaning.'), 'gemini-2.5-flash', geminiKey, token);
				} catch (error) {
					this._settingsEditor.log('WARN', vscode.l10n.t('Gemini PDF visual fallback failed: {0}', error instanceof Error ? error.message : String(error)));
				}
			}
		}

		const extracted = result.text || vscode.l10n.t('No extractable text was found; this may be a scanned or image-only PDF.');
		const rangeLabel = pageRange ? vscode.l10n.t('Requested pages {0}-{1}.', pageRange.start, pageRange.end) : '';
		const truncation = result.truncated && config.get<boolean>('pdfPageNotice', true)
			? vscode.l10n.t('This PDF has {0} pages. Nika extracted {1}; ask for a specific page range to inspect other pages.', result.totalPages, result.pagesIncluded)
			: '';
		const visualText = visual ? vscode.l10n.t('\n\nVisual document description:\n{0}', visual) : '';
		this._settingsEditor.log('INFO', vscode.l10n.t('Extracted {0} PDF characters with {1}.', result.text.length, result.extractor));
		return vscode.l10n.t('[Attached PDF contents ({0})\n{1}\n{2}{3}\n]', rangeLabel, extracted, truncation, visualText);
	}

	private async _describeMedia(data: Uint8Array, mimeType: string, prompt: string, token: vscode.CancellationToken): Promise<string> {
		const config = vscode.workspace.getConfiguration('nika');
		const backend = config.get<string>('visionModel', 'gemini-2.5-flash');
		// Legacy route values from before the dynamic lineup: keep them working.
		if (backend === 'gemini-2.5-flash' || backend === 'gemini-2.5-flash-lite') {
			const key = await this._context.secrets.get(NIKA_GEMINI_SECRET);
			if (!key) { throw new Error(vscode.l10n.t('Configure a Gemini key for the selected vision backend.')); }
			return this._describeWithGemini(data, mimeType, prompt, backend, key, token);
		}
		if (backend === 'gemma4:31b') {
			return this._describeWithOllama(data, prompt, token, 'gemma4:31b');
		}
		if (backend === 'openrouter') {
			const model = config.get<string>('visionOpenRouterModel', '').trim();
			if (!model) { throw new Error(vscode.l10n.t('Choose an OpenRouter vision model in Nika Settings.')); }
			const key = await this._context.secrets.get(NIKA_OPENROUTER_SECRET);
			if (!key) { throw new Error(vscode.l10n.t('Configure an OpenRouter key for the selected vision backend.')); }
			return this._describeWithOpenRouter(data, mimeType, prompt, model, key, token);
		}
		// Model ids picked from the fetched provider lineups (`nika/…`). Route by
		// provider family so any vision-capable model the user selected in the
		// wizard can serve as the image-description backend.
		const provider = getNikaModelProvider(backend);
		if (provider) {
			const raw = backend.startsWith('nika/') ? backend.slice('nika/'.length) : backend;
			switch (provider) {
				case 'gemini': {
					const model = raw.startsWith('gemini/') ? raw.slice('gemini/'.length) : raw;
					const key = await this._context.secrets.get(NIKA_GEMINI_SECRET);
					if (!key) { throw new Error(vscode.l10n.t('Configure a Gemini key for the selected vision backend.')); }
					return this._describeWithGemini(data, mimeType, prompt, model, key, token);
				}
				case 'gemma':
					return this._describeWithOllama(data, prompt, token, 'gemma4:31b');
				case 'ollama': {
					const model = raw.slice('ollama/'.length);
					return this._describeWithOllama(data, prompt, token, model);
				}
				case 'openrouter': {
					const model = raw.slice('openrouter/'.length);
					const key = await this._context.secrets.get(NIKA_OPENROUTER_SECRET);
					if (!key) { throw new Error(vscode.l10n.t('Configure an OpenRouter key for the selected vision backend.')); }
					return this._describeWithOpenRouter(data, mimeType, prompt, model, key, token);
				}
				case 'llamacpp': {
					const model = raw.slice('llamacpp/'.length);
					const baseUrl = config.get<string>('llamaCppBaseUrl', 'http://localhost:8080').replace(/\/$/, '');
					const key = await this._context.secrets.get(NIKA_LLAMACPP_SECRET) ?? undefined;
					return this._describeWithChatCompletions(data, mimeType, prompt, model, key, `${baseUrl}/v1/chat/completions`, 'nika-llamacpp-vision', 'llama.cpp', token);
				}
				case 'cursor': {
					const model = raw.slice('cursor/'.length);
					const key = await this._context.secrets.get(NIKA_CURSOR_SECRET);
					if (!key) { throw new Error(vscode.l10n.t('Configure a Cursor key for the selected vision backend.')); }
					return this._describeWithChatCompletions(data, mimeType, prompt, model, key, `${CURSOR_BASE_URL}/v1/chat/completions`, 'nika-cursor-vision', 'Cursor', token);
				}
				case 'deepseek':
					break; // text-only models cannot describe images
			}
		}
		return this._describeWithVSCodeModel(data, mimeType, prompt, token);
	}

	private async _describeWithOpenRouter(data: Uint8Array, mimeType: string, prompt: string, model: string, key: string, token: vscode.CancellationToken): Promise<string> {
		return this._describeWithChatCompletions(data, mimeType, prompt, model, key, 'https://openrouter.ai/api/v1/chat/completions', 'nika-openrouter-vision', 'OpenRouter', token);
	}

	/** OpenAI-compatible chat-completions image description (OpenRouter, llama.cpp, Cursor). */
	private async _describeWithChatCompletions(data: Uint8Array, mimeType: string, prompt: string, model: string, key: string | undefined, url: string, callSite: string, label: string, token: vscode.CancellationToken): Promise<string> {
		const abort = this._fetcherService.makeAbortController();
		const subscription = token.onCancellationRequested(() => abort.abort());
		try {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (key) { headers.Authorization = `Bearer ${key}`; }
			const response = await this._fetcherService.fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					model,
					max_tokens: 512,
					messages: [{
						role: 'user',
						content: [
							{ type: 'text', text: prompt },
							{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${Buffer.from(data).toString('base64')}` } },
						],
					}],
				}),
				signal: abort.signal,
				callSite,
			});
			if (!response.ok) { throw new Error(vscode.l10n.t('{0} vision returned HTTP {1}.', label, response.status)); }
			const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
			const text = json.choices?.[0]?.message?.content?.trim();
			if (!text) { throw new Error(vscode.l10n.t('{0} vision returned no description.', label)); }
			return text;
		} finally {
			subscription.dispose();
		}
	}

	private async _describeWithGemini(data: Uint8Array, mimeType: string, prompt: string, model: string, key: string, token: vscode.CancellationToken): Promise<string> {
		const abort = this._fetcherService.makeAbortController();
		const subscription = token.onCancellationRequested(() => abort.abort());
		try {
			const response = await this._fetcherService.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
				body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: Buffer.from(data).toString('base64') } }] }] }),
				signal: abort.signal,
				callSite: 'nika-gemini-vision',
			});
			if (!response.ok) { throw new Error(vscode.l10n.t('Gemini vision returned HTTP {0}.', response.status)); }
			const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
			const text = json.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('').trim();
			if (!text) { throw new Error(vscode.l10n.t('Gemini vision returned no description.')); }
			return text;
		} finally {
			subscription.dispose();
		}
	}

	private async _describeWithOllama(data: Uint8Array, prompt: string, token: vscode.CancellationToken, model: string): Promise<string> {
		const abort = this._fetcherService.makeAbortController();
		const subscription = token.onCancellationRequested(() => abort.abort());
		try {
			const baseUrl = vscode.workspace.getConfiguration('nika').get<string>('ollamaBaseUrl', 'http://localhost:11434').replace(/\/$/, '');
			const response = await this._fetcherService.fetch(`${baseUrl}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt, images: [Buffer.from(data).toString('base64')] }] }),
				signal: abort.signal,
				callSite: 'nika-ollama-vision',
			});
			if (!response.ok) { throw new Error(vscode.l10n.t('Ollama vision returned HTTP {0}.', response.status)); }
			const json = await response.json() as { message?: { content?: string } };
			const text = json.message?.content?.trim();
			if (!text) { throw new Error(vscode.l10n.t('Ollama vision returned no description.')); }
			return text;
		} finally {
			subscription.dispose();
		}
	}

	private async _describeWithVSCodeModel(data: Uint8Array, mimeType: string, prompt: string, token: vscode.CancellationToken): Promise<string> {
		const identifier = vscode.workspace.getConfiguration('nika').get<string>('visionVSCodeModel', '').trim();
		if (!identifier) { throw new Error(vscode.l10n.t('Choose a VS Code vision model in Nika Settings.')); }
		const separator = identifier.indexOf('/');
		const selector = separator > 0 ? { vendor: identifier.slice(0, separator), id: identifier.slice(separator + 1) } : { id: identifier };
		const models = await vscode.lm.selectChatModels(selector);
		const selected = models.find(model => model.capabilities.supportsImageToText);
		if (!selected) { throw new Error(vscode.l10n.t('The configured VS Code model is unavailable or does not support images.')); }
		const response = await selected.sendRequest([
			vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(prompt), vscode.LanguageModelDataPart.image(data, mimeType)]),
		], {}, token);
		let text = '';
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) { text += part.value; }
		}
		if (!text.trim()) { throw new Error(vscode.l10n.t('The VS Code vision model returned no description.')); }
		return text.trim();
	}

	private _readReplayMarkers(messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>): Map<string, string> {
		const markers = new Map<string, string>();
		for (const message of messages) {
			for (const part of message.content) {
				if (!(part instanceof vscode.LanguageModelDataPart) || part.mimeType !== NIKA_VISION_REPLAY_MIME) { continue; }
				try {
					const marker = JSON.parse(new TextDecoder().decode(part.data)) as VisionReplayMarker;
					if (typeof marker.hash === 'string' && typeof marker.description === 'string') { markers.set(marker.hash, marker.description); }
				} catch { /* ignore malformed replay markers */ }
			}
		}
		return markers;
	}

	private _messageText(message: vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2 | undefined): string {
		return message?.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('\n') ?? '';
	}

	private _putVisionCache(hash: string, description: string): void {
		if (this._visionCache.size >= 128) {
			const oldest = this._visionCache.keys().next().value as string | undefined;
			if (oldest) { this._visionCache.delete(oldest); }
		}
		this._visionCache.set(hash, description);
	}

	private _throwIfCancelled(token: vscode.CancellationToken): void {
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
	}
}
