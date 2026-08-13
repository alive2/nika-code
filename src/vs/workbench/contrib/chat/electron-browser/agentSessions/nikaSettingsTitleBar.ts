/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './media/nikaSettingsTitleBar.css';
import { $, append } from '../../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';

const NIKA_SETTINGS_TITLE_BAR_COMMAND_ID = 'workbench.action.openNikaSettings';
const NIKA_OPEN_SETTINGS_COMMAND_ID = 'nika.openSettings';

/**
 * Title bar entry that opens the Nika Settings webview, sitting right next to
 * the "Open in Agents" button (Cursor-style settings affordance).
 */
export class OpenNikaSettingsTitleBarAction extends Action2 {
	constructor() {
		super({
			id: NIKA_SETTINGS_TITLE_BAR_COMMAND_ID,
			title: localize2('openNikaSettings', "Nika Settings"),
			f1: false,
			menu: {
				id: MenuId.TitleBarAdjacentCenter,
				order: -999,
				when: IsSessionsWindowContext.negate(),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(ICommandService).executeCommand(NIKA_OPEN_SETTINGS_COMMAND_ID);
	}
}

/**
 * Renders the "Nika Settings" titlebar entry as an icon-only button that
 * expands to reveal a label on hover / keyboard focus, matching the
 * "Open in Agents" widget next to it.
 */
class NikaSettingsTitleBarWidget extends BaseActionViewItem {

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('nika-settings-titlebar-widget');
		container.setAttribute('role', 'button');

		const label = this.action.label;
		const hoverText = this.keybindingService.appendKeybinding(localize('openNikaSettingsHover', "Nika Settings"), NIKA_SETTINGS_TITLE_BAR_COMMAND_ID);
		container.setAttribute('aria-label', hoverText);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, hoverText));

		const icon = append(container, $('span.nika-settings-titlebar-widget-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.settingsGear));
		icon.setAttribute('aria-hidden', 'true');

		const labelEl = append(container, $('span.nika-settings-titlebar-widget-label'));
		labelEl.textContent = label;
	}
}

export class OpenNikaSettingsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openNikaSettings.desktop';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, NIKA_SETTINGS_TITLE_BAR_COMMAND_ID, (action, options) => {
			return instantiationService.createInstance(NikaSettingsTitleBarWidget, action, options);
		}, undefined));
	}
}
