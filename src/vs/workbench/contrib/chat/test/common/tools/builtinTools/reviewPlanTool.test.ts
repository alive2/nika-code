/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../../base/common/cancellation.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IEnvironmentService } from '../../../../../../../platform/environment/common/environment.js';
import { IFileService, IFileStat } from '../../../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../../../platform/log/common/log.js';
import { Progress } from '../../../../../../../platform/progress/common/progress.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../../../platform/workspace/test/common/testWorkspace.js';
import { IChatService } from '../../../../common/chatService/chatService.js';
import { IChatRequestModel } from '../../../../common/model/chatModel.js';
import { ChatPlanReviewData } from '../../../../common/model/chatProgressTypes/chatPlanReviewData.js';
import { ReviewPlanTool } from '../../../../common/tools/builtinTools/reviewPlanTool.js';
import { IToolInvocation } from '../../../../common/tools/languageModelToolsService.js';

suite('ReviewPlanTool', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	const SESSION_RESOURCE = URI.parse('vscode-chat-session://local/Nzg0Mjg2YjktMDhmOS00MGEwLTg2NTctN2FmNjY0ZmU3NGEy');

	function createTool(opts: {
		statResult?: { isFile: boolean } | undefined;
		statError?: Error;
		chatRequestId?: string;
	}) {
		const captured: { review?: ChatPlanReviewData } = {};

		const chatService = {
			getSession: () => ({
				getRequests: () => [{ id: 'req-1' }] as IChatRequestModel[]
			}),
			appendProgress: (_request: IChatRequestModel, progress: unknown) => {
				captured.review = progress as ChatPlanReviewData;
				// Complete the review immediately so `invoke` can settle.
				captured.review.dismiss();
			},
		} as unknown as IChatService;

		const fileService = {
			stat: async () => {
				if (opts.statError) {
					throw opts.statError;
				}
				return (opts.statResult ?? { isFile: true }) as IFileStat;
			},
		} as unknown as IFileService;

		const environmentService = {
			workspaceStorageHome: URI.file('/mock-storage'),
		} as unknown as IEnvironmentService;

		const workspaceContextService = {
			getWorkspace: () => testWorkspace(),
		} as unknown as IWorkspaceContextService;

		const tool = testDisposables.add(new ReviewPlanTool(
			chatService,
			new NullLogService(),
			environmentService,
			fileService,
			workspaceContextService,
		));

		return { tool, captured };
	}

	function createInvocation(overrides?: Partial<IToolInvocation>): IToolInvocation {
		return {
			callId: 'call-1',
			toolId: 'vscode_reviewPlan',
			parameters: {
				content: 'Plan content',
				actions: [{ label: 'Implement Plan' }],
				canProvideFeedback: true,
			},
			context: { sessionResource: SESSION_RESOURCE },
			chatRequestId: 'req-1',
			...overrides,
		} as IToolInvocation;
	}

	suite('memory plan fallback', () => {
		test('resolves the session memory plan file when no plan URI is provided', async () => {
			const { tool, captured } = createTool({});
			await tool.invoke(createInvocation(), async () => 0, Progress.None, CancellationToken.None);

			const expectedUri = URI.joinPath(
				URI.file('/mock-storage'),
				'test-workspace',
				'GitHub.copilot-chat',
				'memory-tool',
				'memories',
				'Nzg0Mjg2YjktMDhmOS00MGEwLTg2NTctN2FmNjY0ZmU3NGEy',
				'plan.md',
			);
			assert.deepStrictEqual(captured.review?.planUri, expectedUri.toJSON());
		});

		test('keeps an explicit plan URI and does not consult the memory file', async () => {
			const { tool, captured } = createTool({});
			const invocation = createInvocation({
				parameters: {
					content: 'Plan content',
					actions: [{ label: 'Implement Plan' }],
					canProvideFeedback: true,
					plan: 'file:///custom/plan.md',
				},
			});
			await tool.invoke(invocation, async () => 0, Progress.None, CancellationToken.None);

			assert.deepStrictEqual(captured.review?.planUri, URI.file('/custom/plan.md').toJSON());
		});

		test('leaves planUri unset when no memory plan file exists', async () => {
			const { tool, captured } = createTool({ statError: new Error('not found') });
			await tool.invoke(createInvocation(), async () => 0, Progress.None, CancellationToken.None);

			assert.strictEqual(captured.review?.planUri, undefined);
		});

		test('leaves planUri unset when stat returns a non-file entry', async () => {
			const { tool, captured } = createTool({ statResult: { isFile: false } });
			await tool.invoke(createInvocation(), async () => 0, Progress.None, CancellationToken.None);

			assert.strictEqual(captured.review?.planUri, undefined);
		});

		test('leaves planUri unset when the invocation has no session resource', async () => {
			const { tool, captured } = createTool({});
			await tool.invoke(createInvocation({ context: undefined }), async () => 0, Progress.None, CancellationToken.None);

			assert.strictEqual(captured.review?.planUri, undefined);
		});
	});
});
