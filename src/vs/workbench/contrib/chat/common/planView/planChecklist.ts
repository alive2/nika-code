/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatTodo } from '../tools/chatTodoListService.js';

/**
 * A single checklist item parsed from plan markdown, retaining enough
 * original context to write status changes back to the file.
 */
export interface IPlanChecklistItem {
	/** Display title (checkbox marker removed). */
	title: string;
	status: IChatTodo['status'];
	/** The full original line, e.g. `- [>] Build the viewer`. */
	line: string;
	/** 0-based line index in the markdown source. */
	lineIndex: number;
}

const checklistLineRegex = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX>~])\]\s+(.*)$/;

export function checklistStatusFromMarker(marker: string): IChatTodo['status'] {
	switch (marker.toLowerCase()) {
		case 'x':
			return 'completed';
		case '>':
		case '~':
			return 'in-progress';
		default:
			return 'not-started';
	}
}

export function markerFromStatus(status: IChatTodo['status']): string {
	switch (status) {
		case 'completed':
			return 'x';
		case 'in-progress':
			return '>';
		default:
			return ' ';
	}
}

/**
 * Parse every markdown task-list line (`- [ ]`, `- [x]`, `- [>]`, `- [~]`,
 * ordered or unordered) into {@link IPlanChecklistItem}s. The `>` / `~`
 * markers follow Cursor's convention for an in-progress task.
 */
export function parsePlanChecklist(markdown: string): IPlanChecklistItem[] {
	const items: IPlanChecklistItem[] = [];
	const lines = markdown.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = checklistLineRegex.exec(lines[i]);
		if (!match) {
			continue;
		}
		items.push({
			title: match[2].trim(),
			status: checklistStatusFromMarker(match[1]),
			line: lines[i],
			lineIndex: i,
		});
	}
	return items;
}

/** Convenience: map plan checklist items to the live todo shape. */
export function todosFromChecklist(items: IPlanChecklistItem[]): IChatTodo[] {
	return items.map((item, index) => ({ id: index + 1, title: item.title, status: item.status }));
}

/** Parse a markdown checklist string (e.g. `update_todo` tool args) into todos. */
export function parseTodosFromMarkdown(markdown: string): IChatTodo[] {
	return todosFromChecklist(parsePlanChecklist(markdown));
}

/**
 * Rewrite the checkbox marker of the first checklist line whose title matches
 * `title`, returning the updated markdown. Returns the original markdown when
 * no line matches.
 */
export function applyTodoStatusToMarkdown(markdown: string, title: string, status: IChatTodo['status']): string {
	const marker = markerFromStatus(status);
	const lines = markdown.split(/\r?\n/);
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const match = checklistLineRegex.exec(lines[i]);
		if (!match || match[2].trim() !== title) {
			continue;
		}
		const markerIndexInLine = lines[i].indexOf(match[0]) + match[0].indexOf('[') + 1;
		lines[i] = lines[i].slice(0, markerIndexInLine) + marker + lines[i].slice(markerIndexInLine + 1);
		changed = true;
		break;
	}
	return changed ? lines.join('\n') : markdown;
}

/**
 * Insert `- [ ] <title>` after the last contiguous checklist line (or at the
 * end of the document when there is none). Returns the updated markdown.
 */
export function addTodoItemToMarkdown(markdown: string, title: string): string {
	const lines = markdown.split(/\r?\n/);
	let lastChecklistLine = -1;
	for (let i = 0; i < lines.length; i++) {
		if (checklistLineRegex.test(lines[i])) {
			lastChecklistLine = i;
		}
	}
	const insertAt = lastChecklistLine === -1 ? lines.length : lastChecklistLine + 1;
	lines.splice(insertAt, 0, `- [ ] ${title}`);
	return lines.join('\n');
}
