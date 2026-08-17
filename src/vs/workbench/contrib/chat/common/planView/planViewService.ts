/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export interface IPlanViewBinding {
	readonly planUri: URI;
	readonly sessionResource: URI;
}

export const IPlanViewService = createDecorator<IPlanViewService>('planViewService');

/**
 * Registry that binds a plan file to the chat session that produced it, so
 * the Plan Viewer can subscribe to that session's live todo updates.
 */
export interface IPlanViewService {
	readonly _serviceBrand: undefined;

	readonly onDidRegisterPlan: Event<IPlanViewBinding>;

	/** Register (or update) the binding for a plan file. Returns a disposable to unregister. */
	registerPlan(planUri: URI, sessionResource: URI): IDisposable;

	/** The session resource bound to a plan file, if any. */
	getSessionResource(planUri: URI): URI | undefined;

	/** The plan file bound to a chat session, if any. */
	getPlanUri(sessionResource: URI): URI | undefined;
}

export class PlanViewService extends Disposable implements IPlanViewService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRegisterPlan = this._register(new Emitter<IPlanViewBinding>());
	readonly onDidRegisterPlan = this._onDidRegisterPlan.event;

	private readonly _bindings = new Map<string, IPlanViewBinding>();

	registerPlan(planUri: URI, sessionResource: URI): IDisposable {
		const key = planUri.toString();
		this._bindings.set(key, { planUri, sessionResource });
		this._onDidRegisterPlan.fire({ planUri, sessionResource });
		return {
			dispose: () => {
				const current = this._bindings.get(key);
				if (current && isEqual(current.sessionResource, sessionResource)) {
					this._bindings.delete(key);
				}
			}
		};
	}

	getSessionResource(planUri: URI): URI | undefined {
		return this._bindings.get(planUri.toString())?.sessionResource;
	}

	getPlanUri(sessionResource: URI): URI | undefined {
		for (const binding of this._bindings.values()) {
			if (isEqual(binding.sessionResource, sessionResource)) {
				return binding.planUri;
			}
		}
		return undefined;
	}
}
