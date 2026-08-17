/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { isEqual, basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { FileChangeType, IFileService } from '../../../../../platform/files/common/files.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IChatOutputRendererService } from '../chatOutputItemRenderer.js';
import { IChatTodo, IChatTodoListService } from '../../common/tools/chatTodoListService.js';
import { IPlanViewService } from '../../common/planView/planViewService.js';
import { IPlanChecklistItem, addTodoItemToMarkdown, applyTodoStatusToMarkdown, parsePlanChecklist } from '../../common/planView/planChecklist.js';
import { PlanViewEditorInput } from './planViewEditorInput.js';
import { createPlanCodeBlockRenderer } from './planCodeBlockRenderer.js';
import './media/planViewEditor.css';

const MARKDOWN_EDITOR_ID = 'vscode.markdown.editor';

function statusIconClass(status: IChatTodo['status']): string {
	switch (status) {
		case 'completed':
			return 'codicon-pass';
		case 'in-progress':
			return 'codicon-record';
		default:
			return 'codicon-circle-outline';
	}
}

function statusIconColor(status: IChatTodo['status']): string {
	switch (status) {
		case 'completed':
			return 'var(--vscode-charts-green)';
		case 'in-progress':
			return 'var(--vscode-charts-blue)';
		default:
			return 'var(--vscode-foreground)';
	}
}

function statusText(status: IChatTodo['status']): string {
	switch (status) {
		case 'completed':
			return localize('chat.planView.todo.completed', 'completed');
		case 'in-progress':
			return localize('chat.planView.todo.inProgress', 'in progress');
		default:
			return localize('chat.planView.todo.notStarted', 'not started');
	}
}

export class PlanViewEditor extends EditorPane {

	static readonly ID = 'workbench.editor.planView';

	private _root: HTMLElement | undefined;
	private _titleEl: HTMLElement | undefined;
	private _statusBadgeEl: HTMLElement | undefined;
	private _bodyEl: HTMLElement | undefined;
	private _todoSectionEl: HTMLElement | undefined;
	private _todoListEl: HTMLElement | undefined;
	private _todoCountEl: HTMLElement | undefined;

	private _currentPlanUri: URI | undefined;
	private _sessionResource: URI | undefined;
	private _checklistItems: IPlanChecklistItem[] = [];
	private _serviceTodos: IChatTodo[] = [];

	private readonly _contentDisposables = this._register(new DisposableStore());
	private readonly _markdownDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _todoListDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _planChangeScheduler = this._register(new RunOnceScheduler(() => this.refreshFromFile(), 300));

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IMarkdownRendererService private readonly _markdownRendererService: IMarkdownRendererService,
		@IChatTodoListService private readonly _chatTodoListService: IChatTodoListService,
		@IChatOutputRendererService private readonly _chatOutputRendererService: IChatOutputRendererService,
		@IPlanViewService private readonly _planViewService: IPlanViewService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IEditorService private readonly _editorService: IEditorService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) {
		super(PlanViewEditor.ID, group, telemetryService, themeService, storageService);
	}

	override layout(_dimension: dom.Dimension): void {
		// The editor uses a flex column layout driven entirely by CSS, so no
		// manual participant layout is needed.
	}

	protected createEditor(parent: HTMLElement): void {
		const root = dom.append(parent, dom.$('.plan-view-editor'));
		root.tabIndex = 0;
		root.style.outline = 'none';
		root.setAttribute('role', 'document');
		this._root = root;

		// Header: title, status badge, actions.
		const header = dom.append(root, dom.$('.plan-view-editor-header'));
		this._titleEl = dom.append(header, dom.$('.plan-view-editor-title'));
		this._titleEl.setAttribute('role', 'heading');
		this._statusBadgeEl = dom.append(header, dom.$('.plan-view-editor-status-badge'));
		this._statusBadgeEl.setAttribute('aria-live', 'polite');

		const headerActions = dom.append(header, dom.$('.plan-view-editor-header-actions'));
		const editButtonLabel = localize('chat.planView.editInMarkdown', 'Edit in Markdown');
		const editButton = this._register(new Button(headerActions, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: editButtonLabel, ariaLabel: editButtonLabel }));
		editButton.element.classList.add('plan-view-editor-header-button');
		editButton.label = `$(${Codicon.markdown.id}) ${editButtonLabel}`;
		this._register(editButton.onDidClick(() => void this.openInMarkdownEditor()));

		// Body: rendered plan markdown.
		this._bodyEl = dom.append(root, dom.$('.plan-view-editor-body'));

		// Pinned todo section at the bottom.
		this._todoSectionEl = dom.append(root, dom.$('.plan-view-editor-todo-section'));
		this._todoSectionEl.setAttribute('aria-label', localize('chat.planView.todoSectionAria', 'Plan tasks'));
		const todoHeader = dom.append(this._todoSectionEl, dom.$('.plan-view-editor-todo-header'));
		const todoTitle = dom.append(todoHeader, dom.$('.plan-view-editor-todo-title'));
		todoTitle.textContent = localize('chat.planView.todoTitle', 'Tasks');
		this._todoCountEl = dom.append(todoHeader, dom.$('.plan-view-editor-todo-count'));
		const addButtonLabel = localize('chat.planView.addTask', 'Add Task');
		const addButton = this._register(new Button(todoHeader, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: addButtonLabel, ariaLabel: addButtonLabel }));
		addButton.element.classList.add('plan-view-editor-todo-add-button');
		addButton.label = `$(${Codicon.add.id}) ${addButtonLabel}`;
		this._register(addButton.onDidClick(() => void this.addTodo()));
		this._todoListEl = dom.append(this._todoSectionEl, dom.$('ul.plan-view-editor-todo-list'));
	}

	override async setInput(input: PlanViewEditorInput, options: undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this._root) {
			await this.render(input);
		}
	}

	private async render(input: PlanViewEditorInput): Promise<void> {
		this._contentDisposables.clear();
		this._markdownDisposables.clear();
		this._todoListDisposables.clear();
		this._planChangeScheduler.cancel();
		this._checklistItems = [];
		this._serviceTodos = [];
		this._currentPlanUri = input.planUri;
		this._sessionResource = input.sessionResource ?? this._planViewService.getSessionResource(input.planUri);

		if (this._titleEl) {
			this._titleEl.textContent = basename(input.planUri);
		}

		let content: string;
		try {
			content = await this.readPlanContent(input.planUri);
		} catch {
			this.renderError(localize('chat.planView.readError', 'The plan file could not be read.'));
			return;
		}

		this._checklistItems = parsePlanChecklist(content);
		this._serviceTodos = this._sessionResource ? this._chatTodoListService.getTodos(this._sessionResource) : [];

		this.renderMarkdown(content);
		this.renderTodoList();
		this.updateStatusBadge();

		this.subscribeToTodoUpdates();
		this.watchPlanChanges(input.planUri);
	}

	/**
	 * Live todo updates from the bound chat session. If the plan is not bound
	 * yet (e.g. the viewer was opened before the chat plan review rendered),
	 * adopt the binding when it is registered.
	 */
	private subscribeToTodoUpdates(): void {
		if (this._currentPlanUri) {
			this._contentDisposables.add(this._planViewService.onDidRegisterPlan(binding => {
				if (!this._currentPlanUri || !isEqual(binding.planUri, this._currentPlanUri)) {
					return;
				}
				if (!this._sessionResource) {
					this._sessionResource = binding.sessionResource;
					this._serviceTodos = this._chatTodoListService.getTodos(this._sessionResource);
					this.renderTodoList();
					this.updateStatusBadge();
				}
			}));
		}
		if (this._sessionResource) {
			this._contentDisposables.add(this._chatTodoListService.onDidUpdateTodos(sessionResource => {
				if (this._sessionResource && isEqual(sessionResource, this._sessionResource)) {
					this._serviceTodos = this._chatTodoListService.getTodos(this._sessionResource);
					this.renderTodoList();
					this.updateStatusBadge();
				}
			}));
		}
	}

	/**
	 * Re-read the plan file and refresh both the markdown body and the
	 * checklist. Used when the file changes on disk or in an editor model.
	 */
	private async refreshFromFile(): Promise<void> {
		if (!this._currentPlanUri) {
			return;
		}
		let content: string;
		try {
			content = await this.readPlanContent(this._currentPlanUri);
		} catch {
			this.renderError(localize('chat.planView.readError', 'The plan file could not be read.'));
			return;
		}
		this._checklistItems = parsePlanChecklist(content);
		this.renderMarkdown(content);
		this.renderTodoList();
		this.updateStatusBadge();
	}

	private async readPlanContent(planUri: URI): Promise<string> {
		const model = this._textFileService.files.get(planUri);
		if (model?.isResolved()) {
			return model.textEditorModel.getValue();
		}
		return (await this._textFileService.read(planUri)).value;
	}

	private watchPlanChanges(planUri: URI): void {
		// React to edits made in an open editor model.
		const modelListener = this._contentDisposables.add(new MutableDisposable());
		const watchModel = (model: ITextModel) => {
			if (isEqual(model.uri, planUri)) {
				modelListener.value = model.onDidChangeContent(() => this._planChangeScheduler.schedule());
			}
		};
		const model = this._modelService.getModel(planUri);
		if (model) {
			watchModel(model);
		}
		this._contentDisposables.add(this._modelService.onModelAdded(watchModel));

		// React to external file changes (e.g. the agent rewriting the plan).
		const watcher = this._contentDisposables.add(this._fileService.createWatcher(planUri, { recursive: false, excludes: [] }));
		this._contentDisposables.add(watcher.onDidChange(event => {
			if (event.contains(planUri, FileChangeType.UPDATED, FileChangeType.ADDED)) {
				this._planChangeScheduler.schedule();
			}
		}));
	}

	private renderMarkdown(content: string): void {
		if (!this._bodyEl) {
			return;
		}
		dom.clearNode(this._bodyEl);
		const store = new DisposableStore();
		this._markdownDisposables.value = store;
		const rendered = store.add(this._markdownRendererService.render(
			new MarkdownString(content, { supportThemeIcons: true, isTrusted: false }),
			{
				codeBlockRendererSync: createPlanCodeBlockRenderer(
					this._chatOutputRendererService,
					() => this._sessionResource,
					store,
				),
			}
		));
		this._bodyEl.append(rendered.element);
	}

	private renderError(message: string): void {
		if (!this._bodyEl) {
			return;
		}
		dom.clearNode(this._bodyEl);
		const error = dom.append(this._bodyEl, dom.$('.plan-view-editor-error'));
		error.textContent = message;
	}

	/**
	 * Renders the checklist: file items with live statuses overlaid from the
	 * bound session's todo service, plus service-only items the agent created
	 * that have no matching file line.
	 */
	private renderTodoList(): void {
		if (!this._todoListEl) {
			return;
		}
		const listStore = new DisposableStore();
		this._todoListDisposables.value = listStore;
		dom.clearNode(this._todoListEl);

		const items: Array<{ item: IPlanChecklistItem; live?: IChatTodo }> = [];
		for (const item of this._checklistItems) {
			items.push({ item, live: this._serviceTodos.find(todo => todo.title === item.title) });
		}
		for (const todo of this._serviceTodos) {
			if (!this._checklistItems.some(item => item.title === todo.title)) {
				items.push({ item: { title: todo.title, status: todo.status, line: `- [ ] ${todo.title}`, lineIndex: -1 }, live: todo });
			}
		}

		let completedCount = 0;
		for (const { item, live } of items) {
			const todoStatus = live?.status ?? item.status;
			if (todoStatus === 'completed') {
				completedCount++;
			}
			const row = dom.append(this._todoListEl, dom.$('li.plan-view-todo-item'));
			row.classList.toggle('plan-view-todo-item-in-progress', todoStatus === 'in-progress');
			row.classList.toggle('plan-view-todo-item-completed', todoStatus === 'completed');

			const checkbox = dom.append(row, dom.$<HTMLButtonElement>('button.plan-view-todo-checkbox.codicon'));
			checkbox.type = 'button';
			checkbox.classList.add(statusIconClass(todoStatus));
			checkbox.style.color = statusIconColor(todoStatus);
			checkbox.setAttribute('role', 'checkbox');
			checkbox.setAttribute('aria-checked', todoStatus === 'in-progress' ? 'mixed' : String(todoStatus === 'completed'));
			const toggleLabel = todoStatus === 'completed'
				? localize('chat.planView.todo.markNotStarted', 'Mark "{0}" as not started', item.title)
				: localize('chat.planView.todo.markCompleted', 'Mark "{0}" as completed', item.title);
			checkbox.setAttribute('aria-label', toggleLabel);
			checkbox.title = `${item.title} — ${statusText(todoStatus)}`;
			listStore.add(dom.addDisposableListener(checkbox, dom.EventType.CLICK, () => void this.toggleTodo(item, todoStatus)));

			const title = dom.append(row, dom.$('span.plan-view-todo-title'));
			title.textContent = item.title;
		}

		if (this._todoCountEl) {
			this._todoCountEl.textContent = items.length > 0
				? localize('chat.planView.todoCount', '({0}/{1})', completedCount, items.length)
				: '';
		}
	}

	private updateStatusBadge(): void {
		if (!this._statusBadgeEl) {
			return;
		}
		dom.clearNode(this._statusBadgeEl);

		const effectiveStatus = (title: string, fallback: IChatTodo['status']): IChatTodo['status'] =>
			this._serviceTodos.find(todo => todo.title === title)?.status ?? fallback;
		const serviceOnlyTodos = this._serviceTodos.filter(todo => !this._checklistItems.some(item => item.title === todo.title));
		const statuses = [
			...this._checklistItems.map(item => effectiveStatus(item.title, item.status)),
			...serviceOnlyTodos.map(todo => todo.status),
		];
		const inProgressItem = [...this._checklistItems, ...serviceOnlyTodos.map(todo => ({ title: todo.title, status: todo.status, line: '', lineIndex: -1 }))]
			.find(item => effectiveStatus(item.title, item.status) === 'in-progress');
		const done = statuses.filter(todoStatus => todoStatus === 'completed').length;

		const icon = dom.append(this._statusBadgeEl, dom.$('span.codicon'));
		if (inProgressItem) {
			icon.classList.add(statusIconClass('in-progress'));
			icon.style.color = statusIconColor('in-progress');
			const label = dom.append(this._statusBadgeEl, dom.$('span'));
			label.textContent = localize('chat.planView.statusInProgressWithTask', 'In progress: {0}', inProgressItem.title);
		} else if (statuses.length > 0 && done === statuses.length) {
			icon.classList.add(statusIconClass('completed'));
			icon.style.color = statusIconColor('completed');
			const label = dom.append(this._statusBadgeEl, dom.$('span'));
			label.textContent = localize('chat.planView.statusCompleted', 'Completed');
		} else {
			icon.classList.add(statusIconClass('not-started'));
			const label = dom.append(this._statusBadgeEl, dom.$('span'));
			label.textContent = localize('chat.planView.statusNotStarted', 'Not started');
		}
	}

	// ─── Editing ────────────────────────────────────────────────────────────

	private async toggleTodo(item: IPlanChecklistItem, currentStatus: IChatTodo['status']): Promise<void> {
		const nextStatus: IChatTodo['status'] = currentStatus === 'completed' ? 'not-started' : 'completed';
		await this.updateTodoInFile(item.title, nextStatus);
		this.updateServiceTodo(item.title, nextStatus);
		status(localize('chat.planView.todoAnnouncement', '{0}: {1}', item.title, statusText(nextStatus)));
	}

	private async addTodo(): Promise<void> {
		const title = await this._quickInputService.input({
			prompt: localize('chat.planView.addTaskPrompt', 'Add a task to the plan'),
			title: localize('chat.planView.addTaskTitle', 'Add Task'),
		});
		if (!title?.trim()) {
			return;
		}
		const trimmed = title.trim();
		await this.updateTodoInFile(trimmed, 'not-started', true);
		this.updateServiceTodo(trimmed, 'not-started');
	}

	/**
	 * Applies a minimal edit to the plan file so the file stays the source of
	 * truth. Re-reads the latest content to avoid clobbering concurrent agent
	 * writes. With `insert` the task is appended to the checklist instead of
	 * matching an existing line.
	 */
	private async updateTodoInFile(title: string, status: IChatTodo['status'], insert = false): Promise<void> {
		if (!this._currentPlanUri) {
			return;
		}
		try {
			const latest = await this.readPlanContent(this._currentPlanUri);
			const updated = insert
				? addTodoItemToMarkdown(latest, title)
				: applyTodoStatusToMarkdown(latest, title, status);
			if (updated !== latest) {
				await this._textFileService.write(this._currentPlanUri, updated);
			}
		} catch {
			// File write failed (e.g. deleted file) — surface the failure in
			// the todo service only; the checklist stays as-is.
		}
	}

	private updateServiceTodo(title: string, status: IChatTodo['status']): void {
		if (!this._sessionResource) {
			return;
		}
		const todos = this._chatTodoListService.getTodos(this._sessionResource);
		let matched = false;
		const updated = todos.map(todo => {
			if (todo.title === title) {
				matched = true;
				return { ...todo, status };
			}
			return todo;
		});
		if (!matched) {
			updated.push({ id: updated.length + 1, title, status });
		}
		this._chatTodoListService.setTodos(this._sessionResource, updated);
	}

	private async openInMarkdownEditor(): Promise<void> {
		if (!this._currentPlanUri) {
			return;
		}
		await this._editorService.openEditor({
			resource: this._currentPlanUri,
			options: { pinned: true, override: MARKDOWN_EDITOR_ID },
		});
	}

	override clearInput(): void {
		super.clearInput();
		this._contentDisposables.clear();
		this._markdownDisposables.clear();
		this._todoListDisposables.clear();
		this._planChangeScheduler.cancel();
		this._currentPlanUri = undefined;
		this._sessionResource = undefined;
		if (this._bodyEl) {
			dom.clearNode(this._bodyEl);
		}
		if (this._todoListEl) {
			dom.clearNode(this._todoListEl);
		}
	}
}
