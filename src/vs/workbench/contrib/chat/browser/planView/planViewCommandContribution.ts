/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IPlanViewBinding, IPlanViewService } from '../../common/planView/planViewService.js';
import { PlanViewEditorInput } from './planViewEditorInput.js';

/**
 * Registers `workbench.action.chat.openPlanView`, which opens the most
 * recently registered plan in the Plan Viewer. Plans are registered when a
 * chat plan review with a plan file is rendered.
 */
export class PlanViewCommandContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.chat.planViewCommandContribution';

	private _latestBinding: IPlanViewBinding | undefined;

	constructor(
		@IPlanViewService planViewService: IPlanViewService,
		@IEditorService private readonly _editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._register(planViewService.onDidRegisterPlan(binding => {
			this._latestBinding = binding;
		}));

		this._register(CommandsRegistry.registerCommand('workbench.action.chat.openPlanView', async () => {
			if (!this._latestBinding) {
				return;
			}
			await this._editorService.openEditor(
				this._instantiationService.createInstance(PlanViewEditorInput, this._latestBinding.planUri, this._latestBinding.sessionResource),
				{ pinned: true }
			);
		}));
	}
}
