/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';
import { StrategySearchResult } from './workspaceChunkSearch';

export type IndexingSchemeId = 'off' | 'github-remote' | 'local' | 'cloud';

export type IndexingStatus = 'idle' | 'building' | 'indexing' | 'synced' | 'error';

export interface IndexingState {
	readonly status: IndexingStatus;
	readonly indexedFileCount: number;
	readonly totalFileCount: number;
	readonly lastError?: string;
	/**
	 * Human-readable progress message for the current phase (e.g. model
	 * download, embedding files). Optional; undefined when idle/synced.
	 */
	readonly message?: string;
}

export const INDEXING_SCHEME_IDS: readonly IndexingSchemeId[] = ['off', 'github-remote', 'local', 'cloud'];

export function isIndexingSchemeId(value: unknown): value is IndexingSchemeId {
	return typeof value === 'string' && (INDEXING_SCHEME_IDS as readonly string[]).includes(value);
}

export const IIndexingScheme = createServiceIdentifier<IIndexingScheme>('IIndexingScheme');

export interface IIndexingScheme extends IDisposable {
	readonly _serviceBrand: undefined;

	readonly id: IndexingSchemeId;

	readonly onDidChangeState: Event<void>;

	getState(): Promise<IndexingState>;

	isAvailable(): Promise<boolean>;
}

export const IIndexingSchemeManager = createServiceIdentifier<IIndexingSchemeManager>('IIndexingSchemeManager');

export interface IIndexingSchemeManager extends IIndexingScheme {
	setScheme(id: IndexingSchemeId): Promise<void>;

	rebuild(onProgress?: (message: string) => void): Promise<void>;

	clear(): Promise<void>;

	/**
	 * Deletes the cached local ONNX model (forces a re-download on next build).
	 * No-op for schemes that do not download a model.
	 */
	clearModelCache(): Promise<void>;

	/**
	 * Semantic search against the active scheme. Returns `undefined` when the
	 * active scheme does not provide semantic search (e.g. `off`).
	 */
	search(queryText: string, topK: number, token: CancellationToken): Promise<StrategySearchResult | undefined>;
}
