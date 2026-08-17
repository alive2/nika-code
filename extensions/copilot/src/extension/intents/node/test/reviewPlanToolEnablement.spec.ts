/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType, type RequestMetadata } from '@vscode/copilot-api';
import type * as vscode from 'vscode';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MockEndpoint } from '../../../../platform/endpoint/test/node/mockEndpoint';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { NullWorkspaceFileIndex } from '../../../../platform/workspaceChunkSearch/node/nullWorkspaceFileIndex';
import { IWorkspaceFileIndex } from '../../../../platform/workspaceChunkSearch/node/workspaceFileIndex';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { TestChatRequest } from '../../../test/node/testHelpers';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { TestToolsService } from '../../../tools/node/test/testToolsService';
import { getAgentTools } from '../agentIntent';

// ─── getAgentTools reviewPlan enablement ─────────────────────────

// The `vscode_reviewPlan` tool (Review Plan) cannot be referenced in prompts
// (`canBeReferencedInPrompt: false`), so it is enabled explicitly by
// `getAgentTools` for Plan-mode requests. These tests verify that gate.

describe('getAgentTools reviewPlan enablement', () => {
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;
	let toolsService: TestToolsService;
	let mockEndpoint: IChatEndpoint;

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		services.define(IWorkspaceFileIndex, new SyncDescriptor(NullWorkspaceFileIndex));
		services.define(IWorkspaceService, new SyncDescriptor(
			TestWorkspaceService,
			[
				[URI.file('/workspace')],
				[]
			]
		));
		accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		toolsService = accessor.get(IToolsService) as TestToolsService;

		// The review-plan tool is registered in core, not in the extension's
		// ToolRegistry, so register a stub with the same name for this harness.
		toolsService.addTestToolOverride(
			{
				name: ToolName.CoreReviewPlan,
				description: 'Ask the user to review and approve a plan before proceeding.',
				inputSchema: {},
				tags: [],
				source: undefined,
				fullReferenceName: 'reviewPlan'
			},
			{ invoke: async () => ({ content: [] }) } as unknown as vscode.LanguageModelTool<unknown>,
		);

		mockEndpoint = instantiationService.createInstance(MockEndpoint, undefined);
		(mockEndpoint as unknown as { urlOrRequestMetadata: string | RequestMetadata }).urlOrRequestMetadata = { type: RequestType.ChatCompletions };
	});

	afterAll(() => {
		accessor.dispose();
	});

	function hasReviewPlanTool(tools: readonly { name: string }[]): boolean {
		return tools.some(t => t.name === ToolName.CoreReviewPlan);
	}

	test('reviewPlan tool is not enabled for a plain agent request', async () => {
		const request = new TestChatRequest('fix the bug');
		const tools = await instantiationService.invokeFunction(getAgentTools, request, mockEndpoint);
		expect(hasReviewPlanTool(tools)).toBe(false);
	});

	test('reviewPlan tool is enabled when running in Plan mode', async () => {
		const request = new TestChatRequest('fix the bug');
		(request as any).modeInstructions2 = { name: 'Plan', content: 'You are a planning agent.' };
		const tools = await instantiationService.invokeFunction(getAgentTools, request, mockEndpoint);
		expect(hasReviewPlanTool(tools)).toBe(true);
	});

	test('reviewPlan tool is not enabled for other custom modes', async () => {
		const request = new TestChatRequest('fix the bug');
		(request as any).modeInstructions2 = { name: 'Ask', content: 'You are an asking agent.' };
		const tools = await instantiationService.invokeFunction(getAgentTools, request, mockEndpoint);
		expect(hasReviewPlanTool(tools)).toBe(false);
	});
});
