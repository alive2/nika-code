/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { PlanViewService } from '../../../common/planView/planViewService.js';

suite('PlanViewService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const planUri = URI.parse('file:///memories/session/plan.md');
	const sessionResource = URI.parse('chat://session/abc');

	test('registerPlan binds a plan file to a session and getSessionResource resolves it', () => {
		const service = new PlanViewService();
		try {
			const disposable = service.registerPlan(planUri, sessionResource);
			try {
				assert.strictEqual(service.getSessionResource(planUri)?.toString(), sessionResource.toString());
			} finally {
				disposable.dispose();
			}
		} finally {
			service.dispose();
		}
	});

	test('getPlanUri resolves the plan file bound to a session', () => {
		const service = new PlanViewService();
		try {
			const disposable = service.registerPlan(planUri, sessionResource);
			try {
				assert.strictEqual(service.getPlanUri(sessionResource)?.toString(), planUri.toString());
			} finally {
				disposable.dispose();
			}
		} finally {
			service.dispose();
		}
	});

	test('getPlanUri returns undefined for a session with no bound plan', () => {
		const service = new PlanViewService();
		try {
			assert.strictEqual(service.getPlanUri(URI.parse('chat://session/other')), undefined);
		} finally {
			service.dispose();
		}
	});

	test('unregistering a plan removes both lookup directions', () => {
		const service = new PlanViewService();
		try {
			const disposable = service.registerPlan(planUri, sessionResource);
			disposable.dispose();
			assert.strictEqual(service.getSessionResource(planUri), undefined);
			assert.strictEqual(service.getPlanUri(sessionResource), undefined);
		} finally {
			service.dispose();
		}
	});
});
