# Semantic Indexing: GitHub Copilot vs. Cursor

A deep, side-by-side look at how the two editors build and use "codebase
semantic indexing" — the machinery behind `#codebase` / `@Codebase`, automatic
workspace context, and code search.

---

## Provenance of this document

| Half | Basis |
| --- | --- |
| **GitHub Copilot (NikaCode)** | Grounded in the **actual source** of the Copilot extension bundled in NikaCode. File paths cited throughout (`extensions/copilot/src/platform/workspaceChunkSearch/`, `extensions/copilot/src/platform/remoteCodeSearch/`, `extensions/copilot/src/extension/...`). |
| **Cursor (docs)** | Grounded in **Cursor's official documentation** (cursor.com/docs, cursor.com/help) fetched 2026-08-13, cited per section. |
| **Cursor (reverse-engineered)** | Grounded in the **installed binary** — Cursor **3.15.19** for Windows, unpacked from `C:\Users\david\AppData\Local\Programs\Cursor`. Primary evidence: the bundled **`anysphere.cursor-retrieval`** extension (`extensions\cursor-retrieval\dist\main.js`, the indexing engine), the renderer bundle `out\vs\workbench\workbench.desktop.main.js` (40.7 MB), the native Rust addon `@anysphere/file-service` (`file_service.win32-x64-msvc.node`, 26 MB), and the native helper `resources\app\resources\helpers\crepectl.exe` (5.5 MB, the "Instant Grep" engine). Protocol messages are embedded in the bundles as Connect RPC (`@connectrpc`) descriptors in the `aiserver.v1` namespace. **The full raw evidence is in [`CURSOR-INDEXING-REVERSE-ENGINEERING.md`](CURSOR-INDEXING-REVERSE-ENGINEERING.md)**; a separate deep comparison with **stock VS Code core** lives in [`VSCODE-CORE-VS-CURSOR-INDEXING.md`](VSCODE-CORE-VS-CURSOR-INDEXING.md). |

Labels used below:
- `[docs]` — stated by Cursor's documentation.
- `[src]` — read directly from Cursor 3.15.19's shipped JS/binary (reverse-engineered).
- `[inferred]` — my reading of behavior; only used where neither docs nor source settle it.

> **Headline correction from reverse-engineering:** the web docs imply a
> local-first index. The shipped code proves the semantic index is
> **fully server-side** (Merkle-tree file sync → server-side embeddings →
> server-side KNN + rerank), while the **lexical** "Instant Grep" engine
> (`crepe`) is genuinely **local** (native snapshot index built from git
> commits). Details in §2.2 and the Appendix.

---

## TL;DR

| | **GitHub Copilot (NikaCode)** | **Cursor** |
| --- | --- | --- |
| Index architecture | **Cloud-side** index on **GitHub's servers** for GitHub-hosted repos; local embeddings cache + opt-in external ingest as fill-ins | **Server-side** embedding index on Cursor's infra (`repo42.cursor.sh`, AWS us-east-1); client scans files, builds a Merkle tree, and incrementally syncs to the server; a separate **local** `crepe` index powers Instant Grep |
| Where embeddings are computed | GitHub servers (remote index); local chunking endpoint (fallback cache) | **Always server-side** (`GetEmbeddings` RPC). No ML embedding model is bundled in the app — only `@vscode/vscode-languagedetection` |
| Embedding models | auto-selected from GitHub embedding types | Server-side pool: **Qwen 1.5B custom** (free tier), **Voyage Code 2**, **OpenAI text-embedding-3-large** `[src]` |
| Search model | Semantic (embeddings) + reranking; separate lexical tool | Semantic KNN + server-side rerank (LULEA / UMEA / none) + **local** Instant Grep (`crepe`) + symbol lookup + docs `[src]` |
| Auth required | **Yes** — GitHub session/token; anonymous users get the non-semantic agent fallback | Sign-in required to **generate the per-repo path-encryption key and start indexing** — watchers are created only after credentials exist `[src]` (docs claim "works logged out", but the index waits for sign-in) |
| Privacy posture | Index lives on GitHub; code chunks indexed server-side for GitHub repos | Code is **never stored in plaintext**: paths are encrypted per-segment with a per-repo AES-256-CTR key (HMAC-prefixed), sent to the server only when **not** in Privacy Mode; embeddings live server-side; decryption is client-side `[src]` |
| Ignore model | `.gitignore`-style ignore rules | `.gitignore` + `.cursorignore` + `.cursorindexingignore` + default ignore list + **admin blocklist**; merged at Merkle-tree build time via `cursor.general.globalCursorIgnoreList` `[src]` |
| Enterprise control | Org policy gates external ingest; MS-controlled endpoints | Privacy Mode enforcement, CMEK, data residency, team index sharing, **query-only "similar codebase" reuse** (SIMHASH) `[src][docs]` |

---

## 1. What the feature actually is

### 1.1 GitHub Copilot — "Workspace Chunk Search"

In the Copilot extension this is literally called **Workspace Chunk Search**,
and it is a **strategy-based service**:

```
IWorkspaceChunkSearchService
 ├── WorkspaceChunkSearchServiceImpl
 │     └── CodeSearchChunkSearch            ← the main strategy
 │           ├── GithubCodeSearchRepo       ← remote GitHub index
 │           ├── AdoCodeSearchRepo          ← remote ADO index
 │           ├── ExternalIngestIndex        ← files GitHub doesn't index
 │           ├── CodeSearchWorkspaceDiffTracker
 │           └── CodeSearchRepoTracker      ← git → repo resolution
 │
 ├── WorkspaceFileIndex                     ← local file scan/chunking
 └── WorkspaceChunkEmbeddingsIndex          ← local embeddings cache
```

Key files:
- `extensions/copilot/src/platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts` — service wrapper + impl
- `.../node/codeSearch/codeSearchChunkSearch.ts` — the `CodeSearchChunkSearch` strategy
- `.../node/codeSearch/codeSearchRepo.ts` — `GithubCodeSearchRepo` / `AdoCodeSearchRepo`, index state machine
- `.../node/workspaceFileIndex.ts`, `.../node/workspaceChunkEmbeddingsIndex.ts` — local index
- `extensions/copilot/src/platform/remoteCodeSearch/common/githubCodeSearchService.ts` — the GitHub API client
- `extensions/copilot/src/extension/tools/node/codebaseTool.tsx` — the `#codebase` agent tool

### 1.2 Cursor — "Codebase indexing"

Cursor's docs describe it as: *"Cursor reads and indexes your project's codebase
to power its features"* `[docs]` — covering Agent, Tab, Inline Edit, and
`@`-mentions. In the shipped app it is a family of components `[src]`:

- **`anysphere.cursor-retrieval`** (bundled extension, "Handles indexing and
  retrieval for Cursor") — the semantic indexing engine: workspace scan, Merkle
  sync, server RPCs, path encryption. Log channel *"Cursor Indexing &
  Retrieval"*.
- **`@anysphere/file-service`** (26 MB native Rust N-API addon) — `GrepClient`
  (crepe / Instant Grep), `MerkleClient` (tree build + sync), `GitClient`,
  `GitGraph`, `DiffClient`, `CodebaseSnapshotClient`, `GitHistorySession`.
- **`crepectl.exe`** (5.5 MB native helper) — "Crepe index management tool":
  `crepectl build -w <worktree> -c <commit> -C <cache> -f <filter>
  -M <memory-MB>` builds a **local snapshot index from a git commit**
  (memory-bounded with disk spilling). This is the **Instant Grep** engine.
  Log channel *"Cursor Grep Service"*.
- **Symbol retrieval** (`@Symbols`) — `SearchSymbolsParams` /
  `SearchSymbolsResult.SymbolMatch` RPCs `[src]`.
- **`@Docs`** — a separate external-docs ingestion pipeline
  (`UpsertAllDocs`, `RescrapeDocs`, `RescrapeDocsV2`, `GetDoc` RPCs) `[src]`.
- **Explore subagent** — parallel search subagent `[docs]`.

---

## 2. How indexing is done

### 2.1 GitHub Copilot: remote index first, local fill-ins

**Repo resolution** — `CodeSearchRepoTracker` maps each git folder to a GitHub
(`GithubRepoId`) or ADO (`AdoRepoId`) repo. For each, it creates a
`GithubCodeSearchRepo` / `AdoCodeSearchRepo` (`codeSearchRepo.ts`).

**Remote index check** — `GithubCodeSearchService.getRemoteIndexState()`
(`remoteCodeSearch/common/githubCodeSearchService.ts`) calls GitHub's CAPI
`EmbeddingsIndex` endpoint with `{ repoWithOwner }`, using the user's GitHub
token. Responses map to a state machine:

| Endpoint signal | Repo state |
| --- | --- |
| `semantic_code_search_ok` + `semantic_commit_sha` | `Ready` (indexed at commit X) |
| `semantic_indexing_enabled` (and repo non-empty) | `BuildingIndex` |
| `semantic_indexing_enabled` but repo empty | `Ready` (nothing to index) |
| `semantic_indexing_enabled` false | `NotYetIndexed` (indexable, not built) |
| 401/403 | `NotAuthorized` |
| other errors | `CouldNotCheckIndexStatus` |

**Triggering** — if not indexed, the client POSTs `{ auto: true|false }` to the
same endpoint (`triggerIndexing`). **The chunking + embedding happens on
GitHub's servers**; the client polls (up to 10 attempts with backoff) until the
repo reports `Ready`, then records `indexedCommit`. `prepareSearch()` waits up
to 8 s for "instant indexing" and refreshes Ready-state every 30 min (or when a
search returns out-of-sync).

**Local fallback** — `WorkspaceFileIndex` scans the workspace, skipping binary
and media types and files > 1.5 MB. `WorkspaceChunkEmbeddingsIndex` computes
embeddings (≤ 50 concurrent) through the chunking endpoint and caches them on
disk under the extension's `storageUri`.

**External ingest** — `ExternalIngestClient`/`ExternalIngestIndex` cover
non-GitHub, new, or untracked files. Gated by
`chat.workspace.codeSearchExternalIngest.enabled` **and** org policy
(`ExternalIngestEnablement.DisabledByPolicy`). `CodeSearchWorkspaceDiffTracker`
(`codeSearch/workspaceDiff.ts`) diffs against `indexedCommit`; if > 2000 files
or > 70% changed, remote search is skipped entirely.

### 2.2 Cursor: the actual architecture (reverse-engineered)

Cursor's docs describe the privacy model correctly (`[docs]`): "Cursor creates
embeddings **without storing filenames or source code**. Filenames are
obfuscated and code chunks are **encrypted**. When Agent searches, Cursor
retrieves the embeddings and **decrypts the chunks on the client side**."
What the docs *don't* say is where the embeddings are computed. The shipped
code shows the full picture `[src]`:

**The semantic index is server-side. The client is a sync client.**

```
┌─ Cursor (client) ─────────────────────────────────────────────┐
│  cursor-retrieval extension (ext. host)                        │
│                                                                │
│  Watch workspace (createWatchersIfShouldIndex)                 │
│        │                                                       │
│        ▼                                                       │
│  constructMerkleTree()                                         │
│    - reads .cursorignore / .cursorindexingignore               │
│    - cursor.general.globalCursorIgnoreList + admin blocklist   │
│    - native MerkleClient (Rust) hashes files                   │
│        │                                                       │
│        ▼  (per file, on change)                                │
│  Merkle sync to repo42.cursor.sh  (Connect RPC, aiserver.v1)   │
│    FastRepoInitHandshakeV2 → SyncMerkleSubtreeV2               │
│    → FastUpdateFileV2 → FastRepoSyncComplete                   │
│    (paths AES-256-CTR encrypted per-segment; key from          │
│     repoInfo.pathEncryptionKey, persisted in state.vscdb)      │
│        │                                                       │
│        ▼                                                       │
│  Server: chunks files, computes embeddings (GetEmbeddings:     │
│    Qwen 1.5B custom / Voyage Code 2 / OpenAI 3-large),         │
│    stores in Aurora/PlanetScale DB, KNN index                  │
│        │                                                       │
│        ▼  (Agent/@Codebase query)                              │
│  SearchRepositoryV2 / SemSearch / SemSearchFast                │
│    → top-k encrypted paths + scores                            │
│        │                                                       │
│        ▼                                                       │
│  Client decrypts paths (decryptPaths) and returns files        │
└────────────────────────────────────────────────────────────────┘
```

#### 2.2.1 Indexing lifecycle

The client-side state machine `[src]`:

```
loading → indexing-setup → indexing-init-from-similar-codebase
       → indexing → synced
       (also: not-indexed, not-auto-indexing, error)
```

1. **Gating** — `getIndexingIntent()` returns `Rte`:
   `should-index` / `should-not-index` / `default`. If the intent is
   `default` and the folder has more than `autoIndexingMaxNumFiles` files,
   Cursor does **not** auto-index (status `not-auto-indexing`). Indexing the
   **home directory** is refused outright ("We currently do not allow indexing
   the home directory").
2. **Auth gate** — watchers (`createWatchersIfShouldIndex`) are only created
   once Cursor credentials exist. `onDidChangeCursorCreds`, and
   `onDidChangePrivacyModeEnum` both **re-evaluate** the watcher. The per-repo
   path-encryption key is generated and persisted on first sign-in — until
   then indexing doesn't start.
3. **Handshake + Merkle sync** — `FastRepoInitHandshakeV2`, then
   `SyncMerkleSubtreeV2` (subtrees), `FastUpdateFileV2` (per-file content
   changes), `FastRepoSyncComplete`. Timeouts: handshake & merkle sync
   `HANDSHAKE_TIMEOUT_MS = SYNC_MERKLE_TIMEOUT_MS = 18e5` (30 min), delete sync
   `SYNC_DELETES_TIMEOUT_MS = 18e4` (3 min).
4. **Server-side embedding** — the server chunks each file and calls
   `GetEmbeddings` with the selected model. Free-tier users get the
   **Qwen 1.5B custom** model (`QWEN_1_5B_CUSTOM`); paid tiers use
   **Voyage Code 2** (`EMBEDDING_MODEL_VOYAGE_CODE_2`) or **OpenAI
   text-embedding-3-large** (`TEXT_EMBEDDINGS_LARGE_3`).
5. **Fast updates** — after the initial sync, the file watcher sends only
   changed files (content-hash based) — incremental, not full re-index.

#### 2.2.2 Path encryption (real)

- Per-repo key: `randomBytes(32).toString('base64url')` (AES-256).
- `macKey = SHA256(key ‖ 0x00)`, `encKey = SHA256(key ‖ 0x01)`; each path
  segment is encrypted with **AES-256-CTR** using a **10-byte zero IV** and a
  **6-byte HMAC-SHA256 prefix** (authenticated encryption of the path).
- Paths are split on `/([./\\])/` so **separators survive** — the server can
  still see directory structure shape.
- The key is persisted per-repo in VS Code `workspaceState`
  (`state.vscdb` → `ItemTable`), key `anysphere.cursor-retrieval` with
  `cursor-retrieval-state-version: 1`; a `pathEncryptionKeySHA256Hash`
  (`SHA256(key + "_PATH_KEY_HASH_SHA256")`) identifies the key without
  exposing it.
- **Privacy Mode gating** — when Privacy Mode is ON, the path key is **not
  sent**: `pathKey: getPrivacyMode() ? "" : this.repoInfo.pathEncryptionKey`.
  Paths are then still encrypted (client-side) but under a key the server
  never receives, so only the client can decrypt result paths. In non-privacy
  mode the key is sent so *other devices/team* (and Cursor's server) can
  decrypt.
- An override (`overridePathEncryptionKey`) is supported (used for the
  query-only similar-codebase index and the documented `.cursor/keys`
  `path_decryption_key` custom key `[docs]`); `""` selects the `plaintext`
  scheme (no-op).

#### 2.2.3 Server-side repo copy & similar-codebase reuse

- The server tracks the repo copy state:
  `RepositoryCodebaseInfo.Status`: `UP_TO_DATE` / `OUT_OF_SYNC` / `EMPTY` /
  `EMPTY_WITH_COPY_AVAILABLE` / `COPY_IN_PROGRESS` (`GetCopyStatus` RPC) `[src]`.
- If your repo isn't indexed yet, Cursor can search a **query-only similar
  repo** instead: `QueryOnlyRepoAccess` (carries a GitHub token; the server
  queries a similar public repo on your behalf) with
  `SimilarityMetricType.SIMHASH` and an `orthogonal_transform_seed` `[src]`.
- This is the mechanism behind "indexing-init-from-similar-codebase" — the
  "similar codebases" / team index-sharing story `[docs]`.

---

## 3. How search is done

### 3.1 Copilot: embeddings + reranking (+ separate lexical tool)

`WorkspaceChunkSearchServiceImpl.searchFileChunks`
(`.../workspaceChunkSearchService.ts`):

1. **Query embeddings** are resolved early (kicked off in parallel).
2. **Remote semantic search** — `GithubCodeSearchRepo.searchRepo` →
   `semanticSearch` POSTs to the `EmbeddingsCodeSearch` endpoint with
   `{ scoping_query: "repo:<nwo>", prompt, limit, embedding_model }`. Prompt is
   truncated to ~7800 UTF-8 bytes. Returns chunks with `text`, `line_range`,
   `distance`, file location.
3. **Filter** ignored chunks.
4. **Rerank** — optional remote reranker (`IRerankerService`), then local
   filter with `maxEmbeddingSpread = 0.65` (drop chunks < `topScore * 0.65`).

**Separate lexical path** — `GithubCodeSearchService.lexicalSearch` does
keyword search scoped to a repo **or an org**, and is surfaced as the
`githubTextSearch` tool (`extensions/copilot/src/extension/tools/node/githubTextSearchTool.tsx`) — i.e. `@github/<org>` style searches. It is **not** the `#codebase` pipeline.

### 3.2 Cursor: server-side semantic search + local lexical engine

All `[src]` unless noted `[docs]`.

- **Semantic search RPCs** — the client calls one of
  `SearchRepositoryV2` / `SemSearch` / `SemSearchFast` (Connect RPC,
  `aiserver.v1`). The message shapes include:
  - `SearchRepositoryV2`: `query`, `top_k`, `rerank` (bool), `glob_filter`,
    `race_n_requests`, and a `QueryOnlyRepoAccess` (GitHub token for the
    similar-codebase fallback).
  - `SemSearchFast` / `SemSearch` are server-streaming; the result metadata
    exposes `query_embedding_model`, `embed_latency_ms`, and
    `knn_latency_ms` — i.e. the query is embedded **server-side** and matched
    via server-side **KNN**.
  - Result paths come back **encrypted**; the client runs
    `decryptPaths({ paths, overridePathEncryptionKey })` before returning
    files to the agent.
- **Reranking** — server-side, selected by `RerankerAlgorithm`:
  `LULEA` / `UMEA` / `NONE`. (LULEA/UMEA are Cursor's cross-encoder rerankers;
  this replaces the "not documented" row in earlier versions of this doc.)
- **Lexical — Instant Grep is genuinely local**: the `GrepClient` (native
  `@anysphere/file-service`) manages a **snapshot index** built by
  `crepectl.exe build` from a git commit (memory-bounded, disk spilling,
  `ripgrep-default-filter` option). `GrepClient.getWorkspaceStatuses()` reports
  `indexReady` / `indexNone` / `indexPendingMax` counts — the crepe snapshot
  states (`NoIndex` = no ready snapshot, `indexPendingMax` = still warming).
  A feature gate `grep_fallback_monitor` tracks fallback reasons
  (`index_unavailable`, `exec_failure`, `timeout`, ...). A server-side
  `RipgrepRawSearchParams` (Instant Grep over remote/cloud) also exists.
- **Symbols** — `SearchSymbolsParams` → `SearchSymbolsResult.SymbolMatch`
  powers `@Symbols` `[src]`.
- **Docs** — `@Docs` uses `UpsertAllDocs` / `RescrapeDocs(V2)` / `GetDoc` for
  external documentation `[src]`.
- **Chunk retrieval** — `BM25Chunk` (content/range/score) is used for the
  lexical path; `DocumentationChunk` for docs `[src]`.
- **Explore subagent** — the agent can spawn a subagent in its own context
  window that "executes many parallel searches without bloating the main
  conversation, returning only the relevant findings" `[docs]`.

---

## 4. What powers what (entry points)

### Copilot
| Surface | Where |
| --- | --- |
| `#codebase` agent tool | `codebaseTool.tsx`; up to 32 results, 20 s timeout, ~28k token cap |
| Automatic workspace context | `prompts/node/panel/workspace/workspaceContext.tsx` |
| Agent prompt guidance | `prompts/node/agent/semanticSearchInstructions.tsx` (mode `preferred`) |
| Chat status item | "Codebase Semantic Index" — `extension/workspaceChunkSearch/vscode-node/workspaceIndexingStatus.ts` |
| Commands | Build Codebase Semantic Index, enable/delete external ingest, diagnostics dump (`.../vscode-node/commands.ts`) |
| Lexical search tool | `extension/tools/node/githubTextSearchTool.tsx` (`githubTextSearch`) |

### Cursor
| Surface | Notes |
| --- | --- |
| `@Codebase` | workspace-wide semantic search — `SearchRepositoryV2` / `SemSearch(Fast)` `[src]` |
| `@Symbols` | symbol-level lookup — `SearchSymbols` RPC `[src]` |
| `@Files` / `@Docs` | file & external-doc retrieval (`GetDoc`/`UpsertAllDocs`) `[src][docs]` |
| Agent / Tab / Inline Edit | all consume the same index `[docs]` |
| Instant Grep | local `crepe` snapshot index (`GrepClient`) — full regex, no config `[src][docs]` |
| Explore subagent | parallel search `[docs]` |
| Status bar / log | "Indexing…" indicator; output channel "Cursor Indexing & Retrieval" `[src]` |

---

## 5. Ignore & exclusion model

### Copilot
- Ignore rules (`shouldInclude`) applied to search results and local indexing
  (`workspaceFileIndex.ts`); respects the workspace's ignore/glob config.
- No user-facing `codebaseignore` file (unlike Cursor).

### Cursor — three-layer ignore system `[docs]` + admin layer `[src]`
| Layer | Effect |
| --- | --- |
| `.gitignore` | respected automatically |
| `.cursorignore` | blocked from indexing **and** from Agent/Tab/Inline Edit/`@`-mentions |
| `.cursorindexingignore` | excluded from indexing **only** — still accessible to AI, just not in codebase search results |
| global/admin ignore | merged at index build time: `cursor.general.globalCursorIgnoreList` setting + an admin-controlled blocklist are combined into the Merkle-tree filter `[src]` |

- `.cursorignore` uses `.gitignore` syntax with negation (`!`), comments, and
  hierarchical support (search parent directories) — configurable under
  `Cursor Settings > Indexing > Ignore Files` since Cursor 3.11 `[docs]`.
- Global ignore patterns can be set in user settings `[docs]`.
- A built-in **default ignore list** covers lock files, `.env*`, `.git/`,
  binaries, media, archives, `node_modules/`, `__pycache__/`, build dirs
  (`.next/`, `.nuxt/`, `.gradle/`), package-manager caches, etc. `[docs]`
- Note: terminal commands and MCP tools run **outside** Cursor's file access
  controls, so they may still read ignored files `[docs]`.

---

## 6. Auth, gating & configurability

### Copilot
| Item | Value |
| --- | --- |
| Auth | GitHub session token required for the remote index |
| Anonymous | `CodebaseTool` forces the non-semantic agent path when there's no GitHub session (`codebaseTool.tsx`: "When anonymous, always force agent path so we avoid relying on semantic index features") |
| Settings | `chat.semanticSearchTool.mode` (`enabled`/`disabled`/`preferred`); `chat.workspace.codeSearchExternalIngest.enabled` |
| Embedding model | auto-selected from available GitHub embedding types (`common/githubAvailableEmbeddingTypes.ts`) |
| ADO | separate `AdoCodeSearchRepo` path (not indexable on demand) |

### Cursor
| Item | Value |
| --- | --- |
| Auth | **Indexing waits for sign-in**: the path-encryption key is generated on first login and watchers are created only when credentials exist; `onDidChangeCursorCreds` re-evaluates `[src]`. Docs say "no account needed to use Cursor" `[docs]`, but the semantic index does not start until sign-in |
| Privacy Mode | when ON, the path-encryption key is **not sent to the server** (`pathKey: ""`), so only the client can decrypt result paths; also gates training (`privacyModeDisallowed`) `[src]`; on by default for Enterprise teams, enforceable org-wide `[docs]` |
| ZDR | most models run under zero-data-retention agreements `[docs]` |
| Enterprise | CMEK (customer-managed keys for embeddings + Cloud Agent data), data residency (US-only today), Privacy Mode enforcement, audit logs `[docs]`; server-side repo copy + query-only similar-codebase reuse `[src]` |
| Config | Settings UI (`Indexing` section), `.cursorignore` / `.cursorindexingignore`, `.cursor/keys`, `autoIndexingMaxNumFiles` cap, home-dir indexing refused `[src]` |
| Multi-root | supported; all codebases indexed automatically; worktrees disabled for multi-root; Cloud Agents don't support multi-root `[docs]` |

---

## 7. Side-by-side comparison matrix

| Dimension | GitHub Copilot (NikaCode) | Cursor |
| --- | --- | --- |
| Index owner | GitHub's servers (for GitHub repos) | Cursor's servers (embeddings + KNN + rerank) + **local** crepe snapshot for Instant Grep `[src]` |
| Chunk text at rest | plaintext on GitHub's index | encrypted (paths AES-256-CTR w/ HMAC prefix; embeddings server-side) `[src]` |
| Filenames | sent to GitHub | encrypted per-segment; separators preserved; key withheld in Privacy Mode `[src]` |
| Where embeddings are computed | GitHub servers (remote index) | **Server-side only** (`GetEmbeddings`; Qwen 1.5B / Voyage Code 2 / OpenAI 3-large) `[src]` |
| Works without auth | ❌ (falls back to non-semantic) | ⚠️ index **waits for sign-in** (no path key before login); agent still works logged out `[src][docs]` |
| Offline search | ❌ (needs GitHub endpoints) | ❌ semantic (server KNN); ✅ **Instant Grep** is local (`crepe` snapshot from git commit) `[src]` |
| Non-GitHub repos | opt-in external ingest, policy-gated | indexed by default |
| Symbol search | ❌ (no dedicated symbol index) | ✅ `@Symbols` (`SearchSymbols` RPC) `[src]` |
| Keyword/lexical | separate `githubTextSearch` tool | local Instant Grep (`GrepClient`/crepe) + server `RipgrepRawSearchParams` `[src]` |
| Custom ignore file | ❌ | ✅ `.cursorignore` / `.cursorindexingignore` + global + admin blocklist `[src][docs]` |
| Reranking | remote reranker + local 0.65 spread filter | server-side `RerankerAlgorithm` LULEA / UMEA / NONE `[src]` |
| Team index sharing | ❌ | ✅ (permission-respecting; query-only similar-codebase via SIMHASH) `[docs][src]` |
| Enterprise key control | MS-managed | CMEK |
| Data residency for index | GitHub's regions | US-only option; indexing itself can't be region-locked if code is stored elsewhere `[docs]` |
| Embedding models | GitHub's embedding types | Qwen 1.5B custom (free) / Voyage Code 2 / OpenAI text-embedding-3-large `[src]` |

---

## 8. Trade-offs (honest read)

### Copilot does better
- **Single source of truth for GitHub repos**: the index lives next to the code
  on GitHub, so search quality is consistent and scales with GitHub's
  infrastructure; no local disk cost.
- **Reranking**: explicit remote reranker + local spread filter is documented
  in source — a real quality lever.
- **Enterprise story via GitHub**: index access is tied to GitHub auth, which
  enterprises already manage; org policy can gate external ingest.

### Cursor does better
- **Works without a GitHub account** — the index has nothing to do with GitHub;
  it syncs to Cursor's own backend. (It still requires a Cursor sign-in to
  start indexing `[src]`.)
- **Privacy posture**: per-repo AES path encryption with an HMAC prefix,
  **and** Privacy Mode that withholds the key from the server entirely — a
  stronger default than sending plaintext chunks to GitHub. Decryption is
  always client-side `[src]`.
- **Faster surface-level search**: local **Instant Grep** (crepe snapshot
  index from git commits) and `@Symbols` cover the "I know the name, find it
  fast" case that pure embeddings handle clumsily `[src]`.
- **Ignore ergonomics**: `.cursorindexingignore` separates "don't show in
  search" from "don't let AI read" — a distinction Copilot lacks.
- **Team index sharing** speeds up onboarding on similar codebases; the
  query-only SIMHASH fallback lets you search a *similar public repo* before
  yours is indexed `[src][docs]`.
- **Incremental sync done properly**: Merkle-tree subtree sync means the
  server never re-embeds untouched files; the client only ships content
  hashes + changed files `[src]`.

### Cursor's trade-offs (from the source)
- **The index is a cloud dependency**: every `@Codebase` query embeds the
  query server-side and runs server-side KNN — there is **no offline semantic
  search** and no local embeddings cache (the client stores only the merkle
  state + keys). `embed_latency_ms` / `knn_latency_ms` in results make the
  round-trip visible `[src]`.
- **No bundled embedding model**: unlike "local index" marketing, the app
  ships zero ML embedding models (only language detection). Everything
  embedding-shaped is a server RPC `[src]`.
- **Path encryption is a privacy measure, not a secret**: separators survive
  encryption (`/([./\\])/`), so the server still sees the directory-structure
  shape; and outside Privacy Mode the key is sent to the server, which can
  decrypt everything (needed for team sharing / cross-device) `[src]`.
- **Indexing is sign-in gated**: no Cursor account → no path key → no index
  (though the agent itself works logged out) `[src]`.

### NikaCode / BYOK relevance
- Semantic indexing is **orthogonal to the LLM provider**. The `nika` /
  `deepseek-v4-flash-responses` BYOK provider powers chat/agents, but the
  Copilot semantic index is driven by **GitHub's embedding endpoints** and
  needs a **GitHub session**.
- A NikaCode user **not signed into GitHub** gets the agent fallback
  (non-semantic exploration: `FindTextInFiles`, `FindFiles`, `ReadFile`,
  subagents) — same as anonymous stock VS Code, not a fork regression.
- If NikaCode wanted semantic search for BYOK-only users, **Cursor's model is
  the reference**: a client that builds a Merkle tree over the workspace,
  syncs only changed files to a backend that computes embeddings and runs
  KNN+rerank, encrypts paths client-side, and keeps a local lexical engine
  (crepe-style snapshot) for offline grep. The *gating* lesson is that
  Cursor still requires its own account — any fork doing this needs its own
  index backend and auth story. This document is comparison only; building
  this is a substantial project.

---

## Appendix A — Cursor reverse-engineering notes (3.15.19)

All `[src]`. Evidence locations listed in §9.

> **Full findings are in the dedicated companion doc:
> [`CURSOR-INDEXING-REVERSE-ENGINEERING.md`](CURSOR-INDEXING-REVERSE-ENGINEERING.md).**
> It contains the complete protocol dump (RPCs, enums), the Merkle-sync
> lifecycle, the path-encryption details, the crepe/Instant-Grep local index,
> the on-disk state layout, and the network topology.

The short version used throughout this comparison:

- **Index = server-side.** Client builds a Merkle tree (native Rust) and syncs
  to `repo42.cursor.sh` via `FastRepoInitHandshakeV2` → `SyncMerkleSubtreeV2`
  → `FastUpdateFileV2` → `FastRepoSyncComplete`. Embeddings (`GetEmbeddings`),
  KNN, and rerank (`RerankerAlgorithm` LULEA/UMEA/NONE) are all server-side.
- **Local lexical index** = `crepectl.exe` ("Crepe"), a memory-bounded
  snapshot index built from git commits (this is Instant Grep).
- **Path encryption** = per-repo AES-256-CTR (HMAC-prefixed, zero IV),
  per-segment with separators preserved; key persisted in `state.vscdb`;
  withheld from the server in Privacy Mode.
- **Sign-in gated**: watchers + path key only exist after Cursor credentials;
  re-evaluated on creds/privacy-mode change.
- **No local embedding DB** — consistent with a fully server-side semantic
  index.

---

## 9. Sources

**Copilot (fork source, read 2026-08-13):**
- `extensions/copilot/src/platform/workspaceChunkSearch/node/workspaceChunkSearchService.ts`
- `extensions/copilot/src/platform/workspaceChunkSearch/node/codeSearch/codeSearchChunkSearch.ts`
- `extensions/copilot/src/platform/workspaceChunkSearch/node/codeSearch/codeSearchRepo.ts`
- `extensions/copilot/src/platform/workspaceChunkSearch/node/workspaceFileIndex.ts`
- `extensions/copilot/src/platform/workspaceChunkSearch/node/workspaceChunkEmbeddingsIndex.ts`
- `extensions/copilot/src/platform/workspaceChunkSearch/common/githubAvailableEmbeddingTypes.ts`
- `extensions/copilot/src/platform/remoteCodeSearch/common/githubCodeSearchService.ts`
- `extensions/copilot/src/extension/tools/node/codebaseTool.tsx`
- `extensions/copilot/src/extension/tools/node/githubTextSearchTool.tsx`
- `extensions/copilot/src/extension/prompts/node/panel/workspace/workspaceContext.tsx`
- `extensions/copilot/src/extension/prompts/node/agent/semanticSearchInstructions.tsx`
- `extensions/copilot/src/extension/workspaceChunkSearch/vscode-node/workspaceIndexingStatus.ts`

**Cursor (official docs, fetched 2026-08-13):**
- `cursor.com/docs/agent/tools/search` — Instant Grep, privacy model ("embeddings without storing filenames or source code… decrypts the chunks on the client side"), team index sharing, multi-root, `.cursor/keys`
- `cursor.com/help/customization/ignore-files` and `cursor.com/docs/reference/ignore-file` — `.cursorignore`, `.cursorindexingignore`, default ignore list, hierarchical ignore, global ignores
- `cursor.com/docs/enterprise/privacy-and-data-governance` — two data flows, Cloud Agents, CMEK ("Embeddings are encrypted using your customer encryption key"), data residency, codebase indexing region caveat
- `cursor.com/help/security-and-privacy/privacy` — Privacy Mode, ZDR
- `cursor.com/docs/models-and-pricing` — plans, Cursor Models pool, Cursor Token Rate
- `cursor.com/docs/agent/security` — tool approvals, network restrictions
- `cursor.com/docs/context/rules` — project/user/team rules, AGENTS.md
- `cursor.com/help/customization/context` — `@` mentions

**Cursor (reverse-engineered from installed binary 3.15.19, 2026-08-13):**
- `C:\Users\david\AppData\Local\Programs\Cursor\resources\app\extensions\cursor-retrieval\dist\main.js` — indexing engine: Merkle sync RPCs (`FastRepoInitHandshakeV2`, `SyncMerkleSubtreeV2`, `FastUpdateFileV2`, `FastRepoSyncComplete`), `SearchRepositoryV2`/`SemSearch`/`SemSearchFast`, `GetEmbeddings`, `RerankerAlgorithm` (LULEA/UMEA/NONE), `RepositoryCodebaseInfo.Status`, `QueryOnlyRepoAccess`/SIMHASH, `getIndexingIntent`/`Rte` gating, `autoIndexingMaxNumFiles`, home-dir refusal, watchers on creds/privacy change, AES path encryption (`Vte`/`Hte`, `macKey`/`encKey`, zero IV + 6-byte HMAC prefix, separator-preserving split), privacy-mode `pathKey: ""`, Merkle-tree ignore merge (`cursor.general.globalCursorIgnoreList` + admin blocklist), timeouts (30 min handshake/merkle, 3 min deletes)
- `C:\Users\david\AppData\Local\Programs\Cursor\resources\app\extensions\cursor-retrieval\node_modules\@anysphere\file-service\index.js` + `file_service.win32-x64-msvc.node` — `GrepClient`, `MerkleClient`, `GitClient`, `GitGraph`, `DiffClient`, `CodebaseSnapshotClient`, `GitHistorySession`
- `C:\Users\david\AppData\Local\Programs\Cursor\resources\app\resources\helpers\crepectl.exe` — `crepe build -w/-c/-C/-f/-M` (local snapshot index from git commit; memory-bounded, disk spilling)
- `C:\Users\david\AppData\Local\Programs\Cursor\resources\app\out\vs\workbench\workbench.desktop.main.js` — renderer: `decryptPaths`, `getOverridePathEncryptionKey`, `getFinalCodeResults`, `SearchSymbolsParams`, `RipgrepRawSearchParams`, docs RPCs (`UpsertAllDocs`, `RescrapeDocs(V2)`, `GetDoc`), `BM25Chunk`/`DocumentationChunk`
- `%APPDATA%\Cursor\User\workspaceStorage\*\state.vscdb` — `ItemTable`/`cursorDiskKV`; key `anysphere.cursor-retrieval` (`cursor-retrieval-state-version: 1`); `~\.cursor\ai-tracking\ai-code-tracking.db` (`scored_commits`: v1/v2 AI percentages, tab/composer/human line counts)
- Network: indexing host `repo42.cursor.sh` → Cloudflare → AWS us-east-1 (`cursor-lb-3-1690831134.us-east-1.elb.amazonaws.com`); API `api2.cursor.sh` → `api2direct.cursor.sh` (AWS us-east-1 / Global Accelerator); update URL confirms version `3.15.19`

**Companion docs:**
- [`CURSOR-INDEXING-REVERSE-ENGINEERING.md`](CURSOR-INDEXING-REVERSE-ENGINEERING.md) — the complete, expanded findings dump (protocol, encryption, crepe, on-disk state, endpoints).
- [`VSCODE-CORE-VS-CURSOR-INDEXING.md`](VSCODE-CORE-VS-CURSOR-INDEXING.md) — how **stock VS Code core** (no Copilot) does search/indexing vs. Cursor, with extensive comparison tables.
- [`INDEXING-DESIGN.md`](INDEXING-DESIGN.md) — how to **build** scheme-selectable indexing for NikaCode (per-workspace scheme + default, `local`/`cloud` engines, Nika dashboard setting & progress).
