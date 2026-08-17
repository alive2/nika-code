/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { addTodoItemToMarkdown, applyTodoStatusToMarkdown, parsePlanChecklist, parseTodosFromMarkdown, todosFromChecklist } from '../../../common/planView/planChecklist.js';

suite('PlanView - planChecklist', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const sampleMarkdown = [
		'## Plan',
		'',
		'```mermaid',
		'graph TD; A-->B;',
		'```',
		'',
		'## Steps',
		'- [ ] Set up tokens',
		'- [>] Build the viewer',
		'- [x] Wire live updates',
		'1. [ ] Bonus task',
		'',
		'## Notes',
		'- [~] Restore from draft',
	].join('\n');

	test('parsePlanChecklist extracts items with marker-based statuses', () => {
		const items = parsePlanChecklist(sampleMarkdown);
		assert.deepStrictEqual(items.map(item => item.title), [
			'Set up tokens',
			'Build the viewer',
			'Wire live updates',
			'Bonus task',
			'Restore from draft',
		]);
		assert.deepStrictEqual(items.map(item => item.status), [
			'not-started',
			'in-progress',
			'completed',
			'not-started',
			'in-progress',
		]);
		assert.deepStrictEqual(items.map(item => item.lineIndex), [7, 8, 9, 10, 13]);
	});

	test('parsePlanChecklist ignores non-checkbox lines', () => {
		const items = parsePlanChecklist('plain text\n- not a checkbox\n- [ ] a real one');
		assert.deepStrictEqual(items.map(item => item.title), ['a real one']);
	});

	test('todosFromChecklist assigns sequential ids', () => {
		const todos = todosFromChecklist(parsePlanChecklist(sampleMarkdown));
		assert.deepStrictEqual(todos.map(todo => todo.id), [1, 2, 3, 4, 5]);
		assert.deepStrictEqual(todos[1], { id: 2, title: 'Build the viewer', status: 'in-progress' });
	});

	test('parseTodosFromMarkdown maps markdown checklist strings', () => {
		const todos = parseTodosFromMarkdown('- [ ] a\n- [x] b\n- [>] c');
		assert.deepStrictEqual(todos, [
			{ id: 1, title: 'a', status: 'not-started' },
			{ id: 2, title: 'b', status: 'completed' },
			{ id: 3, title: 'c', status: 'in-progress' },
		]);
	});

	test('applyTodoStatusToMarkdown toggles the matching line only', () => {
		const updated = applyTodoStatusToMarkdown(sampleMarkdown, 'Build the viewer', 'completed');
		assert.ok(updated.includes('- [x] Build the viewer'));
		assert.ok(updated.includes('- [ ] Set up tokens'));
		assert.ok(updated.includes('- [x] Wire live updates'));
	});

	test('applyTodoStatusToMarkdown matches by exact title and keeps the rest intact', () => {
		const updated = applyTodoStatusToMarkdown(sampleMarkdown, 'Wire live updates', 'not-started');
		assert.ok(updated.includes('- [ ] Wire live updates'));
		assert.ok(updated.includes('graph TD; A-->B;'));
	});

	test('applyTodoStatusToMarkdown returns original markdown when no line matches', () => {
		assert.strictEqual(applyTodoStatusToMarkdown(sampleMarkdown, 'Missing task', 'completed'), sampleMarkdown);
	});

	test('applyTodoStatusToMarkdown uses in-progress marker for in-progress status', () => {
		const updated = applyTodoStatusToMarkdown(sampleMarkdown, 'Set up tokens', 'in-progress');
		assert.ok(updated.includes('- [>] Set up tokens'));
	});

	test('addTodoItemToMarkdown appends after the last checklist line', () => {
		const updated = addTodoItemToMarkdown(sampleMarkdown, 'Polish');
		const lines = updated.split('\n');
		assert.strictEqual(lines[14], '- [ ] Polish');
		// Everything before the insertion point is preserved.
		assert.strictEqual(lines[13], '- [~] Restore from draft');
	});

	test('addTodoItemToMarkdown appends to the end when there is no checklist', () => {
		const updated = addTodoItemToMarkdown('Just prose', 'Only task');
		assert.strictEqual(updated, 'Just prose\n- [ ] Only task');
	});
});
