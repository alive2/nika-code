/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { applyTodoStatusToMarkdown } from '../../common/planView/planChecklist.js';
import { IPlanViewService } from '../../common/planView/planViewService.js';
import { IChatTodoListService } from '../../common/tools/chatTodoListService.js';

/**
 * Bridges live todo updates from the chat todo list service back into the
 * bound plan.md file, so the markdown document ticks its checkboxes in real
 * time while the agent implements the plan — even when the Plan Viewer is
 * closed and only the markdown editor is open.
 *
 * The write-back is title-matched and status-only: `- [ ]` → `- [>]`
 * (in-progress) → `- [x]` (completed), re-reading the latest content to avoid
 * clobbering concurrent edits, and never writing while the file has unsaved
 * user changes in an open editor.
 */
export class PlanTodoFileSync extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.chat.planTodoFileSync';

	private readonly _pendingSessions = new Set<URI>();
	private readonly _syncScheduler: RunOnceScheduler;

	constructor(
		@IChatTodoListService private readonly _chatTodoListService: IChatTodoListService,
		@IPlanViewService private readonly _planViewService: IPlanViewService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Agents tick several todos in quick succession; coalesce writes.
		this._syncScheduler = this._register(new RunOnceScheduler(() => void this._flushPending(), 300));
		this._register(this._chatTodoListService.onDidUpdateTodos(sessionResource => {
			this._pendingSessions.add(sessionResource);
			this._syncScheduler.schedule();
		}));
	}

	private async _flushPending(): Promise<void> {
		const sessions = [...this._pendingSessions];
		this._pendingSessions.clear();
		for (const sessionResource of sessions) {
			await this._syncSession(sessionResource);
		}
	}

	private async _syncSession(sessionResource: URI): Promise<void> {
		try {
			const planUri = this._planViewService.getPlanUri(sessionResource);
			if (!planUri) {
				return;
			}
			const todos = this._chatTodoListService.getTodos(sessionResource);
			if (todos.length === 0) {
				return;
			}

			const textFileModel = this._textFileService.files.get(planUri);
			if (textFileModel?.isDirty()) {
				// Never clobber unsaved user edits in an open editor.
				return;
			}
			const latest = textFileModel?.isResolved()
				? textFileModel.textEditorModel.getValue()
				: (await this._textFileService.read(planUri)).value;

			let updated = latest;
			for (const todo of todos) {
				updated = applyTodoStatusToMarkdown(updated, todo.title, todo.status);
			}
			if (updated !== latest) {
				await this._textFileService.write(planUri, updated);
			}
		} catch (error) {
			this._logService.trace(`[PlanTodoFileSync] Failed to sync todos to plan file: ${String(error)}`);
		}
	}
}
