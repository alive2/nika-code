/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IIndexingScheme, IIndexingSchemeManager, IndexingSchemeId, IndexingState, isIndexingSchemeId } from '../common/indexingScheme';
import { StrategySearchResult } from '../common/workspaceChunkSearch';
import { LocalChunkSearch } from './local/localChunkSearch';
import { GithubRemoteScheme } from './schemes/githubRemoteScheme';
import { OffScheme } from './schemes/offScheme';

export { IIndexingSchemeManager } from '../common/indexingScheme';

const INDEXING_SCHEME_CONFIG_KEY = 'nika.indexing.scheme';

export class IndexingSchemeManager extends Disposable implements IIndexingSchemeManager {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private _schemeDisposables = new DisposableStore();
	private _scheme: IIndexingScheme | undefined;
	private _isDisposed = false;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(INDEXING_SCHEME_CONFIG_KEY)) {
				void this.setScheme(this.getConfiguredScheme());
			}
		}));
		// Defer the initial scheme selection: the github-remote scheme injects
		// IWorkspaceChunkSearchService, which in turn injects this manager. If
		// we selected the scheme synchronously in the constructor we would hit
		// a DI cycle. A microtask runs after the container has finished
		// constructing all services, so resolution is safe here.
		queueMicrotask(() => {
			if (!this._isDisposed) {
				void this.setScheme(this.getConfiguredScheme());
			}
		});
	}

	get id(): IndexingSchemeId {
		return this._scheme?.id ?? this.getConfiguredScheme();
	}

	async setScheme(id: IndexingSchemeId): Promise<void> {
		if (this._scheme?.id === id) {
			return;
		}
		this._schemeDisposables.dispose();
		this._schemeDisposables = new DisposableStore();
		this._scheme = this._createScheme(id);
		this._schemeDisposables.add(this._scheme);
		this._schemeDisposables.add(this._scheme.onDidChangeState(() => this._onDidChangeState.fire()));
		this._onDidChangeState.fire();
		this._logService.trace(`IndexingSchemeManager: active scheme is '${id}'.`);
	}

	async getState(): Promise<IndexingState> {
		if (!this._scheme) {
			return { status: 'idle', indexedFileCount: 0, totalFileCount: 0 };
		}
		return this._scheme.getState();
	}

	async isAvailable(): Promise<boolean> {
		return this._scheme?.isAvailable() ?? false;
	}

	async rebuild(onProgress?: (message: string) => void): Promise<void> {
		if (!this._scheme) {
			return;
		}
		if (this._scheme.id === 'local' && this._scheme instanceof LocalChunkSearch) {
			await this._scheme.build(onProgress ?? (() => { }), CancellationToken.None);
			return;
		}
		// The github-remote scheme is driven by the underlying code search
		// service, which starts indexing on its own when a repo becomes
		// available; off has nothing to do.
		this._logService.trace(`IndexingSchemeManager: rebuild() is a no-op for scheme '${this._scheme.id}'.`);
	}

	async clear(): Promise<void> {
		if (!this._scheme) {
			return;
		}
		if (this._scheme.id === 'local' && this._scheme instanceof LocalChunkSearch) {
			await this._scheme.clear();
			return;
		}
		this._logService.trace(`IndexingSchemeManager: clear() is a no-op for scheme '${this._scheme.id}'.`);
	}

	async clearModelCache(): Promise<void> {
		if (!this._scheme) {
			return;
		}
		if (this._scheme.id === 'local' && this._scheme instanceof LocalChunkSearch) {
			await this._scheme.clearModelCache();
			return;
		}
		this._logService.trace(`IndexingSchemeManager: clearModelCache() is a no-op for scheme '${this._scheme.id}'.`);
	}

	async search(queryText: string, topK: number, token: CancellationToken): Promise<StrategySearchResult | undefined> {
		if (this._scheme instanceof LocalChunkSearch) {
			return this._scheme.search(queryText, topK, token);
		}
		return undefined;
	}

	public override dispose(): void {
		this._isDisposed = true;
		this._schemeDisposables.dispose();
		super.dispose();
	}

	private getConfiguredScheme(): IndexingSchemeId {
		const value = this._configService.getNonExtensionConfig<string>(INDEXING_SCHEME_CONFIG_KEY);
		return isIndexingSchemeId(value) ? value : 'off';
	}

	private _createScheme(id: IndexingSchemeId): IIndexingScheme {
		switch (id) {
			case 'github-remote':
				return this._instantiationService.createInstance(GithubRemoteScheme);
			case 'local':
				return this._instantiationService.createInstance(LocalChunkSearch);
			case 'cloud':
				this._logService.warn(`IndexingSchemeManager: scheme 'cloud' is not implemented yet, falling back to 'off'.`);
				return this._instantiationService.createInstance(OffScheme);
			case 'off':
			default:
				return this._instantiationService.createInstance(OffScheme);
		}
	}
}
