/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { IChatOutputRendererService } from '../chatOutputItemRenderer.js';

/**
 * Builds a `codeBlockRendererSync` hook for `IMarkdownRendererService.render()`
 * that renders code fences with a registered chat output renderer (e.g.
 * mermaid) into an asynchronously-filled webview container. Code blocks
 * without a renderer fall back to the default escaped code block by returning
 * `undefined` (the markdown renderer keeps its placeholder content).
 *
 * `getSessionResource` supplies the chat session resource required by the
 * output renderer; when it is undefined the renderer is skipped.
 */
export function createPlanCodeBlockRenderer(
	chatOutputRendererService: IChatOutputRendererService,
	getSessionResource: () => URI | undefined,
	disposeStore: DisposableStore,
	onHeightChange?: () => void,
): (languageId: string, text: string, raw?: string) => HTMLElement {
	return (languageId, text) => {
		if (!languageId || !chatOutputRendererService.hasCodeBlockRenderer(languageId)) {
			// Fall back to the default code block rendering.
			return undefined as unknown as HTMLElement;
		}
		const sessionResource = getSessionResource();
		if (!sessionResource) {
			return undefined as unknown as HTMLElement;
		}

		const container = dom.$('div.plan-view-rendered-code-block');
		const progress = dom.append(container, dom.$('span.plan-view-rendered-code-block-progress'));
		progress.textContent = localize('chat.planView.renderingCodeBlock', 'Rendering {0}…', languageId);

		const cts = new CancellationTokenSource();
		disposeStore.add(toDisposable(() => cts.dispose(true)));

		chatOutputRendererService.renderCodeBlock(
			languageId,
			new TextEncoder().encode(text),
			container,
			{
				title: localize('chat.planView.renderedCodeBlock', 'Rendered {0} diagram', languageId),
				chatSessionResource: sessionResource,
			},
			cts.token
		).then(rendered => {
			if (cts.token.isCancellationRequested) {
				rendered.dispose();
				return;
			}
			progress.remove();
			disposeStore.add(rendered);
			disposeStore.add(rendered.onDidChangeHeight(() => onHeightChange?.()));
		}, error => {
			if (isCancellationError(error)) {
				return;
			}
			progress.textContent = localize('chat.planView.codeBlockRenderError', 'Could not render {0} diagram', languageId);
			onHeightChange?.();
		});

		return container;
	};
}
