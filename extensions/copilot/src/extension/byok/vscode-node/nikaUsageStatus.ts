/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { formatCost, formatDuration, formatTokenCount, getDeepSeekRatePeriod } from './nikaPricing';
import { NikaSettingsEditor } from './nikaSettingsEditor';
import { NikaUsageTracker } from './nikaUsageTracker';

const usageStatusBarItemId = 'nika.usageStatus';

/**
 * Status bar item for Nika DeepSeek token usage. While a response streams it
 * shows a live token counter; when idle it shows today's totals plus the
 * current DeepSeek rate period (PEAK / OFF-PEAK). Clicking opens Nika Settings
 * on the `usage` section.
 */
export class NikaUsageStatus extends Disposable {
	/**
	 * Live token counters update on every streamed chunk. Coalesce renders so
	 * the stable `showProgress` spinner keeps spinning smoothly.
	 */
	private static readonly UPDATE_THROTTLE_MS = 250;
	/** How often the idle rate-period countdown refreshes. */
	private static readonly COUNTDOWN_REFRESH_MS = 30_000;

	private readonly _statusItem: vscode.StatusBarItem;

	private _lastRender = 0;
	private _lastText = '';
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _countdownTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly _settingsEditor: NikaSettingsEditor,
		private readonly _usageTracker: NikaUsageTracker,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._statusItem = vscode.window.createStatusBarItem(usageStatusBarItemId, vscode.StatusBarAlignment.Right, 99);
		this._statusItem.name = vscode.l10n.t('Nika Usage');

		this._register(vscode.commands.registerCommand('nika.openUsageSettings', () => this._settingsEditor.open('usage')));
		this._statusItem.command = 'nika.openUsageSettings';

		this._register(this._usageTracker.onDidChange(() => this._scheduleUpdate()));
		this._register(toDisposable(() => {
			if (this._timer) {
				clearTimeout(this._timer);
				this._timer = undefined;
			}
			if (this._countdownTimer) {
				clearInterval(this._countdownTimer);
				this._countdownTimer = undefined;
			}
		}));
		// Keep the idle rate-period countdown fresh even when no events change.
		this._countdownTimer = setInterval(() => this._scheduleUpdate(), NikaUsageStatus.COUNTDOWN_REFRESH_MS);
		this._register(this._statusItem);
		this._scheduleUpdate();
	}

	private _scheduleUpdate(): void {
		if (this._timer) {
			// A render is already pending; coalesce this change into it.
			return;
		}
		const delay = Math.max(0, NikaUsageStatus.UPDATE_THROTTLE_MS - (Date.now() - this._lastRender));
		this._timer = setTimeout(() => {
			this._timer = undefined;
			this._render();
		}, delay);
	}

	private _render(): void {
		this._lastRender = Date.now();
		try {
			if (!this._usageTracker.enabled) {
				this._statusItem.hide();
				return;
			}

			const liveCount = this._usageTracker.liveStreamCount;
			if (liveCount > 0) {
				const estimate = this._usageTracker.liveTokenEstimate;
				// `showProgress` renders the spin codicon as one stable DOM node
				// reused across text updates, so the animation keeps spinning.
				this._statusItem.showProgress = 'loading';
				this._setText(`Nika ${formatTokenCount(estimate)} tok`);
				this._statusItem.tooltip = vscode.l10n.t('Nika tokens streaming ({0} active request{1})...', liveCount, liveCount === 1 ? '' : 's');
				this._statusItem.show();
				return;
			}

			this._statusItem.showProgress = false;
			const totals = todayTotals(this._usageTracker);
			const rate = getDeepSeekRatePeriod();
			const countdown = formatDuration(rate.endsAt - Date.now());
			const rateLabel = rate.peak
				? `PEAK · ${countdown} left`
				: `OFF-PEAK · ${countdown} to PEAK`;
			this._setText(`$(pulse) Nika today ${formatTokenCount(totals.totalTokens)} tok · ${formatCost(totals.cost)} · ${rateLabel}`);
			this._statusItem.tooltip = vscode.l10n.t('Nika DeepSeek token usage today. Click to open the usage dashboard.');
			this._statusItem.show();
		} catch (error) {
			this._logService.trace(`NikaUsageStatus: failed to update status item: ${String(error)}`);
			this._statusItem.hide();
		}
	}

	private _setText(text: string): void {
		if (text !== this._lastText) {
			this._statusItem.text = text;
			this._lastText = text;
		}
	}
}

/** Local-day totals for the status bar's idle state. */
function todayTotals(tracker: NikaUsageTracker): { totalTokens: number; cost: number } {
	const now = new Date();
	let totalTokens = 0;
	let cost = 0;
	for (const event of tracker.events) {
		const d = new Date(event.t);
		if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
			totalTokens += event.totalTokens;
			cost += event.cost;
		}
	}
	return { totalTokens, cost };
}
