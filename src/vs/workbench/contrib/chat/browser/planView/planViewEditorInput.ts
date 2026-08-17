/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

const PlanViewEditorIcon = registerIcon('plan-view-editor-icon', Codicon.checklist, localize('planViewEditorIcon', 'Icon of the Plan Viewer editor.'));

/**
 * Editor input for the Plan Viewer. Carries the plan file URI and, when the
 * plan was opened from a chat plan review, the session resource whose live
 * todo updates drive the checklist overlay.
 */
export class PlanViewEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.planView';

	override get typeId(): string {
		return PlanViewEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override get resource(): URI {
		return this._planUri;
	}

	constructor(
		private readonly _planUri: URI,
		private readonly _sessionResource?: URI,
	) {
		super();
	}

	get planUri(): URI {
		return this._planUri;
	}

	get sessionResource(): URI | undefined {
		return this._sessionResource;
	}

	override getName(): string {
		return localize('planViewInputName', "Plan: {0}", basename(this._planUri));
	}

	override getIcon(): ThemeIcon | undefined {
		return PlanViewEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}

		return other instanceof PlanViewEditorInput && isEqual(this._planUri, other._planUri);
	}
}
