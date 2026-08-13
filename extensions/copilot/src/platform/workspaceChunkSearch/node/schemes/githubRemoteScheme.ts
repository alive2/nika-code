/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IIndexingScheme, IndexingSchemeId, IndexingState, IndexingStatus } from '../../common/indexingScheme';
import { CodeSearchRepoStatus } from '../codeSearch/codeSearchRepo';
import { IWorkspaceChunkSearchService } from '../workspaceChunkSearchService';

export class GithubRemoteScheme extends Disposable implements IIndexingScheme {
	declare readonly _serviceBrand: undefined;

	readonly id: IndexingSchemeId = 'github-remote';

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		@IWorkspaceChunkSearchService private readonly _workspaceChunkSearch: IWorkspaceChunkSearchService,
	) {
		super();
		this._register(this._workspaceChunkSearch.onDidChangeIndexState(() => this._onDidChangeState.fire()));
	}

	async getState(): Promise<IndexingState> {
		const { remoteIndexState } = await this._workspaceChunkSearch.getIndexState();
		const repos = remoteIndexState.repos;
		const status = this._mapStatus(remoteIndexState.status, repos.map(repo => repo.status));
		return {
			status,
			indexedFileCount: repos.filter(repo => repo.status === CodeSearchRepoStatus.Ready).length,
			totalFileCount: repos.length,
		};
	}

	async isAvailable(): Promise<boolean> {
		return this._workspaceChunkSearch.isAvailable();
	}

	private _mapStatus(remoteStatus: string, repoStatuses: readonly CodeSearchRepoStatus[]): IndexingStatus {
		if (remoteStatus === 'initializing') {
			return 'indexing';
		}
		if (remoteStatus === 'disabled') {
			return 'idle';
		}
		if (repoStatuses.some(status => status === CodeSearchRepoStatus.Ready)) {
			return 'synced';
		}
		if (repoStatuses.some(status => status === CodeSearchRepoStatus.BuildingIndex)) {
			return 'building';
		}
		if (repoStatuses.some(status => status === CodeSearchRepoStatus.NotAuthorized || status === CodeSearchRepoStatus.CouldNotCheckIndexStatus || status === CodeSearchRepoStatus.NotIndexable)) {
			return 'error';
		}
		return 'idle';
	}
}
