/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { suite, test, beforeEach, afterEach } from 'vitest';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../util/vs/base/common/event';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../configuration/test/common/inMemoryConfigurationService';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { MockExtensionContext } from '../../test/node/extensionContext';
import { TestWorkspaceService } from '../../test/node/testWorkspaceService';
import { createPlatformServices, ITestingServicesAccessor, TestingServiceCollection } from '../../test/node/services';
import { IWorkspaceService } from '../../workspace/common/workspaceService';
import { IWorkspaceFileIndex } from './workspaceFileIndex';
import { IndexingSchemeManager } from './indexingSchemeManager';

const INDEXING_SCHEME_CONFIG_KEY = 'nika.indexing.scheme';

class MockWorkspaceFileIndex implements IWorkspaceFileIndex {
	declare readonly _serviceBrand: undefined;
	readonly onDidCreateFiles = new Emitter<readonly URI[]>().event;
	readonly onDidChangeFiles = new Emitter<readonly URI[]>().event;
	readonly onDidDeleteFiles = new Emitter<readonly URI[]>().event;

	get fileCount(): number {
		return 0;
	}

	async initialize(): Promise<void> { }

	values(): Iterable<never> {
		return [];
	}

	get(): undefined {
		return undefined;
	}

	async tryLoad(): Promise<undefined> {
		return undefined;
	}

	async tryRead(): Promise<undefined> {
		return undefined;
	}

	async shouldIndexWorkspaceFile(): Promise<boolean> {
		return false;
	}

	dispose(): void { }
}

suite('IndexingSchemeManager', function () {
	const disposables = new DisposableStore();
	let testingServiceCollection: TestingServiceCollection;
	let accessor: ITestingServicesAccessor;
	let storageDir: string;

	beforeEach(() => {
		testingServiceCollection = disposables.add(createPlatformServices());
		storageDir = path.join(os.tmpdir(), `nika-indexing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		testingServiceCollection.set(IVSCodeExtensionContext, new MockExtensionContext(storageDir) as unknown as IVSCodeExtensionContext);
		testingServiceCollection.set(IWorkspaceService, new TestWorkspaceService([URI.file('/workspace')]));
		testingServiceCollection.set(IWorkspaceFileIndex, new MockWorkspaceFileIndex());
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
	});

	afterEach(() => {
		disposables.clear();
	});

	function createManager(): IndexingSchemeManager {
		const instantiationService = accessor.get(IInstantiationService);
		return disposables.add(instantiationService.createInstance(IndexingSchemeManager));
	}

	test('defaults to the configured scheme (off when unset)', async function () {
		const manager = createManager();
		assert.strictEqual(manager.id, 'off');
		assert.strictEqual(await manager.isAvailable(), false);
	});

	test('setScheme switches to local and is available', async function () {
		const manager = createManager();
		// The constructor defers scheme selection to a microtask; flush it so
		// the configured ('off') scheme is active before we switch.
		await new Promise(resolve => setTimeout(resolve, 0));
		await manager.setScheme('local');
		assert.strictEqual(manager.id, 'local');
		assert.strictEqual(await manager.isAvailable(), true);
	});

	test('config change fires onDidChangeState and switches scheme', async function () {
		const manager = createManager();
		let stateChanges = 0;
		disposables.add(manager.onDidChangeState(() => stateChanges++));

		const config = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		await config.setNonExtensionConfig(INDEXING_SCHEME_CONFIG_KEY, 'local');

		assert.strictEqual(manager.id, 'local');
		assert.ok(stateChanges >= 1);
	});

	test('getState returns idle for off scheme', async function () {
		const manager = createManager();
		const state = await manager.getState();
		assert.strictEqual(state.status, 'idle');
		assert.strictEqual(state.indexedFileCount, 0);
	});

	test('search returns undefined for non-local schemes', async function () {
		const manager = createManager();
		const result = await manager.search('hello', 5, CancellationToken.None);
		assert.strictEqual(result, undefined);
	});

	test('getState works for local scheme without touching the model', async function () {
		const manager = createManager();
		await manager.setScheme('local');
		const state = await manager.getState();
		assert.strictEqual(state.status, 'idle');
		assert.strictEqual(state.indexedFileCount, 0);
	});
});
