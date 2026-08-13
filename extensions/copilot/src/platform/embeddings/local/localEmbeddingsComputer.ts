/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { CancellationToken as InternalCancellationToken } from '../../../util/vs/base/common/cancellation';
import { EmbeddingType, Embeddings, IEmbeddingsComputer } from '../common/embeddingsComputer';
import { ModelManager } from './modelManager';

export const LOCAL_EMBEDDING_TYPE = EmbeddingType.nikaLocalBgeSmallEnV15;

/**
 * `IEmbeddingsComputer` implementation backed by the local ONNX model.
 *
 * It is NOT registered as a service — the `local` indexing scheme creates it
 * explicitly and routes only the `local` scheme's work through it. The remote
 * `IEmbeddingsComputer` service (Copilot token based) is untouched, so the
 * default experience is byte-for-byte unchanged.
 */
export class LocalEmbeddingsComputer implements IEmbeddingsComputer {
	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly _modelManager: ModelManager,
	) { }

	async computeEmbeddings(
		type: EmbeddingType,
		inputs: readonly string[],
		_options?: { readonly inputType?: 'document' | 'query' },
		_telemetryInfo?: TelemetryCorrelationId,
		token?: CancellationToken,
	): Promise<Embeddings> {
		if (!type.equals(LOCAL_EMBEDDING_TYPE)) {
			return { type, values: [] };
		}
		const internalToken = (token ?? InternalCancellationToken.None) as InternalCancellationToken;
		const vectors = await this._modelManager.embed(inputs, internalToken);
		return {
			type,
			values: vectors.map(vector => ({ type, value: Array.from(vector) })),
		};
	}
}
