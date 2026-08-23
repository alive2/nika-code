/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEEP_SEEK_WEB_WASM_BASE64 } from './deepSeekWebWasm';

/**
 * A DeepSeek web API proof-of-work challenge, as returned by
 * `POST /api/v0/chat/create_pow_challenge` (`data.biz_data.challenge`).
 */
export interface DeepSeekWebPowChallenge {
	readonly algorithm: string;
	readonly challenge: string;
	readonly salt: string;
	readonly difficulty: number;
	readonly expire_at: number;
	readonly signature: string;
	readonly target_path: string;
}

/** A solved challenge plus its metadata, mirroring the reference Python client's payload. */
export interface DeepSeekWebPowResult {
	readonly algorithm: string;
	readonly challenge: string;
	readonly salt: string;
	/** The numeric answer; `null` when no answer was found within the solver's search bounds. */
	readonly answer: number | null;
	readonly signature: string;
	readonly target_path: string;
}

interface DeepSeekWebWasmExports {
	readonly memory: { readonly buffer: ArrayBuffer };
	readonly wasm_solve: (retptr: number, challengePtr: number, challengeLen: number, prefixPtr: number, prefixLen: number, difficulty: number) => void;
	readonly __wbindgen_add_to_stack_pointer: (delta: number) => number;
	readonly __wbindgen_export_0: (len: number, align: number) => number;
}

/** Minimal shape of the `WebAssembly` global (no DOM lib in this tsconfig). */
declare const WebAssembly: {
	readonly Module: new (bytes: Buffer | ArrayBuffer) => unknown;
	readonly Instance: new (module: unknown, imports: Record<string, unknown>) => DeepSeekWebWasmInstance;
};

type DeepSeekWebWasmInstance = { exports: DeepSeekWebWasmExports };

/**
 * Solves DeepSeek's web proof-of-work challenge using the embedded
 * `wasm-deepseek-hash-v1` module. This is a line-by-line port of the
 * reference Python client's `DeepSeekPOW.solve_challenge` / `calculate_hash`
 * (dsk/pow.py): the challenge and the `{salt}_{expire_at}_` prefix are written
 * into the wasm module's memory, `wasm_solve` searches for an answer at the
 * given difficulty, and the result is returned as the base64-encoded JSON the
 * server expects in the `x-ds-pow-response` header.
 *
 * The wasm module is instantiated lazily and cached; it needs no imports, so
 * the plain `WebAssembly` API works in the extension host.
 */
export class DeepSeekWebPowSolver {
	private _instance: DeepSeekWebWasmInstance | undefined;

	private _instantiate(): DeepSeekWebWasmInstance {
		if (this._instance) {
			return this._instance;
		}
		const bytes = Buffer.from(DEEP_SEEK_WEB_WASM_BASE64, 'base64');
		// The module imports nothing, so an empty import object is sufficient.
		this._instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
		return this._instance;
	}

	/**
	 * Solves a challenge and returns the base64-encoded `x-ds-pow-response`
	 * value. When the solver cannot find an answer (status 0), `answer` is
	 * `null` and the encoded payload is still returned — matching the
	 * reference client, which lets the server reject the request.
	 */
	solveChallenge(challenge: DeepSeekWebPowChallenge): string {
		const exports = this._instantiate().exports as unknown as DeepSeekWebWasmExports;
		const answer = this._calculateHash(exports, challenge);
		const result: DeepSeekWebPowResult = {
			algorithm: challenge.algorithm,
			challenge: challenge.challenge,
			salt: challenge.salt,
			answer,
			signature: challenge.signature,
			target_path: challenge.target_path,
		};
		return Buffer.from(JSON.stringify(result)).toString('base64');
	}

	private _calculateHash(exports: DeepSeekWebWasmExports, challenge: DeepSeekWebPowChallenge): number | null {
		// The prefix the solver mixes with the challenge: `{salt}_{expire_at}_`.
		const prefix = `${challenge.salt}_${challenge.expire_at}_`;
		const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
		try {
			const [challengePtr, challengeLen] = this._writeString(exports, challenge.challenge);
			const [prefixPtr, prefixLen] = this._writeString(exports, prefix);

			exports.wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, challenge.difficulty);

			const memory = new DataView(exports.memory.buffer);
			const status = memory.getInt32(retptr, true);
			if (status === 0) {
				return null;
			}
			// The answer is returned as an f64 at retptr + 8 (little-endian),
			// exactly as the reference client reads it with numpy and floors
			// to an integer.
			return Math.floor(memory.getFloat64(retptr + 8, true));
		} finally {
			exports.__wbindgen_add_to_stack_pointer(16);
		}
	}

	private _writeString(exports: DeepSeekWebWasmExports, text: string): [number, number] {
		const encoded = Buffer.from(text, 'utf8');
		const ptr = exports.__wbindgen_export_0(encoded.length, 1);
		new Uint8Array(exports.memory.buffer).set(encoded, ptr);
		return [ptr, encoded.length];
	}
}
