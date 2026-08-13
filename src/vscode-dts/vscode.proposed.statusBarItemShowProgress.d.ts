/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	export interface StatusBarItem {

		/**
		 * Controls the appearance of the item with an animated progress indicator.
		 *
		 * When set to `'loading'` (or `true`), a spinning codicon is shown in front
		 * of the item's text. The codicon DOM node is created once and kept stable
		 * while the item's {@linkcode StatusBarItem.text text} is updated, so the
		 * animation keeps running instead of restarting on every text change.
		 *
		 * Set to `'syncing'` for the sync-style indicator, or `false` to hide the
		 * progress indicator entirely.
		 */
		showProgress: boolean | 'loading' | 'syncing';
	}
}
