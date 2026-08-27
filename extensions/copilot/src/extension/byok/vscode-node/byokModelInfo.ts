/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { type LanguageModelChatInformation } from 'vscode';
import { BYOKKnownModels, BYOKModelCapabilities, byokKnownModelToAPIInfo } from '../common/byokProvider';
import { buildReasoningEffortSchemaProperty, buildSpeedSchemaProperty } from '../../conversation/common/languageModelAccess';

/**
 * Wraps {@link byokKnownModelToAPIInfo} and enriches the model entry with
 * a localized configurationSchema for the "Thinking Effort" picker when the
 * model's capabilities include `supportsReasoningEffort`.
 */
export function byokKnownModelToAPIInfoWithEffort(providerName: string, id: string, capabilities: BYOKModelCapabilities): LanguageModelChatInformation {
	const model = byokKnownModelToAPIInfo(providerName, id, capabilities);
	const effortLevels = capabilities.supportsReasoningEffort;
	if (!effortLevels || effortLevels.length === 0) {
		return model;
	}
	const reasoningEffort = buildReasoningEffortSchemaProperty(effortLevels, model.family);
	if (capabilities.defaultReasoningEffort && effortLevels.includes(capabilities.defaultReasoningEffort)) {
		reasoningEffort.default = capabilities.defaultReasoningEffort;
	}
	return {
		...model,
		configurationSchema: {
			properties: {
				reasoningEffort,
			},
		},
	};
}

/**
 * Like {@link byokKnownModelToAPIInfoWithEffort} but for a map of known models.
 */
export function byokKnownModelsToAPIInfoWithEffort(providerName: string, knownModels: BYOKKnownModels | undefined): LanguageModelChatInformation[] {
	if (!knownModels) {
		return [];
	}
	return Object.entries(knownModels).map(([id, capabilities]) => byokKnownModelToAPIInfoWithEffort(providerName, id, capabilities));
}

/** The speed tiers the codex backend accepts (Standard / Fast). */
export const CODEX_SPEED_TIERS: readonly string[] = ['standard', 'fast'];

/**
 * Like {@link byokKnownModelToAPIInfoWithEffort} but also enriches the entry
 * with the codex-style Speed control (Standard / Fast → `service_tier`).
 */
export function byokKnownModelToAPIInfoWithEffortAndSpeed(providerName: string, id: string, capabilities: BYOKModelCapabilities): LanguageModelChatInformation {
	const model = byokKnownModelToAPIInfoWithEffort(providerName, id, capabilities);
	return {
		...model,
		configurationSchema: {
			properties: {
				...model.configurationSchema?.properties,
				speed: buildSpeedSchemaProperty(CODEX_SPEED_TIERS),
			},
		},
	};
}
