/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';

/**
 * NikaCode: opt-out switch for the safety rules block. On by default.
 * When turned off, the safety rules are omitted from every prompt.
 */
const SAFETY_RULES_CONFIG_KEY = 'nika.safetyRules.enabled';

function safetyRulesEnabled(configurationService: IConfigurationService): boolean {
	return configurationService.getNonExtensionConfig<boolean>(SAFETY_RULES_CONFIG_KEY) ?? true;
}

export class SafetyRules extends PromptElement {
	constructor(
		props: {},
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(props);
	}

	render() {
		if (!safetyRulesEnabled(this._configurationService)) {
			return undefined;
		}
		return (
			<>
				Follow Microsoft content policies.<br />
				Avoid content that violates copyrights.<br />
				If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can't assist with that."<br />
				Keep your answers short and impersonal.<br />
			</>
		);
	}
}

export class Gpt5SafetyRule extends PromptElement {
	constructor(
		props: {},
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(props);
	}

	render() {
		if (!safetyRulesEnabled(this._configurationService)) {
			return undefined;
		}
		return (
			<>
				Follow Microsoft content policies.<br />
				Avoid content that violates copyrights.<br />
				If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can't assist with that."<br />
			</>
		);
	}
}

export class LegacySafetyRules extends PromptElement {
	constructor(
		props: {},
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(props);
	}

	render() {
		if (!safetyRulesEnabled(this._configurationService)) {
			return undefined;
		}
		return (
			<>
				Follow Microsoft content policies.<br />
				Avoid content that violates copyrights.<br />
				If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, violent, or completely irrelevant to software engineering, only respond with "Sorry, I can't assist with that."<br />
				Keep your answers short and impersonal.<br />
			</>
		);
	}
}
