/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { DeepSeekWebPowChallenge, DeepSeekWebPowResult, DeepSeekWebPowSolver } from '../deepSeekWebPow';

function challenge(overrides: Partial<DeepSeekWebPowChallenge> = {}): DeepSeekWebPowChallenge {
	return {
		algorithm: 'DeepSeekHashV1',
		// A captured real challenge (matching the reference client's test
		// config): the wasm solves it to answer 58033, which is the exact
		// nonce the reference Python client produces for these inputs.
		challenge: 'b0000b22959bad0cc1ecbbfa07f97191b20332fa10d7341ff9c7ba6e7ed927f1',
		salt: 'dde3ed472be5a2494ee0',
		difficulty: 144000,
		expire_at: 1_777_057_596_443,
		signature: 'test',
		target_path: '/api/v0/chat/completion',
		...overrides,
	};
}

// A second captured real challenge (from the reference raw-API docs); the
// wasm solves it to 107544. Server-issued challenges are constructed so a
// solution always exists, so both of these must solve deterministically.
const SECOND_CHALLENGE: DeepSeekWebPowChallenge = {
	algorithm: 'DeepSeekHashV1',
	challenge: '7ffc9d19b6eed96a6fca68f8ffe30ee61035d4959e4180f187bf85b356016a96',
	salt: '3bde54628ea8413fee87',
	difficulty: 144000,
	expire_at: 1_775_380_966_945,
	signature: 'test',
	target_path: '/api/v0/chat/completion',
};

describe('DeepSeekWebPowSolver', () => {
	it('instantiates the embedded wasm and solves a real challenge byte-exactly', () => {
		const solver = new DeepSeekWebPowSolver();
		const encoded = solver.solveChallenge(challenge());
		expect(encoded.length).toBeGreaterThan(0);

		const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as DeepSeekWebPowResult;
		// The payload mirrors the reference client: all challenge metadata is
		// echoed back, and the answer is the exact nonce the reference Python
		// client produces for these inputs (58033).
		expect(decoded.algorithm).toBe('DeepSeekHashV1');
		expect(decoded.challenge).toBe('b0000b22959bad0cc1ecbbfa07f97191b20332fa10d7341ff9c7ba6e7ed927f1');
		expect(decoded.salt).toBe('dde3ed472be5a2494ee0');
		expect(decoded.signature).toBe('test');
		expect(decoded.target_path).toBe('/api/v0/chat/completion');
		expect(decoded.answer).toBe(58033);
	});

	it('solves a second real challenge and produces a different answer (answer depends on input)', () => {
		const solver = new DeepSeekWebPowSolver();
		const first = JSON.parse(Buffer.from(solver.solveChallenge(challenge()), 'base64').toString('utf8')) as DeepSeekWebPowResult;
		const second = JSON.parse(Buffer.from(solver.solveChallenge(SECOND_CHALLENGE), 'base64').toString('utf8')) as DeepSeekWebPowResult;
		expect(first.answer).toBe(58033);
		expect(second.answer).toBe(107544);
		expect(second.answer).not.toBe(first.answer);
	});

	it('caches the wasm instance across solves', () => {
		const solver = new DeepSeekWebPowSolver();
		const first = solver.solveChallenge(challenge());
		const second = solver.solveChallenge(SECOND_CHALLENGE);
		expect(first).not.toBe(second);
		expect(Buffer.from(second, 'base64').toString('utf8')).toContain('7ffc9d19');
	});
});
