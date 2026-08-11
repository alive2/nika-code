/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { NikaAttachmentProcessor } from '../nikaAttachments';

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
			{ secrets: { get: vi.fn() } } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[1],
			{ fetch: vi.fn(), makeAbortController: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[2],
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
			{ secrets: { get: vi.fn() } } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[1],
			{ fetch: vi.fn(), makeAbortController: vi.fn() } as unknown as ConstructorParameters<typeof NikaAttachmentProcessor>[2],
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
});
