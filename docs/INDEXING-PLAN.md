# NikaCode Indexing — Implementation Plan (executable)

Actionable task breakdown for building scheme-selectable Nika semantic
indexing. Companion: [`INDEXING-DESIGN.md`](INDEXING-DESIGN.md) (design
rationale & decisions). Everything here names concrete files, interfaces, and
acceptance criteria, grounded in the fork's source.

**Scope guard:** all work is **extension-side** (`extensions/copilot`).
`src/vs/workbench/services/search/**` is untouched → no layering risk
(`valid-layers-check` unaffected).

---

## Milestone map

```
M0  Foundation: setting + dashboard shell          (days 1–2)
M1  Local engine core: ONNX embed + sqlite ANN     (days 3–8)
M2  Integration: search paths + live progress      (days 9–12)
M3  (optional) snapshot grep                       (later)
M4  (optional) cloud scheme                        (later)
M5  Hardening: packaging, telemetry, docs          (days 13–15)
```

---

## M0 — Foundation: `nika.indexing.scheme` + dashboard `indexing` section

### M0.1 Register the setting
**File:** `extensions/copilot/package.json` → `contributes.configuration` (the
Nika block, `"title": "Nika"`).

```jsonc
"nika.indexing.scheme": {
  "type": "string",
  "enum": ["off", "github-remote", "local", "cloud"],
  "enumDescriptions": [
    "No semantic index (ripgrep search only).",
    "Reuse GitHub Copilot's existing remote index (requires GitHub sign-in).",
    "Fully local: ONNX embeddings + local vector store. Offline and private.",
    "Cursor-style: sync a hash tree to a Nika backend (or BYOK embedding API)."
  ],
  "default": "off",
  "scope": "resource",
  "tags": ["preview"]
}
```
- Add `nls`/l10n strings in the extension's `.nls.*` / `localize` patterns
  (match existing Nika setting entries).

**Acceptance:** setting appears in Settings UI; a workspace
`.vscode/settings.json` override of `nika.indexing.scheme` is honored (resource
scope); default read via `workspace.getConfiguration('nika').get('indexing.scheme')`.

### M0.2 Dashboard: new `indexing` section
**File:** `extensions/copilot/src/extension/byok/vscode-node/nikaSettingsEditor.ts`

1. Extend the section union:
   `type NikaSettingsSection = 'overview' | ... | 'indexing' | 'diagnostics';`
2. Add `'indexing.scheme'` to the `SETTINGS` allowlist (plus new keys:
   `indexing.scope`, if we persist a target preference).
3. `_state()` → add:
   ```ts
   indexing: {
     scheme: value('indexing.scheme', 'off'),
     scope: 'default' | 'workspace',          // computed from config.inspect
     status: 'idle' | 'building' | 'indexing' | 'synced' | 'error',
     indexedFileCount: number, totalFileCount: number, lastError?: string,
   }
   ```
   Use `config.inspect('indexing.scheme')` to report which scope wins
   (`workspaceValue` present → workspace override badge).
4. `_onMessage` → new cases:
   - `saveIndexingScheme` `{ scheme, target: 'user' | 'workspace' }` →
     `workspace.getConfiguration('nika').update('indexing.scheme', scheme,
     target === 'workspace' ? ConfigurationTarget.Workspace : ConfigurationTarget.Global)`.
   - `rebuildIndex` → call into `IIndexingSchemeManager` (stub in M0, real in M2).
   - `clearIndex` → same.
5. Webview HTML: `indexing` section with scheme `<select>`, scope radio
   ("My default" / "This workspace"), override badge, status card
   (status text, progress bar, `files / total`, error line), Rebuild/Clear
   buttons. Follow the existing section styling + l10n.

**Acceptance:** opening Nika Settings shows the `indexing` section; changing
the scheme writes the right config target; a workspace override shows a badge;
status card renders from `_state()`.

### M0.3 Scheme manager stub (DI shell)
**New files:**
- `extensions/copilot/src/platform/workspaceChunkSearch/common/indexingScheme.ts`
  ```ts
  export type IndexingSchemeId = 'off' | 'github-remote' | 'local' | 'cloud';
  export interface IndexingState {
    readonly status: 'idle' | 'building' | 'indexing' | 'synced' | 'error';
    readonly indexedFileCount: number;
    readonly totalFileCount: number;
    readonly lastError?: string;
  }
  export interface IIndexingScheme extends IDisposable {
    readonly id: IndexingSchemeId;
    getState(): Promise<IndexingState>;
    readonly onDidChangeState: Event<void>;
    isAvailable(): Promise<boolean>;
  }
  ```
- `extensions/copilot/src/platform/workspaceChunkSearch/node/indexingSchemeManager.ts`
  ```ts
  export const IIndexingSchemeManager =
    createServiceIdentifier<IIndingSchemeManager>('IIndexingSchemeManager');
  export interface IIndexingSchemeManager extends IIndexingScheme {
    setScheme(id: IndexingSchemeId): Promise<void>; // reacts to setting change
    rebuild(): Promise<void>;
    clear(): Promise<void>;
  }
  ```
- `.../node/schemes/offScheme.ts` — `getState()` → `{ status: 'idle', 0, 0 }`,
  `isAvailable()` → `false`.
- `.../node/schemes/githubRemoteScheme.ts` — wraps the existing
  `IWorkspaceChunkSearchService` (delegate `isAvailable`/`getState` to it;
  status mapping from `WorkspaceIndexState`).

**Register** the manager in the extension activation (the same place the
chunk-search service is wired — extension activation / `conversationFeature`
or the platform service bootstrap) and subscribe to config:
`onDidChangeConfiguration` → `affectsConfiguration('nika.indexing.scheme')`
→ `setScheme(...)`.

**Acceptance:** manager resolves `off`/`github-remote`; changing the setting
switches the active scheme; state observable via `onDidChangeState`.

---

## M1 — `local` engine core (no server)

### M1.1 Dependencies & model
**Files:** `extensions/copilot/package.json` (deps), new
`extensions/copilot/src/platform/embeddings/local/modelManager.ts`

1. Add dep: `onnxruntime-node` (pin exact; it's a native module → must land in
   the packaged extension's `node_modules`, verify `.moduleignore` does NOT
   strip it — mirror the `@vscode/windows-mutex` native-binding lesson).
2. `ModelManager`:
   - downloads a pinned, hashed model (e.g. `jina-embeddings-v2-small-code`
     quantized ONNX) to `~/.nika/models/<model-id>/` on first use;
   - verifies SHA-256 (reuse the update worker's hash-verify pattern);
   - resolves `InferenceSession` lazily; exposes `embed(texts: string[]):
     Promise<Float32Array[]>` with a batching + cancellation seam.
   - Decision (from design checklist): ship-vs-download → **download on first
     use** (keeps installer lean).

**Acceptance:** on a dev box, first use downloads + verifies + loads the
session; a 5-text smoke batch returns `Float32Array` of expected dims.

### M1.2 Local embeddings computer
**New file:** `extensions/copilot/src/platform/embeddings/local/localEmbeddingsComputer.ts`

```ts
export class LocalEmbeddingsComputer implements IEmbeddingsComputer {
  computeEmbeddings(type, texts, options): Promise<Embedding[]> { ... }
}
```
- Register a new `EmbeddingType` (e.g. `'nika-local-code'`) with matching
  `EmbeddingTypeInfo` in `embeddingsComputer.ts` (add to
  `wellKnownEmbeddingMetadata`) so cache/storage keys are per-model.
- Reuse `naiveChunker` for chunking (already in
  `platform/chunking/node/naiveChunkerService.ts`).

**Acceptance:** `computeEmbeddings` returns correct-dim vectors; batch limit +
cancellation honored; type id stable across restarts (cache keyed on it).

### M1.3 Local vector store (node:sqlite)
**New file:** `extensions/copilot/src/platform/workspaceChunkSearch/node/local/localVectorStore.ts`

```ts
export class LocalVectorStore implements IDisposable {
  constructor(dbPath: string /* <storageUri>/indexing/<workspaceHash>/index.sqlite */)
  upsertFile(path, chunks: { range, hash, embedding: Float32Array }[]): Promise<void>;
  removeFile(path): Promise<void>;
  search(queryEmbedding: Float32Array, topK, token): Promise<LocalHit[]>;
  getStats(): Promise<{ files: number; chunks: number }>;
  clear(): Promise<void>;
}
```
- Use **`node:sqlite`** (already used by `workspaceChunkAndEmbeddingCache.ts`)
  or `@vscode/sqlite3@5.1.12-vscode` (already a dep) — **no new native dep**.
- Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS chunks(
    path TEXT, rel_path TEXT, start INT, end INT,
    hash TEXT, embedding BLOB /* f32 LE */, model TEXT,
    PRIMARY KEY(path, start, end));
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
  ```
  `meta` stores `{ model, index_version, last_commit }`.
- `search`: cosine over the `embedding` column (read BLOB → JS math for
  `< ~50k` chunks; document the in-memory IVFFlat upgrade path).

**Acceptance:** round-trip test (upsert → search returns nearest); delete file
removes rows; stats correct; clear wipes; schema versioned.

### M1.4 Incremental indexing (git-hash change detection)
**New file:** `extensions/copilot/src/platform/workspaceChunkSearch/node/local/localChunkSearch.ts`

```ts
export class LocalChunkSearch extends Disposable implements IIndexingScheme {
  build(reason, onProgress, token): Promise<void>;
  // - iterate WorkspaceFileIndex; for each file compute git blob hash
  //   (child_process git hash-object --stdin-paths, or @anysphere-style hash)
  // - compare to stored hash; only re-chunk+embed changed/new files
  // - update meta.last_commit
  search(query, topK, token): Promise<StrategySearchResult>;
  getState(): Promise<IndexingState>;   // files indexed / total
}
```
- Reuse `WorkspaceFileIndex` (`IWorkspaceFileIndex` DI id already exists) for
  scan + ignore handling; reuse the `Limiter`/progress patterns from
  `WorkspaceChunkEmbeddingsIndex` (max ~8 concurrent).
- Emit `onDidChangeState` (debounced, like the existing 2.5 s pattern).

**Acceptance:** initial build indexes all files; edit one file → only that
file re-embeds; delete → rows removed; `getState()` reflects counts; cancel
mid-build leaves a consistent store (idempotent resume).

---

## M2 — Integration: search paths + live dashboard progress

### M2.1 Wire the facade
**File:** `extensions/copilot/src/platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts`
- `WorkspaceChunkSearchServiceImpl` gets a scheme switch: if
  `nika.indexing.scheme === 'local'`, route
  `searchFileChunks`/`isAvailable`/`triggerIndexing`/`getRemoteIndexState` to
  `LocalChunkSearch`; else keep `CodeSearchChunkSearch` (today's behavior).
- Keep the `IWorkspaceChunkSearchService` public interface **unchanged** so
  consumers (`CodebaseTool`, `SemanticSearchTextSearchProvider`) don't change.

**Acceptance:** with scheme `local`, `#codebase` and the Search-view AI
provider return local results; with `off`/`github-remote`, behavior is
byte-for-byte today's.

### M2.2 Dashboard live progress
**File:** `extensions/copilot/src/extension/byok/vscode-node/nikaSettingsEditor.ts`
- Subscribe to `IIndexingSchemeManager.onDidChangeState` →
  `_render()` (cheap re-render of status card) or
  `webview.postMessage({ type: 'indexingProgress', state })` for a live bar
  without full re-render.
- `rebuildIndex`/`clearIndex` message handlers call the manager for real.
- Keep the webview's `retainContextWhenHidden` (already set) so progress
  survives panel backgrounding.

**Acceptance:** starting a build shows the progress card updating (files/total)
without user interaction; rebuild button triggers a build; error state shows
`lastError`.

### M2.3 Status bar (optional, Cursor-style "Indexing…")
**File:** follow `ChatStatusWorkspaceIndexingStatus`
(`extensions/copilot/src/extension/workspaceChunkSearch/vscode-node/workspaceIndexingStatus.ts`)
— implement its `WorkspaceIndexStateReporter` interface backed by
`IIndexingSchemeManager`, reuse its `createStatusBarItem` + command-link
pattern.

**Acceptance:** status item reflects `indexing`/`synced`/`error` and opens the
dashboard `indexing` section on click.

---

## M3 — (optional) Snapshot grep
- Crepe-like git-commit snapshot for lexical search: FTS5 table in the same
  `node:sqlite` DB (`chunks` FTS5 index over file text), rebuilt on commit
  change, fall back to ripgrep when no snapshot.
- **Deferred** — ripgrep is the lexical path until then.

---

## M4 — (optional) Cloud scheme
- Reuse M1.4's change-detection (git-hash) as the sync client:
  `handshake → push changed files → server embed → search`.
- Backend options in design §3: BYOK embedding API proxy first, self-host
  later; path encryption if self-hosted; privacy warning in dashboard;
  gate off when Nika Privacy Mode (if any) is enabled.
- **Deferred** — design only.

---

## M5 — Hardening
1. Model download UX: progress notification, offline fallback, clear cache
   command in dashboard.
2. Telemetry: `ITelemetryService` events for build/search/errors (follow
   `ISearchFeedbackTelemetry` patterns in `semanticSearchTextSearchProvider.ts`).
3. Index DB versioning: `meta.index_version` + migration hook.
4. Tests consolidated (see below) + `docs/INDEXING-DESIGN.md` updated to
   shipped reality.
5. Commit in logical chunks per `committing.instructions.md` (hooks on,
   signing respected, reference the plan).

---

## Tests (per milestone)

| Milestone | Tests |
| --- | --- |
| M0 | `nikaSettingsEditor` unit tests: `_state().indexing` shape; `saveIndexingScheme` writes User vs Workspace target; override badge logic. Config registration smoke test. |
| M1 | `LocalEmbeddingsComputer` (tiny model, dims, batch/cancel); `LocalVectorStore` (round-trip, delete, stats, clear); `LocalChunkSearch` incremental (add/edit/delete → only changed re-embedded, resume after cancel). |
| M2 | Facade routing (`local` vs `github-remote`); `onDidChangeState` → dashboard state shape; status reporter. |
| M5 | Telemetry payloads; DB migration. |

Run: `npm run compile` in `extensions/copilot` after each change;
`scripts/test.bat --grep <suite>` (tests run from `out/` — run
`npm run transpile-client` first); `npm run typecheck-client` before M2/M5
commits.

---

## Dependency graph

```
M0.1 setting ──► M0.2 dashboard section ──► M0.3 scheme manager (stub)
                                                    │
M1.1 model ──► M1.2 embeddings computer ──► M1.3 vector store ──► M1.4 local search
                                                    │
M2.1 facade routing ◄─────────────── M1.4 (implements IIndexingScheme)
M2.2 dashboard progress ◄── M0.3 onDidChangeState
M2.3 status bar ◄── M2.1
```

## First tasks (execute in order)
1. M0.1 — add `nika.indexing.scheme` to package.json + l10n.
2. M0.2 — dashboard `indexing` section (stub state).
3. M0.3 — `IIndexingScheme`/`IndexingSchemeManager` + `off`/`github-remote`.
4. M1.1 — deps + `ModelManager` (download/verify/load).
5. M1.2 → M1.3 → M1.4.
6. M2.1 → M2.2 → M2.3.
