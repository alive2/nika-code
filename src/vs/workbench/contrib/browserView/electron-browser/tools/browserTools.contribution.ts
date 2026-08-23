/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAgentNetworkFilterService } from '../../../../../platform/networkFilter/common/networkFilterService.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { registerWorkbenchContribution2, WorkbenchPhase, type IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatContextService } from '../../../chat/browser/contextContrib/chatContextService.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { ILanguageModelToolsService, ToolDataSource, ToolSet } from '../../../chat/common/tools/languageModelToolsService.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { getBrowserPagesContext } from './browserToolHelpers.js';
import { ClickBrowserTool, ClickBrowserToolData } from './clickBrowserTool.js';
import { DragElementTool, DragElementToolData } from './dragElementTool.js';
import { HandleDialogBrowserTool, HandleDialogBrowserToolData } from './handleDialogBrowserTool.js';
import { HoverElementTool, HoverElementToolData } from './hoverElementTool.js';
import { ListBrowserPagesTool, ListBrowserPagesToolData } from './listBrowserPagesTool.js';
import { NavigateBrowserTool, NavigateBrowserToolData } from './navigateBrowserTool.js';
import { OpenBrowserTool, OpenBrowserToolData } from './openBrowserTool.js';
import { OpenBrowserToolNonAgentic, OpenBrowserToolNonAgenticData } from './openBrowserToolNonAgentic.js';
import { ReadBrowserTool, ReadBrowserToolData } from './readBrowserTool.js';
import { RunPlaywrightCodeTool, RunPlaywrightCodeToolData } from './runPlaywrightCodeTool.js';
import { ScreenshotBrowserTool, ScreenshotBrowserToolData } from './screenshotBrowserTool.js';
import { TypeBrowserTool, TypeBrowserToolData } from './typeBrowserTool.js';


/**
 * Arguments for `workbench.action.browser.evaluateJavascript`. The command
 * runs {@link expression} (as a Playwright `page.evaluate` body) against the
 * first integrated-browser tab whose URL contains {@link urlPrefix}.
 */
interface IBrowserEvaluateJavascriptArgs {
	readonly urlPrefix?: string;
	readonly expression?: string;
}

interface IBrowserEvaluateJavascriptResult {
	/** True when a tab with a matching URL was found and evaluated. */
	readonly matched: boolean;
	/** The JSON-serializable value returned by the evaluated expression. */
	readonly value?: unknown;
	readonly error?: string;
}

class BrowserChatAgentToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'browserView.chatAgentTools';
	private static readonly CONTEXT_ID = 'browserView.trackedPages';
	private readonly _toolsStore = this._register(new DisposableStore());
	private readonly _modelListeners = this._register(new DisposableMap<string, DisposableStore>());
	private readonly _browserToolSet: ToolSet;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageModelToolsService private readonly toolsService: ILanguageModelToolsService,
		@IChatContextService private readonly chatContextService: IChatContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IBrowserViewWorkbenchService private readonly browserViewService: IBrowserViewWorkbenchService,
		@IAgentNetworkFilterService private readonly agentNetworkFilterService: IAgentNetworkFilterService,
		@IChatService private readonly chatService: IChatService,
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
	) {
		super();

		this._browserToolSet = this._register(this.toolsService.createToolSet(
			ToolDataSource.Internal,
			'browser',
			'browser',
			{
				icon: Codicon.globe,
				description: localize('browserToolSet.description', 'Open and interact with integrated browser pages'),
				deprecated: true
			},
		));

		this._updateToolRegistrations();

		this._register(this.browserViewService.onDidChangeSharingAvailable(() => {
			this._updateToolRegistrations();
		}));

		// Dispose Playwright sessions when the corresponding chat session ends.
		this._register(this.chatService.onDidDisposeSession(e => {
			for (const resource of e.sessionResources) {
				void this.playwrightService.disposeSession(resource.toString()).catch(() => { });
			}
		}));

		// Internal command used by extensions (e.g. the Nika DeepSeek Web
		// token import) to evaluate JavaScript in a user's integrated-browser
		// tab. Only pages the user has open in the workbench are targeted, so
		// the page's own persistent session (cookies/localStorage) is used.
		this._register(CommandsRegistry.registerCommand({
			id: 'workbench.action.browser.evaluateJavascript',
			handler: (_accessor, args?: IBrowserEvaluateJavascriptArgs) => this._evaluateJavascript(args),
		}));
	}

	private async _evaluateJavascript(args?: IBrowserEvaluateJavascriptArgs): Promise<IBrowserEvaluateJavascriptResult> {
		const urlPrefix = args?.urlPrefix ?? '';
		const expression = args?.expression ?? '';
		const sessionId = 'workbench-browser-evaluate';
		const playwrightService = this.playwrightService;

		// Fast path: pages already tracked by a Playwright session.
		// Note: `invokeFunctionRaw` delivers the args spread as individual
		// parameters (the compiled wrapper is `(page, ...args)`), so fnDefs
		// must not array-destructure their second parameter.
		const matchUrl = `async (page, prefix) => (page.url() || '').includes(prefix)`;
		let pageId: string | undefined;
		for (const trackedId of await playwrightService.getTrackedPages()) {
			try {
				if (await playwrightService.invokeFunctionRaw<boolean>(sessionId, trackedId, matchUrl, urlPrefix)) {
					pageId = trackedId;
					break;
				}
			} catch {
				// Not reachable from this session; try the next page.
			}
		}

		// Fall back to the user's workbench browser tabs: track the first tab
		// whose URL matches so our session can drive it (it keeps its own
		// persistent session, so cookies/localStorage are the user's).
		if (!pageId) {
			for (const [viewId, input] of this.browserViewService.getKnownBrowserViews()) {
				if ((input.url ?? '').includes(urlPrefix)) {
					try {
						if (!(await playwrightService.isPageTracked(viewId))) {
							await playwrightService.startTrackingPage(viewId);
						}
						pageId = viewId;
						break;
					} catch {
						// Try the next matching tab.
					}
				}
			}
		}

		if (!pageId) {
			return {
				matched: false,
				error: `No integrated browser page is open at "${urlPrefix}". Open the page in the integrated browser first.`,
			};
		}

		try {
			const value = await playwrightService.invokeFunctionRaw<unknown>(
				sessionId,
				pageId,
				`async (page, expr) => page.evaluate(expr)`,
				expression,
			);
			return { matched: true, value };
		} catch (error) {
			return { matched: true, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private _updateToolRegistrations(): void {
		this._toolsStore.clear();
		this._modelListeners.clearAndDisposeAll();

		if (!this.browserViewService.isSharingAvailable) {
			// If chat tools are disabled, we only register the non-agentic open tool,
			// which allows opening browser pages without granting access to their contents.
			this._toolsStore.add(this.toolsService.registerTool(OpenBrowserToolNonAgenticData, this.instantiationService.createInstance(OpenBrowserToolNonAgentic)));
			this._toolsStore.add(this._browserToolSet.addTool(OpenBrowserToolNonAgenticData));
			this.chatContextService.updateWorkspaceContextItems(BrowserChatAgentToolsContribution.CONTEXT_ID, []);
			return;
		}

		this._toolsStore.add(this.toolsService.registerTool(OpenBrowserToolData, this.instantiationService.createInstance(OpenBrowserTool)));
		this._toolsStore.add(this.toolsService.registerTool(ReadBrowserToolData, this.instantiationService.createInstance(ReadBrowserTool)));
		this._toolsStore.add(this.toolsService.registerTool(ScreenshotBrowserToolData, this.instantiationService.createInstance(ScreenshotBrowserTool)));
		this._toolsStore.add(this.toolsService.registerTool(NavigateBrowserToolData, this.instantiationService.createInstance(NavigateBrowserTool)));
		this._toolsStore.add(this.toolsService.registerTool(ClickBrowserToolData, this.instantiationService.createInstance(ClickBrowserTool)));
		this._toolsStore.add(this.toolsService.registerTool(DragElementToolData, this.instantiationService.createInstance(DragElementTool)));
		this._toolsStore.add(this.toolsService.registerTool(HoverElementToolData, this.instantiationService.createInstance(HoverElementTool)));
		this._toolsStore.add(this.toolsService.registerTool(TypeBrowserToolData, this.instantiationService.createInstance(TypeBrowserTool)));
		this._toolsStore.add(this.toolsService.registerTool(RunPlaywrightCodeToolData, this.instantiationService.createInstance(RunPlaywrightCodeTool)));
		this._toolsStore.add(this.toolsService.registerTool(HandleDialogBrowserToolData, this.instantiationService.createInstance(HandleDialogBrowserTool)));

		// Note: this is not currently exposed directly to models. It is mostly exposed so extensions can use it to provide model context via the API.
		this._toolsStore.add(this.toolsService.registerTool(ListBrowserPagesToolData, this.instantiationService.createInstance(ListBrowserPagesTool)));

		this._toolsStore.add(this._browserToolSet.addTool(OpenBrowserToolData));
		this._toolsStore.add(this._browserToolSet.addTool(ReadBrowserToolData));
		this._toolsStore.add(this._browserToolSet.addTool(ScreenshotBrowserToolData));
		this._toolsStore.add(this._browserToolSet.addTool(NavigateBrowserToolData));
		this._toolsStore.add(this._browserToolSet.addTool(ClickBrowserToolData));
		this._toolsStore.add(this._browserToolSet.addTool(DragElementToolData));
		this._toolsStore.add(this._browserToolSet.addTool(HoverElementToolData));
		this._toolsStore.add(this._browserToolSet.addTool(TypeBrowserToolData));
		this._toolsStore.add(this._browserToolSet.addTool(RunPlaywrightCodeToolData));
		this._toolsStore.add(this._browserToolSet.addTool(HandleDialogBrowserToolData));

		// Subscribe to browser view changes and model sharing state changes
		this._syncModelListeners();
		this._toolsStore.add(this.browserViewService.onDidChangeBrowserViews(() => {
			this._syncModelListeners();
			this._updateBrowserContext();
		}));
		this._toolsStore.add(this.editorService.onDidActiveEditorChange(() => this._updateBrowserContext()));
		this._toolsStore.add(this.editorService.onDidVisibleEditorsChange(() => this._updateBrowserContext()));
		this._toolsStore.add(this.agentNetworkFilterService.onDidChange(() => this._updateBrowserContext()));

		this._updateBrowserContext();
	}

	/**
	 * Subscribe to sharingState changes on each known model so the workspace
	 * context updates whenever a page is shared or unshared.
	 */
	private _syncModelListeners(): void {
		const views = this.browserViewService.getContextualBrowserViews();
		// Remove listeners for views that no longer exist
		for (const id of this._modelListeners.keys()) {
			if (!views.has(id)) {
				this._modelListeners.deleteAndDispose(id);
			}
		}
		// Add listeners for new views
		for (const [id, input] of views) {
			if (!this._modelListeners.has(id) && input.model) {
				const store = new DisposableStore();
				store.add(input.onDidChangeLabel(() => this._updateBrowserContext()));
				store.add(input.model.onDidChangeSharingState(() => this._updateBrowserContext()));
				this._modelListeners.set(id, store);
			}
		}
	}

	private _updateBrowserContext(): void {
		const value = getBrowserPagesContext(this.editorService, this.browserViewService, this.agentNetworkFilterService, { canPromptUser: true });
		if (!value) {
			this.chatContextService.updateWorkspaceContextItems(BrowserChatAgentToolsContribution.CONTEXT_ID, []);
			return;
		}

		this.chatContextService.updateWorkspaceContextItems(BrowserChatAgentToolsContribution.CONTEXT_ID, [{
			handle: 0,
			label: localize('browserContext.label', "Browser Pages"),
			value: value
		}]);
	}
}
registerWorkbenchContribution2(BrowserChatAgentToolsContribution.ID, BrowserChatAgentToolsContribution, WorkbenchPhase.AfterRestored);
