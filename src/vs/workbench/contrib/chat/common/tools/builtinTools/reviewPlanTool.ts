/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../../base/common/jsonSchema.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import { IEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IChatPlanApprovalAction, IChatPlanReviewResult, IChatService } from '../../chatService/chatService.js';
import { IChatRequestModel } from '../../model/chatModel.js';
import { ChatPlanReviewData } from '../../model/chatProgressTypes/chatPlanReviewData.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../languageModelToolsService.js';

export const ReviewPlanToolId = 'vscode_reviewPlan';

/**
 * The extension that owns the memory tool. Session-scoped memory files live
 * under this extension's workspace storage directory (mirrors
 * `extensions/copilot/src/extension/tools/node/memoryTool.tsx`).
 */
const MEMORY_TOOL_EXTENSION_ID = 'GitHub.copilot-chat';

/** Directory holding memory files under the extension's workspace storage. */
const MEMORY_BASE_DIR = 'memory-tool/memories';

/** Conventional name of the plan document persisted in session memory. */
const MEMORY_PLAN_FILE_NAME = 'plan.md';

export interface IReviewPlanParams {
	readonly title?: string;
	readonly plan?: string;
	readonly content: string;
	readonly actions: IChatPlanApprovalAction[];
	readonly canProvideFeedback: boolean;
}

export function createReviewPlanToolData(): IToolData {
	const approvalActionSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			label: {
				type: 'string',
				description: 'Short action label shown in the dropdown button.'
			},
			description: {
				type: 'string',
				description: 'Optional detail shown below the label in the dropdown list.'
			},
			default: {
				type: 'boolean',
				description: 'Whether this action should be selected by default.'
			},
			permissionLevel: {
				type: 'string',
				enum: ['autopilot'],
				description: 'When set to "autopilot", a confirmation dialog is shown before proceeding.'
			}
		},
		required: ['label']
	};

	const inputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description: 'Title displayed in the widget header. Defaults to "Plan summary" if omitted.'
			},
			plan: {
				type: 'string',
				description: 'Optional URI of an editable plan file. An Edit button in the widget header opens it in the editor. When omitted, the current chat session\'s memory plan file (`/memories/session/plan.md`) is used if one exists.'
			},
			content: {
				type: 'string',
				description: 'Markdown content rendered in the body of the widget. May be the plan summary or full plan text.'
			},
			actions: {
				type: 'array',
				description: 'List of approval actions offered in the primary dropdown button. Order is preserved.',
				items: approvalActionSchema,
				minItems: 1
			},
			canProvideFeedback: {
				type: 'boolean',
				description: 'When true, an additional feedback textarea is shown below the plan content.'
			}
		},
		required: ['content', 'actions', 'canProvideFeedback']
	};

	return {
		id: ReviewPlanToolId,
		toolReferenceName: 'reviewPlan',
		canBeReferencedInPrompt: false,
		icon: ThemeIcon.fromId(Codicon.checklist.id),
		displayName: localize('tool.reviewPlan.displayName', 'Review Plan'),
		userDescription: localize('tool.reviewPlan.userDescription', 'Ask the user to review and approve a plan before proceeding.'),
		modelDescription: 'Use this tool to present a plan to the user for review. Provide the plan content as markdown, a list of approval actions (with optional default), and whether the user can provide freeform feedback. Optionally provide a URI to the backing plan file so the user can edit it. The tool returns the chosen action, whether the plan was rejected, and any feedback.',
		source: ToolDataSource.Internal,
		inputSchema
	};
}

export const ReviewPlanToolData: IToolData = createReviewPlanToolData();

export class ReviewPlanTool extends Disposable implements IToolImpl {

	constructor(
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const parameters = invocation.parameters as IReviewPlanParams;
		const { title, plan, content, actions, canProvideFeedback } = parameters;

		if (!actions || actions.length === 0) {
			throw new Error(localize('reviewPlanTool.noActions', 'At least one approval action must be provided.'));
		}

		const { request } = this.getRequest(invocation.context?.sessionResource, invocation.chatRequestId);
		if (!request) {
			this.logService.warn('[ReviewPlanTool] Missing chat context; returning rejected result.');
			return this.toResult({ rejected: true });
		}

		let planUri: URI | undefined;
		if (plan) {
			try {
				planUri = URI.parse(plan);
			} catch {
				try {
					planUri = URI.file(plan);
				} catch {
					planUri = undefined;
				}
			}
		}

		// Planning agents (e.g. the Plan agent) persist their plan through the
		// memory tool rather than an SDK plan file, so their review arrives
		// without a `plan` URI. Fall back to the session's memory plan
		// document so the review card can offer the View Plan / Review
		// entry points backed by the real file.
		if (!planUri) {
			planUri = await this.resolveMemoryPlanUri(invocation.context?.sessionResource);
		}

		const reviewData = new ChatPlanReviewData(
			title ?? localize('reviewPlanTool.defaultTitle', 'Plan summary'),
			content,
			actions,
			canProvideFeedback,
			planUri?.toJSON(),
			generateUuid(),
		);

		this.chatService.appendProgress(request, reviewData);

		const result = await raceCancellation(reviewData.completion.p, token);
		if (token.isCancellationRequested) {
			reviewData.dismiss();
			throw new CancellationError();
		}

		return this.toResult(result ?? { rejected: true });
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as IReviewPlanParams;
		if (!parameters.actions || parameters.actions.length === 0) {
			throw new Error(localize('reviewPlanTool.noActions', 'At least one approval action must be provided.'));
		}
		return {
			invocationMessage: new MarkdownString(localize('reviewPlanTool.invocation', 'Asking you to review the plan')),
			pastTenseMessage: new MarkdownString(localize('reviewPlanTool.invocation.past', 'Asked you to review the plan'))
		};
	}

	private toResult(result: IChatPlanReviewResult): IToolResult {
		return {
			content: [{ kind: 'text', value: JSON.stringify(result) }]
		};
	}

	/**
	 * Resolves the session's memory plan document (`/memories/session/plan.md`)
	 * when the model didn't pass an explicit plan file. The memory tool stores
	 * session-scoped files under the copilot extension's workspace storage:
	 * `{workspaceStorageHome}/{workspaceId}/GitHub.copilot-chat/memory-tool/
	 * memories/{sessionDir}/plan.md`, where `sessionDir` is derived from the
	 * chat session resource the same way the memory tool derives it. Returns
	 * `undefined` when no such file exists.
	 */
	private async resolveMemoryPlanUri(sessionResource: URI | undefined): Promise<URI | undefined> {
		if (!sessionResource) {
			return undefined;
		}

		// Mirror `extractSessionId` in the memory tool: the last path segment
		// of the session resource, sanitized to safe directory characters.
		const segments = sessionResource.path.replace(/^\//, '').split('/');
		const raw = segments[segments.length - 1] || sessionResource.authority || '';
		const sessionDir = raw.replace(/[^a-zA-Z0-9_.-]/g, '_');
		if (!sessionDir) {
			return undefined;
		}

		const workspace = this.workspaceContextService.getWorkspace();
		if (!workspace.id) {
			return undefined;
		}

		const planUri = URI.joinPath(
			this.environmentService.workspaceStorageHome,
			workspace.id,
			MEMORY_TOOL_EXTENSION_ID,
			MEMORY_BASE_DIR,
			sessionDir,
			MEMORY_PLAN_FILE_NAME,
		);

		try {
			const stat = await this.fileService.stat(planUri);
			if (stat.isFile) {
				return planUri;
			}
		} catch {
			// No memory plan for this session — leave the review without a plan file.
		}
		return undefined;
	}

	private getRequest(chatSessionResource: URI | undefined, chatRequestId: string | undefined): { request: IChatRequestModel | undefined } {
		if (!chatSessionResource) {
			return { request: undefined };
		}
		const model = this.chatService.getSession(chatSessionResource);
		if (!model) {
			return { request: undefined };
		}
		let request: IChatRequestModel | undefined;
		if (chatRequestId) {
			request = model.getRequests().find(r => r.id === chatRequestId);
		}
		if (!request) {
			request = model.getRequests().at(-1);
		}
		return { request };
	}
}
