/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { formatCost, formatDuration, formatTokenCount, getDeepSeekRateCountdowns } from './nikaPricing';
import { NikaSettingsEditor } from './nikaSettingsEditor';
import { NikaUsageTracker } from './nikaUsageTracker';

const usageStatusBarItemId = 'nika.usageStatus';

/**
 * Status bar item for Nika. Shows how long the current DeepSeek rate period
 * lasts AND when the opposite rate starts (e.g. `PEAK 2h 13m · OFF-PEAK 1h 47m`).
 * Today's token totals and cost are available in the tooltip. Clicking opens
 * Nika Settings on the `usage` section.
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

			// Always render the rate-period countdowns: while streaming we add the
			// `showProgress` spinner, when idle we prepend the pulse icon.
			const rateLabel = countdownLabel();
			const liveCount = this._usageTracker.liveStreamCount;
			if (liveCount > 0) {
				// `showProgress` renders the spin codicon as one stable DOM node
				// reused across text updates, so the animation keeps spinning.
				this._statusItem.showProgress = 'loading';
				this._setText(rateLabel);
				this._statusItem.tooltip = vscode.l10n.t('Nika response streaming ({0} active request{1})... Click to open the usage dashboard.', liveCount, liveCount === 1 ? '' : 's');
				this._statusItem.show();
				return;
			}

			this._statusItem.showProgress = false;
			const totals = todayTotals(this._usageTracker);
			this._setText(`$(pulse) ${rateLabel}`);
			this._statusItem.tooltip = vscode.l10n.t('Nika today: {0} tokens · {1}. {2} Click to open the usage dashboard.', formatTokenCount(totals.totalTokens), formatCost(totals.cost), ratePeriodTooltip());
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

/**
 * The always-visible status bar label: how long the current rate period lasts
 * and how long until the opposite rate begins, e.g. `PEAK 2h 13m · OFF-PEAK 1h 47m`.
 */
function countdownLabel(): string {
	const { peak, peakEndsAt, offPeakEndsAt } = getDeepSeekRateCountdowns();
	const peakLeft = formatDuration(peakEndsAt - Date.now());
	const offPeakLeft = formatDuration(offPeakEndsAt - Date.now());
	return peak
		? `PEAK ${peakLeft} · OFF-PEAK ${offPeakLeft}`
		: `OFF-PEAK ${offPeakLeft} · PEAK ${peakLeft}`;
}

/** Absolute UTC times for the tooltip, e.g. `PEAK ends 04:00 UTC · OFF-PEAK ends 06:00 UTC`. */
function ratePeriodTooltip(): string {
	const { peak, peakEndsAt, offPeakEndsAt } = getDeepSeekRateCountdowns();
	const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 16);
	return peak
		? `PEAK ends ${fmt(peakEndsAt)} UTC · OFF-PEAK ends ${fmt(offPeakEndsAt)} UTC`
		: `OFF-PEAK ends ${fmt(offPeakEndsAt)} UTC · PEAK ends ${fmt(peakEndsAt)} UTC`;
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
