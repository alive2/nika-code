/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IIndexingSchemeManager } from '../../../platform/workspaceChunkSearch/common/indexingScheme';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { NikaSettingsEditor } from './nikaSettingsEditor';

const indexingStatusBarItemId = 'nika.indexingStatus';

/**
 * Status bar item for the Nika indexing scheme (Cursor-style "Indexing…"
 * indicator). Clicking opens Nika Settings on the `indexing` section.
 *
 * It is only visible while a scheme that produces local progress (`local`) is
 * active; the `off` and `github-remote` schemes keep the existing Copilot
 * status surface.
 */
export class NikaIndexingStatus extends Disposable {
	/**
	 * State changes fire frequently while a build is embedding files (every 25
	 * files). Re-rendering the status bar item on each one would re-create the
	 * `$(loading~spin)` codicon DOM node, which restarts its CSS animation and
	 * makes the spinner appear stuck. We coalesce renders to at most one per
	 * throttle window so the spinner gets to rotate smoothly between updates.
	 */
	private static readonly UPDATE_THROTTLE_MS = 1000;

	private readonly _statusItem: vscode.StatusBarItem;

	private _lastRender = 0;
	private _lastText = '';
	private _timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _settingsEditor: NikaSettingsEditor,
		@IIndexingSchemeManager private readonly _indexingSchemeManager: IIndexingSchemeManager,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._statusItem = vscode.window.createStatusBarItem(indexingStatusBarItemId, vscode.StatusBarAlignment.Right, 100);
		this._statusItem.name = vscode.l10n.t('Nika Indexing');

		this._register(vscode.commands.registerCommand('nika.openIndexingSettings', () => this._settingsEditor.open('indexing')));
		this._statusItem.command = 'nika.openIndexingSettings';

		this._register(this._indexingSchemeManager.onDidChangeState(() => this._scheduleUpdate()));
		this._register(toDisposable(() => {
			if (this._timer) {
				clearTimeout(this._timer);
				this._timer = undefined;
			}
		}));
		this._register(this._statusItem);
		this._scheduleUpdate();
	}

	private _scheduleUpdate(): void {
		if (this._timer) {
			// A render is already pending; coalesce this change into it.
			return;
		}
		const delay = Math.max(0, NikaIndexingStatus.UPDATE_THROTTLE_MS - (Date.now() - this._lastRender));
		this._timer = setTimeout(() => {
			this._timer = undefined;
			void this._render();
		}, delay);
	}

	private async _render(): Promise<void> {
		this._lastRender = Date.now();
		try {
			const scheme = this._indexingSchemeManager.id;
			if (scheme !== 'local') {
				this._statusItem.hide();
				return;
			}
			const state = await this._indexingSchemeManager.getState();
			let text: string;
			let tooltip: string;
			let showProgress: boolean | 'loading' | 'syncing' = false;
			switch (state.status) {
				case 'indexing':
				case 'building':
					showProgress = 'loading';
					text = `Nika Indexing ${state.indexedFileCount}/${state.totalFileCount}`;
					tooltip = vscode.l10n.t('Building the local semantic index...');
					break;
				case 'synced':
					text = `$(check) Nika Indexed ${state.indexedFileCount}`;
					tooltip = vscode.l10n.t('Local semantic index is up to date.');
					break;
				case 'error':
					text = `$(error) Nika Index Error`;
					tooltip = state.lastError ? vscode.l10n.t('Local indexing failed: {0}', state.lastError) : vscode.l10n.t('Local indexing failed.');
					break;
				default:
					text = `$(database) Nika Indexing Off`;
					tooltip = vscode.l10n.t('Click to open Nika indexing settings.');
					break;
			}
			// `showProgress` renders the spin codicon as one stable DOM node that is
			// created once and reused while `text` updates, so the animation keeps
			// spinning smoothly as the counter changes instead of restarting. Only
			// touch `.text` when it actually changed to avoid needless re-renders.
			this._statusItem.showProgress = showProgress;
			if (text !== this._lastText) {
				this._statusItem.text = text;
				this._lastText = text;
			}
			this._statusItem.tooltip = tooltip;
			this._statusItem.show();
		} catch (error) {
			this._logService.trace(`NikaIndexingStatus: failed to update status item: ${String(error)}`);
			this._statusItem.hide();
		}
	}
}
