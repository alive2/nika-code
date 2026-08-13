# Cursor Indexing — Reverse-Engineering Notes (3.15.19)

Complete findings from reverse-engineering the **installed Cursor 3.15.19**
Windows binary (unpacked from `C:\Users\david\AppData\Local\Programs\Cursor`).
Everything here is `[src]` — read directly from the shipped JS/binary — unless
noted `[docs]` (Cursor's documentation) or `[inferred]`.

This is the raw-evidence companion to
[`SEMANTIC-INDEXING.md`](SEMANTIC-INDEXING.md) (the Copilot-vs-Cursor
comparison) and [`VSCODE-CORE-VS-CURSOR-INDEXING.md`](VSCODE-CORE-VS-CURSOR-INDEXING.md)
(VS Code core vs Cursor). Keep it up to date when a new Cursor version ships.

---

## 0. Headline conclusions

1. **The semantic index is fully server-side.** The client is a *sync client*:
   it scans the workspace, builds a **Merkle tree** of file hashes (native
   Rust), and incrementally syncs to `repo42.cursor.sh`. Chunking, embeddings,
   KNN retrieval, and reranking all happen **on Cursor's servers**.
2. **No ML embedding model ships in the app.** The only ML-ish module bundled
   is `@vscode/vscode-languagedetection`. "Embeddings" in the client are always
   a server RPC (`GetEmbeddings`).
3. **Instant Grep is the one genuinely local index** — `crepectl.exe`, the
   "Crepe index management tool", builds a memory-bounded **snapshot index
   from a git commit** on disk. It is lexical (grep), not semantic.
4. **Path encryption is real and strong**: per-repo AES-256-CTR with an
   HMAC-SHA256 prefix, applied per path segment with separators preserved, key
   persisted in `state.vscdb`. **Privacy Mode withholds the key from the
   server entirely**.
5. **Indexing waits for sign-in**: the path-encryption key is only generated
   after Cursor credentials exist, and file watchers are only created then.

---

## 1. Identity & package layout

- `Cursor` is a **VS Code fork**: `package.json` `repository: microsoft/vscode`,
  author `Anysphere`. Version confirmed by the update URL
  `https://api2.cursor.sh/updates/api/update/win32-x64-user/cursor/3.15.19/...`.
- Install dir: `C:\Users\david\AppData\Local\Programs\cursor` (also reachable
  as `...\Programs\Cursor`; same directory).

| Path (relative to `resources\app`) | Size | Role |
| --- | --- | --- |
| `out\main.js` | 1.8 MB | Electron main process |
| `out\vs\workbench\workbench.desktop.main.js` | 40.7 MB | Renderer bundle (all workbench code) |
| `extensions\cursor-retrieval\dist\main.js` | 2.4 MB | **The indexing engine** ("Handles indexing and retrieval for Cursor") |
| `extensions\cursor-retrieval\worker\dist\main.js` | 232 KB | Only a `computeLinesDiff` worker_threads helper |
| `extensions\cursor-retrieval\node_modules\@anysphere\file-service\file_service.win32-x64-msvc.node` | ~26 MB | Native Rust N-API addon |
| `resources\helpers\crepectl.exe` | 5.5 MB | Crepe CLI ("Instant Grep" snapshot index) |
| `resources\helpers\cursorsandbox.exe` | 3.5 MB | Sandboxed subprocess helper |
| `resources\helpers\node.exe` | 87 MB | Bundled Node |

Other bundled extensions seen: `cursor-ndjson-ingest` (debug log server),
`cursor-always-local` (experimentation), `cursor-resolver` (Cloud Agents
remote authority), plus the usual VS Code built-ins.

### 1.1 `@anysphere/file-service` native addon exports

`GrepClient` (crepe), `MerkleClient` (tree build + sync), `GitClient`,
`GitGraph`, `DiffClient`, `CodebaseSnapshotClient`, `GeneratePackfileStatus`,
`CommitChainGetFiles`, `GitHistorySession`, `MULTI_ROOT_ABSOLUTE_PATH`,
`CodebaseRejectionReason`, `AdvanceResult`.

### 1.2 Extension node modules

`@connectrpc/connect` + `protobufjs` (protocol stack), `zstd` (compression),
`@vscode/vscode-languagedetection`, `@anysphere/file-service`.

---

## 2. Network topology

| Surface | Host → chain |
| --- | --- |
| Indexing backend | `repo42.cursor.sh` → Cloudflare → AWS **us-east-1** (`cursor-lb-3-1690831134.us-east-1.elb.amazonaws.com`) |
| Main API | `api2.cursor.sh` → `api2direct.cursor.sh` → AWS us-east-1 (`ec2-compute-1.amazonaws.com`, `awsglobalaccelerator.com`, Cloudflare 104.18.x / 172.66.x) |
| Updates | `api2.cursor.sh/updates/api/update/...` |

- The **repo backend URL is not hardcoded** — it is delivered in the Cursor
  credentials (`repoBackendUrl`) and the indexing client re-connects when it
  changes (`onDidChangeCursorCreds`).

---

## 3. Protocol & message schema

- **Connect RPC** (`@connectrpc`) with protobuf messages declared via
  `lo.makeMessageType(...)` / `lo.makeEnum(...)` in the **`aiserver.v1`**
  namespace. Namespaces seen: `aiserver.v1`, `aiserver.v1.repository`,
  `aiserver.v1.grep`, `aiserver.v1.embedding`, `aiserver.v1.docs`,
  `aiserver.v1.git`, `aiserver.v1.common`.
- Message descriptors are embedded directly in the bundles (no external
  `.proto` file), which is what makes them extractable.

---

## 4. Indexing RPCs (client → server)

| RPC | Purpose |
| --- | --- |
| `FastRepoInitHandshakeV2` | open a repo sync session (params: `localCodebaseRootInfo`, `pathKey`, `doCopy`, SHA-256 content hashing) |
| `SyncMerkleSubtreeV2` | sync a Merkle subtree — only changed hashes travel |
| `FastUpdateFileV2` | push one changed file's content + hash |
| `FastRepoSyncComplete` | mark repo sync complete |
| `GetCopyStatus` | server-side repo copy status (`RepositoryCodebaseInfo.Status`) |
| `GetEmbeddings` | compute embeddings **server-side** (model per tier) |
| `SearchRepositoryV2` / `SemSearch` / `SemSearchFast` | semantic search; server-streaming; result metadata `query_embedding_model`, `embed_latency_ms`, `knn_latency_ms` |
| `RipgrepRawSearchParams` | server-side instant grep over synced repos |
| `SearchSymbolsParams` → `SearchSymbolsResult.SymbolMatch` | `@Symbols` |
| `GetDoc` / `UpsertAllDocs` / `RescrapeDocs(V2)` | `@Docs` pipeline |

### Notable enums / messages

| Symbol | Values / meaning |
| --- | --- |
| `DatabaseProvider` | `Aurora` / `PlanetScale` — where the server stores chunks/embeddings |
| `EmbeddingModel` | `QWEN_1_5B_CUSTOM` (free tier), `EMBEDDING_MODEL_VOYAGE_CODE_2`, `TEXT_EMBEDDINGS_LARGE_3` |
| `RerankerAlgorithm` | `LULEA` / `UMEA` / `NONE` (server-side cross-encoder rerank) |
| `SimilarityMetricType` | `SIMHASH` + `orthogonal_transform_seed` (similar-codebase matching) |
| `RepositoryCodebaseInfo.Status` | `UP_TO_DATE` / `OUT_OF_SYNC` / `EMPTY` / `EMPTY_WITH_COPY_AVAILABLE` / `COPY_IN_PROGRESS` |
| `QueryOnlyRepoAccess` | carries a GitHub token for **query-only** search of a similar repo on your behalf |
| `IndexingConfig` | server-controlled: max files, `indexing_period_seconds`, `repo42_auth_token`, incremental, path-encryption keys, `multi_root_indexing_enabled` |
| `SearchRepositoryV2` fields | `query`, `top_k`, `rerank` (bool), `glob_filter`, `race_n_requests`, `QueryOnlyRepoAccess` |

---

## 5. Client-side indexing orchestration

### 5.1 Lifecycle

```
loading → indexing-setup → indexing-init-from-similar-codebase
       → indexing → synced
       (also: not-indexed, not-auto-indexing, error)
```

### 5.2 Gating

- `getIndexingIntent()` → `Rte`: `should-index` / `should-not-index` /
  `default`.
- If intent is `default` and file count > `autoIndexingMaxNumFiles`, Cursor
  does **not** auto-index → status `not-auto-indexing`.
- Indexing the **home directory** is refused: *"We currently do not allow
  indexing the home directory."*

### 5.3 Watchers

`createWatchersIfShouldIndex()` creates file watchers that feed the Merkle
sync. Watchers are **re-evaluated/re-created** when:
- Cursor credentials change (`onDidChangeCursorCreds`, incl. new
  `repoBackendUrl`);
- **Privacy Mode** changes (`onDidChangePrivacyModeEnum` → *"Privacy mode
  changed to X; re-evaluating indexing watcher."*);
- codebase-telemetry config changes.

### 5.4 Merkle build & ignore merge

`constructMerkleTree()` reads, into the Merkle filter:
- `.cursorignore` / `.cursorindexingignore` (project),
- the `cursor.general.globalCursorIgnoreList` setting,
- an **admin-controlled blocklist**.

Hashing + tree building is native (`MerkleClient`). The server never receives
ignored files.

### 5.5 Timeouts

- `HANDSHAKE_TIMEOUT_MS = SYNC_MERKLE_TIMEOUT_MS = 18e5` (30 min)
- `SYNC_DELETES_TIMEOUT_MS = 18e4` (3 min)

### 5.6 Log channels (extension host)

- "Cursor Indexing & Retrieval"
- "Cursor Grep Service"
- "Cursor Git Graph"

---

## 6. Path encryption (the real thing)

- Per-repo key: `randomBytes(32).toString('base64url')` (AES-256).
- Derived keys: `macKey = SHA256(key ‖ 0x00)`, `encKey = SHA256(key ‖ 0x01)`.
- Per path segment: **AES-256-CTR** with a **10-byte zero IV** and a
  **6-byte HMAC-SHA256 prefix** (authenticated).
- Paths split on `/([./\\])/` — **separators survive encryption**, so the
  server still sees the directory-shape (a deliberate trade-off).
- A `plaintext` no-op scheme (`Wte`) exists for "no encryption".
- Key persisted per-repo in VS Code `workspaceState`
  (`state.vscdb` → `ItemTable`), key `anysphere.cursor-retrieval` →
  `{"cursor-retrieval-state-version":1}`, with
  `pathEncryptionKeySHA256Hash = SHA256(key + "_PATH_KEY_HASH_SHA256")` (hex)
  used to identify the key without exposing it.
- **Privacy Mode gating** (from the handshake code):
  `pathKey: !1 === We.cursor.getPrivacyMode() ? this.repoInfo.pathEncryptionKey : ""`
  — in Privacy Mode the key is **not sent**, so the server can't decrypt
  paths; outside Privacy Mode the key *is* sent (needed for team sharing /
  cross-device decryption).
- Override path key: `overridePathEncryptionKey` is threaded through
  `encryptPaths` / `decryptPaths` / `compileGlobFilter`; the renderer's
  `getOverridePathEncryptionKey()` supplies it for the query-only
  similar-codebase index. This is the mechanism behind the documented
  `.cursor/keys` → `path_decryption_key` custom key `[docs]`; `""` selects
  `plaintext`.
- **Sign-in dependency**: the path key is only generated once credentials
  exist — indexing literally does not start before sign-in.

---

## 7. Search flow (renderer)

`getFinalCodeResults` (renderer):
1. Call `SearchRepositoryV2` (or `SemSearch`/`SemSearchFast`) with
   `{ repoInfo, query, top_k, rerank, glob_filter }` (+ optional
   `QueryOnlyRepoAccess`).
2. Server returns top-k **encrypted paths** + scores (+ metadata
   `query_embedding_model`, `embed_latency_ms`, `knn_latency_ms`).
3. Client runs `decryptPaths({ paths, overridePathEncryptionKey })`.
4. Results are mapped back to real files for the agent / `@Codebase`.

Other retrieval shapes: `BM25Chunk` (lexical chunk, content/range/score),
`DocumentationChunk` (`@Docs`), `SearchSymbolsResult.SymbolMatch`
(`@Symbols`), `RipgrepRawSearchParams` (server-side instant grep).

---

## 8. Instant Grep / crepe (the local index)

- `crepectl.exe` = **"Crepe index management tool"**:
  `crepectl build -w <worktree> -c <commit> -C <cache-path> -f
  <no-filter|hidden-file-filter|ripgrep-default-filter> -M <memory-MB>`.
- Builds a **snapshot index from a git commit**; **memory-bounded with disk
  spilling** (default 25% of system RAM; low values clamped).
- `GrepClient.getWorkspaceStatuses()` → `indexReady` / `indexNone` /
  `indexPendingMax` snapshot counts (`indexNone > 0` recurring = a snapshot
  that never builds; `indexPendingMax > 0` = still warming).
- `GrepClient.takeLastUnsupportedReason()` → `index_unavailable` /
  `exec_failure` / `timeout` / `no_overlap` / `unknown`.
- Feature gate `grep_fallback_monitor` adds a fallback monitor: init outcomes
  (`no_crepectl`, `construct_threw`, `no_workspace`, `unsupported`) and
  recovery counters (transient git-lock IO, delayed retry rebuild).

---

## 9. User data & on-disk state

| Location | Contents |
| --- | --- |
| `%APPDATA%\Cursor\User\globalStorage` | VS Code-compatible global storage |
| `%APPDATA%\Cursor\User\workspaceStorage\<ws>\state.vscdb` | `ItemTable`, `cursorDiskKV` (key/value BLOB), `composerHeaders`; holds `anysphere.cursor-retrieval` state (path key etc.) |
| `%APPDATA%\Cursor\logs\` | Electron/extension host logs |
| `~\.cursor\agents\` | agent sessions |
| `~\.cursor\ai-tracking\ai-code-tracking.db` | `scored_commits`: `v1AiPercentage`, `v2AiPercentage`, `tabLinesAdded`, `composerLinesAdded`, `humanLinesAdded` — per-commit AI-percentage accounting |
| `~\.cursor\extensions\`, `plugins\`, `projects\` | installed extensions/plugins, project metadata |

**Key negative finding**: there is **no local embedding/index database**
anywhere (no `.db`/`.idx` holding vectors). The only on-disk index artifacts
are the crepe snapshots (once built) and the Merkle/state metadata. This
confirms the semantic index is server-side.

---

## 10. Privacy & auth summary

| Aspect | Finding |
| --- | --- |
| Sign-in | Required before indexing starts (path key generation) |
| Privacy Mode | ON → `pathKey: ""` (key withheld); training opt-in also gated (`waitForTeamPrivacyModeFetched`, `getPrivacyModeEnum`, `privacyModeDisallowed`) |
| Models | Server-side: Qwen 1.5B custom (free) / Voyage Code 2 / OpenAI text-embedding-3-large |
| ZDR / CMEK / residency | documented `[docs]`; see SEMANTIC-INDEXING.md §6 |

---

## 11. Evidence file paths

- `C:\Users\david\AppData\Local\Programs\Cursor\resources\app\extensions\cursor-retrieval\dist\main.js`
- `C:\Users\david\AppData\Local\Programs\Cursor\resources\app\extensions\cursor-retrieval\node_modules\@anysphere\file-service\index.js` (+ `.node` addon)
- `C:\Users\david\AppData\Local\Programs\Cursor\resources\app\resources\helpers\crepectl.exe`
- `C:\Users\david\AppData\Local\Programs\Cursor\resources\app\out\vs\workbench\workbench.desktop.main.js`
- `C:\Users\david\AppData\Local\Programs\Cursor\resources\app\out\main.js`
- `%APPDATA%\Cursor\User\workspaceStorage\*\state.vscdb`
- `~\.cursor\ai-tracking\ai-code-tracking.db`

---

## 12. Status of this research

- Research mode: findings captured, **not** committed.
- Cursor 3.15.19 was exercised against a throwaway test workspace
  (`%TEMP%\cursor-re-test`) and was observed gated on sign-in (path key not
  generated).
- When a new Cursor version ships, re-verify: RPC names, hostnames,
  encryption constants, ignore-list keys, and the `[src]`-tagged claims above.
