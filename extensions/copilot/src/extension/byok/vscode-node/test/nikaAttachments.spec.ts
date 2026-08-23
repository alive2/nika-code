/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { NikaAttachmentProcessor } from '../nikaAttachments';

vi.mock('vscode', async (importOriginal) => {
	const actual = await importOriginal<typeof import('vscode')>();
	// These are type-only exports in the test shim, so the spread below cannot
	// copy them — but `vscodeTypes.ts` re-exports them at module load, which
	// would throw on the mock's proxy. Define them explicitly (value is
	// `undefined`, but the property then exists).
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
		window: {
			showWarningMessage: vi.fn(),
		},
	};
});

/** Stub for the DeepSeek Web provider, which powers the `deepseekweb` vision backend. */
function deepSeekWebProviderStub(describeImage = vi.fn()): ConstructorParameters<typeof NikaAttachmentProcessor>[1] {
	return { describeImage } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[1];
}

describe('Nika attachment preprocessing', () => {
	it('replays a cached image description without calling a vision backend', async () => {
		const image = new Uint8Array([1, 2, 3, 4]);
		const hashBuffer = await crypto.subtle.digest('SHA-256', image);
		const hash = Array.from(new Uint8Array(hashBuffer)).map(value => value.toString(16).padStart(2, '0')).join('');
		const marker = new vscode.LanguageModelDataPart(
			new TextEncoder().encode(JSON.stringify({ hash, description: 'A professional purple and cyan Nika icon.' })),
			'application/vnd.nika.vision-replay+json',
		);
		const processor = new NikaAttachmentProcessor(
			{ log: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[0],
			deepSeekWebProviderStub(),
			{ secrets: { get: vi.fn() } } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[2],
			{ fetch: vi.fn(), makeAbortController: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[3],
		);
		const tokenSource = new vscode.CancellationTokenSource();
		const result = await processor.process([
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [marker]),
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [vscode.LanguageModelDataPart.image(image, 'image/png')]),
		], tokenSource.token);

		const text = result.messages[1].content.find(part => part instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart;
		expect(text.value).toContain('A professional purple and cyan Nika icon.');
		expect(result.replayMarkers).toHaveLength(0);
	});

	it('omits an old image when no safe replay exists', async () => {
		const log = vi.fn();
		const processor = new NikaAttachmentProcessor(
			{ log } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[0],
			deepSeekWebProviderStub(),
			{ secrets: { get: vi.fn() } } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[2],
			{ fetch: vi.fn(), makeAbortController: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[3],
		);
		const result = await processor.process([
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [vscode.LanguageModelDataPart.image(new Uint8Array([9]), 'image/png')]),
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, 'Earlier response'),
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Continue without the old image'),
		], new vscode.CancellationTokenSource().token);
		const text = result.messages[0].content[0] as vscode.LanguageModelTextPart;
		expect(text.value).toContain('older image was omitted');
		expect(log).toHaveBeenCalled();
	});

	it('passes images through untouched when preserveImages is set (llama.cpp)', async () => {
		const secrets = { get: vi.fn() };
		const fetch = vi.fn();
		const processor = new NikaAttachmentProcessor(
			{ log: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[0],
			deepSeekWebProviderStub(),
			{ secrets } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[2],
			{ fetch, makeAbortController: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[3],
		);
		const image = new Uint8Array([1, 2, 3]);
		const result = await processor.process([
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [vscode.LanguageModelDataPart.image(image, 'image/png')]),
		], new vscode.CancellationTokenSource().token, { preserveImages: true });

		// The image stays a native data part: no vision backend was called and
		// no text replacement (or replay marker) was produced.
		const part = result.messages[0].content[0];
		expect(part).toBeInstanceOf(vscode.LanguageModelDataPart);
		expect((part as vscode.LanguageModelDataPart).mimeType).toBe('image/png');
		expect(result.messages[0].content).toHaveLength(1);
		expect(result.replayMarkers).toHaveLength(0);
		expect(secrets.get).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('Nika OpenRouter vision', () => {
	it('describes an image through the OpenRouter vision endpoint', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'A purple icon with a lightning bolt.' } }] }) });
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: (key: string, fallback: unknown) => {
				if (key === 'visionModel') { return 'openrouter'; }
				if (key === 'visionOpenRouterModel') { return 'google/gemini-2.5-flash'; }
				return fallback;
			},
		} as never);
		const processor = new NikaAttachmentProcessor(
			{ log: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[0],
			deepSeekWebProviderStub(),
			{ secrets: { get: vi.fn().mockResolvedValue('sk-or-1') } } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[2],
			{ fetch: fetchMock, makeAbortController: vi.fn(() => ({ abort: vi.fn() })) } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[3],
		);
		const image = new Uint8Array([1, 2, 3]);
		const result = await processor.process([
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [vscode.LanguageModelDataPart.image(image, 'image/png')]),
		], new vscode.CancellationTokenSource().token);

		const text = result.messages[0].content.find(part => part instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart;
		expect(text.value).toContain('A purple icon with a lightning bolt.');
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
		const body = JSON.parse(init.body);
		expect(body.model).toBe('google/gemini-2.5-flash');
		expect(body.max_tokens).toBe(512);
		expect(body.messages[0].content[0]).toEqual({ type: 'text', text: expect.stringContaining('Describe this image precisely') });
		expect(body.messages[0].content[1].type).toBe('image_url');
		expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
		expect(init.headers.Authorization).toBe('Bearer sk-or-1');
		expect(init.callSite).toBe('nika-openrouter-vision');
	});

	it('falls back to a placeholder when the OpenRouter vision model is not configured', async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: (key: string, fallback: unknown) => key === 'visionModel' ? 'openrouter' : fallback,
		} as never);
		const showWarningMessage = vi.fn();
		vi.mocked(vscode.window.showWarningMessage).mockImplementation(showWarningMessage);
		const processor = new NikaAttachmentProcessor(
			{ log: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[0],
			deepSeekWebProviderStub(),
			{ secrets: { get: vi.fn().mockResolvedValue('sk-or-1') } } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[2],
			{ fetch: vi.fn(), makeAbortController: vi.fn(() => ({ abort: vi.fn() })) } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[3],
		);

		const result = await processor.process([
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [vscode.LanguageModelDataPart.image(new Uint8Array([9]), 'image/png')]),
		], new vscode.CancellationTokenSource().token);

		const text = result.messages[0].content[0] as vscode.LanguageModelTextPart;
		expect(text.value).toContain('Image processing failed');
		expect(showWarningMessage).toHaveBeenCalled();
	});
});

describe('Nika DeepSeek Web vision', () => {
	it('describes an image through the DeepSeek Web provider using the stored token', async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: (key: string, fallback: unknown) => key === 'visionModel' ? 'nika/deepseekweb/deepseek-vision' : fallback,
		} as never);
		const describeImage = vi.fn().mockResolvedValue('A cat sitting on a keyboard.');
		const secrets = { get: vi.fn().mockResolvedValue('web-token-1') };
		const processor = new NikaAttachmentProcessor(
			{ log: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[0],
			deepSeekWebProviderStub(describeImage),
			{ secrets } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[2],
			{ fetch: vi.fn(), makeAbortController: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[3],
		);

		const image = new Uint8Array([7, 8, 9]);
		const result = await processor.process([
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [vscode.LanguageModelDataPart.image(image, 'image/png')]),
		], new vscode.CancellationTokenSource().token);

		const text = result.messages[0].content.find(part => part instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart;
		expect(text.value).toContain('A cat sitting on a keyboard.');
		expect(secrets.get).toHaveBeenCalledWith('nika.deepseekWeb.token');
		expect(describeImage).toHaveBeenCalledWith(image, 'image/png', expect.any(String), 'web-token-1');
	});

	it('fails loudly when no DeepSeek Web token is stored', async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: (key: string, fallback: unknown) => key === 'visionModel' ? 'nika/deepseekweb/deepseek-vision' : fallback,
		} as never);
		const showWarningMessage = vi.fn();
		vi.mocked(vscode.window.showWarningMessage).mockImplementation(showWarningMessage);
		const processor = new NikaAttachmentProcessor(
			{ log: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[0],
			deepSeekWebProviderStub(),
			{ secrets: { get: vi.fn().mockResolvedValue(undefined) } } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[2],
			{ fetch: vi.fn(), makeAbortController: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[3],
		);

		const result = await processor.process([
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [vscode.LanguageModelDataPart.image(new Uint8Array([3]), 'image/png')]),
		], new vscode.CancellationTokenSource().token);

		const text = result.messages[0].content[0] as vscode.LanguageModelTextPart;
		expect(text.value).toContain('Image processing failed');
		expect(showWarningMessage).toHaveBeenCalled();
	});
});
