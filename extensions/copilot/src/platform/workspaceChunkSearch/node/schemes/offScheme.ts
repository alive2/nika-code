/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IIndexingScheme, IndexingSchemeId, IndexingState } from '../../common/indexingScheme';

export class OffScheme extends Disposable implements IIndexingScheme {
	declare readonly _serviceBrand: undefined;

	readonly id: IndexingSchemeId = 'off';

	readonly onDidChangeState = Event.None;

	async getState(): Promise<IndexingState> {
		return { status: 'idle', indexedFileCount: 0, totalFileCount: 0 };
	}

	async isAvailable(): Promise<boolean> {
		return false;
	}
}
