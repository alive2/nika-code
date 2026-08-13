# NikaCode Semantic Indexing — Design & Implementation Plan

**Status:** **Implemented (M0, M1, M2, M3, M5 — see §12 "Shipped reality").**
The `local` scheme is fully functional: real ONNX embeddings (BAAI
`bge-small-en-v1.5`, quantized, 384-dim) running in-process via
`onnxruntime-node`, a `node:sqlite` vector store, git-hash incremental
indexing, live progress in **Nika's dashboard** (the Nika Settings webview,
`nika.openSettings`), a status-bar item, telemetry, and model download UX.
`M4` (`cloud`, Cursor-style Merkle sync) remains optional/unimplemented.

This doc is grounded in the fork's actual source. Companion docs:
[`SEMANTIC-INDEXING.md`](SEMANTIC-INDEXING.md) (Copilot vs Cursor),
[`CURSOR-INDEXING-REVERSE-ENGINEERING.md`](CURSOR-INDEXING-REVERSE-ENGINEERING.md)
(Cursor internals), [`VSCODE-CORE-VS-CURSOR-INDEXING.md`](VSCODE-CORE-VS-CURSOR-INDEXING.md)
(VS Code core vs Cursor). **The executable task breakdown is in
[`INDEXING-PLAN.md`](INDEXING-PLAN.md)** (milestones, exact files, acceptance
criteria, tests).

---

## 1. What we're building (one paragraph)

A **scheme-selectable semantic index** for NikaCode:

- A setting — `nika.indexing.scheme` — that is **per-workspace** with a
  **configurable default** (like every VS Code resource-scoped setting).
- Four schemes: `off` (today's behavior), `github-remote` (reuse Copilot's
  existing GitHub index), `local` (fully offline ONNX embeddings + local
  vector store), `cloud` (Cursor-style: Merkle-sync client + backend).
- The setting and a **live progress view** (status, files indexed / total,
  errors, rebuild button, per-workspace override indicator) live in **Nika's
  dashboard** — a new `indexing` section of the Nika Settings webview.

**No server is required** for the `local` scheme. A server is only required
for the `cloud` scheme, and even that can be a thin BYOK proxy. Details below.

---

## 2. Grounding: what the fork already has

| Asset | Where | Reuse for |
| --- | --- | --- |
| Nika dashboard (webview) | `extensions/copilot/src/extension/byok/vscode-node/nikaSettingsEditor.ts` — command `nika.openSettings`, sections `overview/providers/models/vision/pdf/agents/diagnostics`, settings under `vscode.workspace.getConfiguration('nika')`, `_state()` + `saveSetting`/`_onMessage`, output channel "Nika" | New `indexing` section + progress |
| Copilot indexing engine (extension-side) | `extensions/copilot/src/platform/workspaceChunkSearch/` — `IWorkspaceChunkSearchService` (DI identifier), `WorkspaceChunkSearchServiceImpl` (strategy: `CodeSearchChunkSearch`), `WorkspaceFileIndex` (scan + ignore), `WorkspaceChunkEmbeddingsIndex` (**already exposes `getIndexState(): {indexedFileCount, totalFileCount}` and `onDidChangeWorkspaceIndexState`**) | Engine skeleton, file index, state/progress events |
| Local cache w/ SQLite | `extensions/copilot/src/platform/workspaceChunkSearch/node/workspaceChunkAndEmbeddingCache.ts` — uses **`node:sqlite`** (Node 22 built-in); `@vscode/sqlite3@5.1.12-vscode` already in `package.json` | **Local vector store — no new native dep** |
| Embedding abstraction | `extensions/copilot/src/platform/embeddings/common/` — `IEmbeddingsComputer`, `RemoteEmbeddingsComputer` (needs Copilot token), `EmbeddingType` | The seam where `local` vs `cloud` plug in |
| Remote chunking | `extensions/copilot/src/platform/chunking/common/chunkingEndpointClient.ts` (+Impl, rate-limited queue) | Reference for a local chunker (`naiveChunker` exists) |
| Search-view AI hook | `AITextSearchProvider` (proposed API, `src/vscode-dts/vscode.proposed.aiTextSearchProvider.d.ts`) registered by Copilot in `conversationFeature.ts` → `SemanticSearchTextSearchProvider` | Bridge local/cloud search into the Search view |
| Lexical search | ripgrep (`@vscode/ripgrep-universal ^1.18.0`), `RipgrepTextSearchEngine` | Baseline lexical (phase 1); snapshot grep is an optimization |
| Core search settings | `search.searchView.semanticSearchBehavior` (`manual`/`runOnEmpty`/`auto`) | When AI results appear in Search view |

**Key fact:** there is currently **zero local ML in the fork** — no ONNX
runtime, no `transformers.js`, no ANN lib. Copilot's embeddings are always a
remote RPC. Everything embedding-shaped for `local` is net-new (but small).

---

## 3. Do we need a server? (the four components)

Cursor's "Merkle-synced server-side semantic index + local snapshot grep"
decomposes into four independent pieces:

| # | Component | Cursor does | Server needed? | NikaCode plan |
| --- | --- | --- | --- | --- |
| A | **Snapshot grep** (lexical) | `crepe` snapshot index from a git commit | ❌ | Start with plain ripgrep; add crepe-like snapshot later (optional) |
| B | **Change tracking** | Merkle tree of file hashes (native Rust) | ❌ (it's just incremental change detection) | Use **git blob hashes** — git already is a Merkle tree; no new hasher |
| C | **Embeddings** | server (`GetEmbeddings`: Qwen 1.5B / Voyage / OpenAI) | ⚠️ **the only real decision** | `local`: ONNX in-process · `cloud`: backend / BYOK API |
| D | **Vector store + search** | server KNN + rerank | ❌ (scale-only) | `local`: `node:sqlite` (already present) with float32 BLOB + cosine · `cloud`: server |

**Conclusion: a server is optional, not required.** The architecture is
identical either way — only *where `embed(file) → vector` executes* differs.
The Merkle/git-hash sync client you'd build for `cloud` is the same code used
for `local`'s incremental re-embedding.

### Server options for the `cloud` scheme (if/when wanted)

| Option | Infra you run | Code leaves machine? | Effort |
| --- | --- | --- | --- |
| **BYOK embedding API proxy** | none (API key, e.g. Voyage/OpenAI/Jina) | yes | low — a thin client, fits Nika's BYOK spirit |
| **Self-hosted service** | your own service (embed + KNN + rerank), e.g. on the same Cloudflare Worker infra as the updater | yes | medium-high |
| **Reuse Copilot's GitHub index** | none (already built) = `github-remote` scheme | yes (GitHub) | **zero** — exists today |

---

## 4. The scheme model

### 4.1 Setting

```jsonc
// registered in extensions/copilot/package.json under "configuration": { "title": "Nika", "properties": {...} }
"nika.indexing.scheme": {
  "type": "string",
  "enum": ["off", "github-remote", "local", "cloud"],
  "enumDescriptions": [
    "No semantic index (ripgrep search only).",
    "Reuse GitHub Copilot's existing remote index (needs GitHub sign-in).",
    "Fully local: ONNX embeddings + local vector store. Offline, private.",
    "Cursor-style: Merkle-sync to a Nika backend (or BYOK embedding API)."
  ],
  "default": "off",              // ← the default
  "scope": "resource",           // ← overridable per workspace via .vscode/settings.json
  "tags": ["preview"]
}
```

- **Default**: the setting's `default` (`off` initially; ship with `local`
  once stable).
- **Per workspace**: resource scope means `.vscode/settings.json` /
  workspace settings override the user default — zero custom plumbing.
- The dashboard writes it with the right target:
  - "Set as my default" → `ConfigurationTarget.User` (or `Global`, matching
    how the dashboard saves today),
  - "Set for this workspace" → `ConfigurationTarget.Workspace`.

### 4.2 The scheme abstraction (extension-side)

```ts
// extensions/copilot/src/platform/workspaceChunkSearch/common/... (new)
interface IIndexingScheme extends IDisposable {
    readonly id: 'off' | 'github-remote' | 'local' | 'cloud';
    getState(): IndexingState;                 // { status, indexedFileCount, totalFileCount, lastError? }
    readonly onDidChangeState: Event<void>;    // drive the dashboard progress
    search(query: WorkspaceChunkQuery, token: CancellationToken): Promise<StrategySearchResult>;
    build(reason: BuildIndexTriggerReason, onProgress, token): Promise<void>;  // (re)index
    isAvailable(): boolean;                    // e.g. github-remote needs auth
}
```

A `IndexingSchemeManager` (DI: `IIndexingSchemeManager`) watches
`nika.indexing.scheme`, instantiates the matching scheme, and exposes a
single `IWorkspaceChunkSearchService`-compatible surface so **existing
consumers don't change**: the agent `#codebase` tool, the Search-view
`AITextSearchProvider`, and the dashboard all talk to one facade. This mirrors
how `WorkspaceChunkSearchServiceImpl` already swaps `CodeSearchChunkSearch`.

| Scheme | Engine | Reuses | New |
| --- | --- | --- | --- |
| `off` | none | ripgrep (unchanged) | — |
| `github-remote` | Copilot `CodeSearchChunkSearch` | everything (`GithubCodeSearchRepo`, external ingest, status polling) | — |
| `local` | ONNX embed + sqlite ANN + git-hash incremental | `WorkspaceFileIndex`, `naiveChunker`, cache plumbing | `LocalEmbeddingsComputer`, ANN store, `LocalChunkSearch` |
| `cloud` | Merkle/git-hash sync → backend | same file index + sync client | sync client, backend (or BYOK API client) |

---

## 5. The `local` scheme design (no server)

### 5.1 Embeddings

- Add `onnxruntime-node` (or `@huggingface/transformers` w/ `ort`) + a small
  code embedding model, quantized:
  - `jina-embeddings-v2-small-code` (33M, ~70 MB fp32 / ~25 MB quantized), or
  - `nomic-embed-text-v1.5` (137M, quantized ~55 MB).
- Implement `LocalEmbeddingsComputer implements IEmbeddingsComputer` — same
  interface as `RemoteEmbeddingsComputer`, so the cache/search layer is
  unchanged. Tokenizer via a tiny bundled tokenizer (or reuse Copilot's
  `ITokenizerProvider` if the model's tokenizer is compatible).
- Model files ship in the extension (or are downloaded on first `local`
  use to `~/.nika/models` — avoid bloating the installer; keep parity with
  how VS Code handles optional binaries).

### 5.2 Vector store (no new native dependency)

- Use **`node:sqlite`** (already used by Copilot's cache) or `@vscode/sqlite3`
  (already a dep). Schema per workspace index DB under the extension's
  `storageUri`:
  - `chunks(id, path, rel_path, start, end, hash, embedding BLOB /* f32 */, model)`
  - `meta(key, value)` — model id, index version, last commit
- Search: FTS5 for keyword (optional) + cosine over the embedding column
  (SQL-side math or JS loop for < ~50k chunks; an in-memory IVFFlat index is a
  later optimization). `top_k` + optional local rerank (small cross-encoder
  via the same ONNX runtime, or skip — matches Cursor's `NONE` option).

### 5.3 Incremental (the "Merkle" part, done with git)

- The repo already hashes file contents (git blob hashes). Track
  `path → blob-hash` per file; on file change, only re-embed changed files.
  This is functionally Cursor's `SyncMerkleSubtreeV2`/`FastUpdateFileV2`,
  minus the network.
- Initial build streams through the existing `Limiter`/progress patterns from
  `WorkspaceChunkEmbeddingsIndex` (max ~8 concurrent embedding ops).

### 5.4 Lexical (snapshot grep)

- Phase 1: use ripgrep as-is (already the lexical path).
- Optional phase: a crepe-like **git-commit snapshot** so grep is O(index)
  — a native (Rust) helper or an FTS5 snapshot in `node:sqlite`. Deferred;
  not required for the scheme to be useful.

---

## 6. The `cloud` scheme design (server, optional)

- Same file index + a **sync client**: hash tree → push changed files to a
  backend (mirror Cursor's `FastRepoInitHandshakeV2`→`SyncMerkleSubtreeV2`→
  `FastUpdateFileV2`→`FastRepoSyncComplete`).
- Backend options (see §3): **BYOK embedding API** (lowest effort, no infra)
  or **self-hosted** embed+KNN+rerank service.
- Encrypt paths client-side (port Cursor's AES-256-CTR scheme, or use a
  simpler per-repo key) if code leaves the machine — otherwise plaintext.
- **Not in phase 1–2.** The client design is shared with `local` (change
  detection), so the work is mostly the transport + backend.

---

## 7. Nika dashboard integration (the setting + progress)

### 7.1 New `indexing` section

Add `'indexing'` to `NikaSettingsSection` in `nikaSettingsEditor.ts` and a
section entry in the webview HTML. The section shows:

| Control | Behavior |
| --- | --- |
| **Scheme picker** (`off`/`github-remote`/`local`/`cloud`) | Saves `nika.indexing.scheme` |
| **Scope row** — "Default" vs "This workspace" | Writes `ConfigurationTarget.User` vs `.Workspace`; shows a "workspace override" badge when the workspace value differs from default (like the existing `setting-overridden` pattern in the chat status dashboard) |
| **Status card** | Current status (`idle` / `building` / `indexing` / `synced` / `error`), `files indexed / total`, last error, progress bar |
| **Actions** | "Build / Rebuild index", "Clear index" |
| **Scheme explainer** | One-liner per scheme (from the enumDescriptions) |

### 7.2 Progress streaming (trivially easy — same process)

The dashboard and the engine are **both in the extension host**, so no
cross-process bridge is needed:

- `_state()` adds `indexing: { scheme, status, indexedFileCount, totalFileCount, lastError }` pulled from `IIndexingSchemeManager`.
- The manager's `onDidChangeState` (fed by `WorkspaceChunkEmbeddingsIndex.onDidChangeWorkspaceIndexState` / the local equivalent, already debounced 2.5 s) triggers `_render()` — the dashboard already re-renders on config/secret changes, so this is the same mechanism.
- Alternatively, a `postMessage({ type: 'indexingProgress', ... })` for a live bar without full re-render (the webview already has a message channel).
- Status-bar affordance (optional, Cursor-style "Indexing…") can reuse the workbench status item pattern (`workspaceIndexingStatus.ts` in Copilot).

---

## 8. Data & storage layout

| Data | Location |
| --- | --- |
| Setting (default) | user settings (`nika.indexing.scheme`) |
| Setting (per workspace) | `.vscode/settings.json` (resource scope) |
| Local index DB | `<extension storageUri>/indexing/<workspace-hash>/index.sqlite` (`node:sqlite`) |
| Model files (local scheme) | `~/.nika/models/` (downloaded on first use) |
| Scheme state | `WorkspaceState` (like Cursor's `anysphere.cursor-retrieval` key) |

---

## 9. Privacy & security

- `off` and `local`: **code never leaves the machine** (local is the privacy
  story — matches "VS Code core never uploads").
- `github-remote`: code leaves to GitHub (existing Copilot behavior/policy).
- `cloud`: code leaves to your backend/BYOK provider — make it explicit in the
  dashboard ("This scheme sends file content to <endpoint>" warning), port
  Cursor's path encryption if self-hosted, and gate the scheme off when Nika
  Privacy Mode (if any) is on — mirroring Cursor's `pathKey: ""`.
- Model downloads: pin hashes (like the update worker's SHA-256 flow).

---

## 10. Effort & risk

| Piece | Effort (rough) | Risk |
| --- | --- | --- |
| Setting + dashboard `indexing` section (no engine) | 1–2 days | low |
| `IndexingSchemeManager` + scheme facade | 2–3 days | low |
| `local` embeddings (ONNX + model + tokenizer) | 3–5 days | med — model size, WASM/CUDA on Windows, first-load UX |
| `local` ANN store on `node:sqlite` | 2–3 days | low |
| Incremental via git hashes | 1–2 days | low |
| Search integration (`#codebase` + `AITextSearchProvider`) | 2–3 days | low-med |
| Snapshot grep (crepe-like) | optional, 5–10 days | med (native helper) |
| `cloud` scheme + BYOK client | 5–8 days + backend | med (infra/keys) |
| Tests + docs + packaging (model download) | 2–3 days | low |

**MVP ≈ 2–3 weeks** for `off` + `github-remote` + `local` with dashboard
setting and progress.

---

## 11. Implementation plan

### Phase 0 — Foundation: setting + dashboard shell (no engine)
1. Add `nika.indexing.scheme` (enum, `resource` scope, default `off`) to
   `extensions/copilot/package.json` `configuration` + localize strings.
2. `nikaSettingsEditor.ts`: add `'indexing'` to `NikaSettingsSection` +
   `SETTINGS`; add section HTML (scheme picker, scope toggle, status card
   placeholder, rebuild button wired to a stub message).
3. `_state()` returns `indexing: { scheme, scope, status: 'unavailable' }`;
   `saveSetting` handles `indexing.scheme` with a target param
   (`user` | `workspace`).
4. Add `IIndexingSchemeManager` (DI) with an `off` + `github-remote`
   passthrough (returns existing `CodeSearchChunkSearch` state).
5. **Tests**: dashboard `_state`/`saveSetting` unit tests (scheme + scope);
   config registration smoke test. **Validate**: `npm run compile` in
   `extensions/copilot`, `npm run transpile-client`.

### Phase 1 — `local` engine core (no server)
6. Add deps: `onnxruntime-node`, model downloader (pinned hashes,
   `~/.nika/models`), tokenizer.
7. `LocalEmbeddingsComputer implements IEmbeddingsComputer`; reuse
   `naiveChunker` + `WorkspaceFileIndex`.
8. ANN store on `node:sqlite` (`index.sqlite`): schema, upsert, cosine
   `top_k`.
9. `LocalChunkSearch implements IIndexingScheme`: incremental via git blob
   hashes; `build()` with progress; `getState()`.
10. **Tests**: embeddings (tiny model, smoke), store round-trip, incremental
    (add/edit/delete file → only changed re-embedded). **Validate**:
    extension unit tests via `scripts/test.bat --grep`.
11. Manual: open workspace → set `local` in dashboard → progress bar moves →
    search returns results offline.

### Phase 2 — Search integration + dashboard progress
12. Wire `IIndexingSchemeManager` into the `#codebase` agent path
    (`codebaseTool.tsx` / `IWorkspaceChunkSearchService` facade) and the
    Search-view `AITextSearchProvider` (`SemanticSearchTextSearchProvider` or
    a Nika sibling) — scheme-aware.
13. Progress → dashboard: `onDidChangeState` → `_render()` /
    `postMessage('indexingProgress')`; status card live (files/total, status,
    error, rebuild/clear).
14. Status-bar "Indexing…" item (optional, reusing
    `workspaceIndexingStatus.ts` pattern).
15. **Tests**: provider selection per scheme; progress event → state shape.
    **Validate**: `npm run typecheck-client`, targeted tests,
    `valid-layers-check` (extension-side only).

### Phase 3 — (optional) snapshot grep
16. Crepe-like git-commit snapshot (native helper or `node:sqlite` FTS5) for
    lexical search; fallback to ripgrep when no snapshot.

### Phase 4 — (optional) `cloud` scheme
17. Shared change-detection client (git-hash) + transport:
    `FastRepoInitHandshake`-style sync to a backend (BYOK proxy first).
18. Server-side embed/KNN/rerank (self-host) or BYOK API client; path
    encryption if self-hosted; privacy warning in dashboard.
19. **Tests**: sync client against a mock server (mirror Copilot's
    `codeSearchRepo` test patterns).

### Phase 5 — Release hardening
20. Model download UX + offline fallback; error telemetry (`ITelemetryService`);
    docs (`docs/INDEXING-DESIGN.md` → update with shipped reality); version
    the index DB (`meta.version`) for future migration.
21. Per `committing.instructions.md`: commit in logical chunks with hooks
    enabled, signing respected; reference this doc.

### Decision checklist (before/during Phase 1)
- [ ] Model choice (`jina-embeddings-v2-small-code` vs `nomic-embed-text`).
- [ ] Ship model in extension vs download-on-first-use (recommend the latter).
- [ ] Local rerank in v1 (recommend: no — ship `top_k` only, add later).
- [ ] Whether `cloud` is in-scope for v1 (recommend: no; BYOK proxy later).
- [ ] Privacy Mode gating for `cloud` (recommend: gate off).

---

## 12. Out of scope (v1)

- Core-workbench indexing (`src/vs/workbench/services/search` stays untouched —
  everything is extension-side, so no layering risk).
- Server/infra for `cloud` (design only).
- Team index sharing / similar-codebase SIMHASH reuse.
- A crepe-grade native grep (Phase 3 is optional).

---

## 13. Shipped reality (what actually got built)

Implemented end-to-end: **M0, M1, M2, M3, M5** from
[`INDEXING-PLAN.md`](INDEXING-PLAN.md). M4 (`cloud`) is not implemented.

### 13.1 Files (all under `extensions/copilot/src/`)

| Area | File | What it is |
| --- | --- | --- |
| Scheme model | `platform/embeddings/local/model.ts` | `LocalEmbeddingModel` interface + `DEFAULT_LOCAL_EMBEDDING_MODEL` (`bge-small-en-v1.5-384`, 384-dim, 512 tokens, pinned SHA-256 hashes for model + tokenizer) |
| Tokenizers | `platform/embeddings/local/bpeTokenizer.ts` | HF `TokenizerJson` types + `splitAddedTokens` + `BpeTokenizer` (for future BPE models) |
|  | `platform/embeddings/local/wordPieceTokenizer.ts` | **`WordPieceTokenizer`** — the real `bge-small-en-v1.5` tokenizer (NFKC+lowercase, BertPreTokenizer regex, `##` continuation, greedy longest-prefix split, `max_input_chars_per_word`, added-token matching) |
| Model runtime | `platform/embeddings/local/modelManager.ts` | `ModelManager`: download (pinned SHA-256) → `onnxruntime-node` `InferenceSession` → batched embed (batch 16) → mean-pool → L2-normalize. Dispatches WordPiece vs BPE from `tokenizer.json`. Feeds `input_ids` + `attention_mask` + `token_type_ids` (all-zero) |
| Computer | `platform/embeddings/local/localEmbeddingsComputer.ts` | `LocalEmbeddingsComputer implements IEmbeddingsComputer`, type `EmbeddingType.nikaLocalBgeSmallEnV15` |
| Vector store | `platform/workspaceChunkSearch/node/local/localVectorStore.ts` | `LocalVectorStore` on **`node:sqlite`** (no new native dep): `chunks(path, rel_path, start, "end", hash, embedding BLOB, model)` + `meta` table; upsert/remove/getFile/getFileHashes/search (exact cosine scan, partial result on cancel)/getStats/clear; `INDEX_VERSION` in `meta` |
| Scheme | `platform/workspaceChunkSearch/node/local/localChunkSearch.ts` | `LocalChunkSearch implements IIndexingScheme` (`id: 'local'`): `isAvailable` always true, `build(onProgress, token)` → git-hash incremental (`git hash-object --stdin-paths`, batch 500, embed concurrency 8, ≤128 tokens/chunk, ≤1.5 MB/file), `search(queryText, topK, token)`, `clear`, `clearModelCache` |
| Manager | `platform/workspaceChunkSearch/node/indexingSchemeManager.ts` | `IIndexingSchemeManager`: lazy scheme selection (microtask), `rebuild(onProgress)`, `clear`, `clearModelCache`, `search` (local only), `getState`, `onDidChangeState` |
| Facade | `platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts` | Routes `isAvailable`/`searchFileChunks`/`triggerIndexing` to the local scheme when active |
| Settings | `extension/byok/vscode-node/nikaSettingsEditor.ts` | Dashboard `indexing` section: scheme select, scope toggle, status/progress/error rows, **Rebuild index**, **Clear model cache** buttons; `saveIndexingScheme`/`rebuildIndex`/`clearIndex`/`clearModelCache` messages; live progress via `vscode.window.withProgress` |
| Status bar | `extension/byok/vscode-node/nikaIndexingStatus.ts` | `nika.indexingStatus` item (Right, priority 100), loading/check/error/database states, command `nika.openIndexingSettings` |
| Embedding type | `platform/embeddings/common/embeddingsComputer.ts` | Added `EmbeddingType.nikaLocalBgeSmallEnV15` + `LEGACY_EMBEDDING_MODEL_ID` + well-known metadata |
| DI glue | `platform/chunking/node/naiveChunkerService.ts` | `INaiveChunkingService` gained `_serviceBrand` (required for `createInstance` arg stripping) |

### 13.2 Model facts (verified against the real download)

- Model: `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx`
  (34,014,426 bytes). SHA-256 `6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4`.
- Tokenizer: `tokenizer.json` (711,396 bytes). SHA-256
  `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66`.
- **Tokenizer type is `WordPiece`** (vocab 30522, `[UNK]`=100, added tokens
  `[PAD]/[UNK]/[CLS]/[SEP]/[MASK]`), BertPreTokenizer + BertNormalizer —
  *not* BPE. This is why `wordPieceTokenizer.ts` exists.
- **ONNX inputs: `input_ids`, `attention_mask`, `token_type_ids`** (all three
  required; `token_type_ids` is all-zero for single-sequence encoding).
  Output `last_hidden_state` `[batch, seq, 384]`; mean-pool → L2-normalize.

### 13.3 Telemetry

- `nika.indexing.build` — success, files, total, durationMs.
- `nika.indexing.search` — hits, durationMs.
(Sent via `ITelemetryService.sendTelemetryEvent` with destination
`{ github: true, microsoft: true }`.)

### 13.4 Validation status

- `npx tsc --noEmit --project tsconfig.json` in `extensions/copilot` — clean
  for all new files (9 pre-existing errors in `copilotcliPromptResolver.ts`,
  unrelated).
- `npm run compile` (esbuild) — passes.
- Unit tests (vitest, `--pool=forks`): `localVectorStore.spec.ts` (8),
  `bpeTokenizer.spec.ts` (7), `wordPieceTokenizer.spec.ts` (9),
  `indexingSchemeManager.spec.ts` (6), `configurations.spec.ts` (5) — **35 pass**.
- Full suite: 8969 passed / 23 failed (all pre-existing
  `editFileToolUtils.spec.ts`) / 129 skipped — **0 new failures**.
- End-to-end smoke test (real model): tokenizer loads (WordPiece, vocab
  30522), session runs, embeddings 384-dim, `cos(similar,similar)=0.686` vs
  `cos(similar,dissimilar)=0.302` → **ordering correct, pipeline verified**.
  (Temp script removed after the run.)

### 13.5 Not implemented / next

- M4 `cloud` scheme (Merkle sync + server / BYOK proxy).
- Rerank, hybrid search, Search-view `AITextSearchProvider` bridge
  (search currently returns local hits to the `#codebase` facade path).
- Snapshot grep (Phase 3).
