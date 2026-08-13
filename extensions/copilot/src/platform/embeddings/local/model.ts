/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Descriptor for the local (ONNX) embedding model used by the `local`
 * indexing scheme.
 *
 * The model is downloaded on first use (keeps the installer lean) and cached
 * under `<globalStorageUri>/models/<id>/`. A SHA-256 is pinned so the model
 * can never be swapped without a review of this file.
 *
 * Default model: `BAAI/bge-small-en-v1.5` (384-dim, quantized ONNX export,
 * 512 max tokens). It is small (~25 MB), widely mirrored, and ships a
 * standard `tokenizer.json` (BERT BPE) that the bundled `BpeTokenizer` can
 * read without any extra dependency. Swapping to a code-oriented model is a
 * one-line change to this descriptor.
 */
export interface LocalEmbeddingModel {
	/** Stable id. Used as the `EmbeddingType.id` and cache key. */
	readonly id: string;
	/** Human-readable name shown in logs/telemetry. */
	readonly name: string;
	/** ONNX model file URL (pinned release mirror). */
	readonly modelUrl: string;
	/** `tokenizer.json` URL from the same mirror. */
	readonly tokenizerUrl: string;
	/** SHA-256 hex digest of the ONNX file. */
	readonly modelSha256: string;
	/** SHA-256 hex digest of the tokenizer file. */
	readonly tokenizerSha256: string;
	/** Embedding dimensions produced by the model. */
	readonly dimensions: number;
	/** Maximum sequence length in tokens. Longer inputs are truncated. */
	readonly maxTokens: number;
}

export const DEFAULT_LOCAL_EMBEDDING_MODEL: LocalEmbeddingModel = {
	id: 'bge-small-en-v1.5-384',
	name: 'BAAI/bge-small-en-v1.5 (ONNX, quantized)',
	modelUrl: 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx',
	tokenizerUrl: 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer.json',
	// Pinned SHA-256 hashes, verified on every download (fail closed). Updated
	// only when the mirror intentionally bumps the artifact.
	modelSha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
	tokenizerSha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
	dimensions: 384,
	maxTokens: 512,
};
