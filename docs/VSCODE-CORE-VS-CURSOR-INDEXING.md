# VS Code Core vs. Cursor — Search & Indexing, Deep Comparison

How **stock VS Code (the editor itself — no Copilot)** approaches search and
indexing, compared on a deep level with **Cursor 3.15.19's** indexing
(reverse-engineered, see
[`CURSOR-INDEXING-REVERSE-ENGINEERING.md`](CURSOR-INDEXING-REVERSE-ENGINEERING.md)).

> **The one-sentence answer:** VS Code core **does not build any index at
> all** — its search is stateless and on-demand (ripgrep text search, glob
> file search, live LSP symbol queries) — while Cursor ships a **full
> server-side semantic index** (Merkle-synced, server embeddings/KNN/rerank)
> plus a **local** lexical snapshot index (`crepe`/Instant Grep). VS Code's
> only "AI search" is an **extension point** (proposed API) that Copilot
> fills; Cursor bakes it into the product.

---

## Provenance

| Half | Basis |
| --- | --- |
| **VS Code core** | Grounded in the **actual source** of this fork (base 1.134.0), file paths cited throughout. |
| **Cursor** | Reverse-engineered from the **installed 3.15.19 binary** `[src]` + Cursor docs `[docs]` (full evidence in `CURSOR-INDEXING-REVERSE-ENGINEERING.md`). |

---

## 1. What exists at all (search surfaces)

| Surface | VS Code core | Cursor |
| --- | --- | --- |
| Find in Files (text) | ✅ ripgrep subprocess, on demand | ✅ Instant Grep (`crepe` local index) + server-side grep |
| File-name search / Quick Open | ✅ on-demand glob walk + fuzzy score | ✅ on-demand walk + fuzzy (VS Code fork) |
| Workspace symbols | ✅ live LSP `workspace/symbol` query | ✅ `@Symbols` (server symbol index) |
| Semantic / meaning-based search | ❌ **none in core** | ✅ server-side embeddings (`@Codebase`) |
| "AI results" in Search view | ✅ **shell only** — results come from an extension (Copilot) via proposed API | ✅ built-in (`@Codebase`), no extension needed |
| Docs indexing (`@Docs`) | ❌ none | ✅ server-side `GetDoc`/`UpsertAllDocs` pipeline |
| Persistent index of any kind | ❌ **none** | ✅ server-side embedding index + local crepe snapshots |
| Offline semantic search | n/a (no semantic search) | ❌ (server KNN) |
| Offline lexical search | ✅ ripgrep (fully local) | ✅ crepe (fully local) |

---

## 2. Architecture & state

```
VS Code core                                        Cursor
────────────────────                                ─────────────────────
query ──► ISearchService ──► ripgrep ──► matches    workspace ──► watchers
            (no cache, no                          constructMerkleTree (Rust)
             precomputed state)                        │
                                                     ▼
                                            repo42.cursor.sh (AWS us-east-1)
                                            ┌───────────────────────────────┐
                                            │ handshake → Merkle subtree sync│
                                            │ → server chunk + embed + KNN  │
                                            │ → rerank (LULEA/UMEA/NONE)    │
                                            └───────────────────────────────┘
                                                     ▲
query ──► SearchRepositoryV2 ──► top-k encrypted paths
            └─ decryptPaths client-side ──► results

crepe (LOCAL, Cursor only):
git commit ──► crepectl.exe build ──► snapshot index on disk
            └─ GrepClient (native) searches it with full regex
```

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| Does the client precompute anything? | No. Ripgrep re-reads files on every query | Yes: Merkle tree of file hashes (native `MerkleClient`) synced to the server |
| Where does search state live? | Nowhere — stateless | Server (embeddings, KNN, repo copy) + `state.vscdb` (path key, merkle state) + crepe snapshots (local) |
| Incremental updates | n/a | Merkle subtree sync: only changed hashes/files travel (`SyncMerkleSubtreeV2`, `FastUpdateFileV2`) |
| Cold-start cost | Zero (no index) | Full sync + server embedding of the whole repo (minutes-to-hours on big repos; capped by `autoIndexingMaxNumFiles`) |
| Failure mode | Query fails → no results | Index not ready → status `indexing` / `not-indexed`, or query-only fallback to a similar repo |
| Key service files | `services/search/common/searchService.ts`, `node/ripgrepTextSearchEngine.ts` | bundled `anysphere.cursor-retrieval` extension + `@anysphere/file-service` addon |

---

## 3. Text search engine (the lexical core)

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| Engine | **ripgrep** — bundled `@vscode/ripgrep-universal ^1.18.0`, spawned per folder as a subprocess (`RipgrepTextSearchEngine`, `src/vs/workbench/services/search/node/ripgrepTextSearchEngine.ts`) | **crepe / "Instant Grep"** — native `GrepClient` over a **prebuilt snapshot index** (`crepectl.exe build -w <worktree> -c <commit> ...`) |
| Index | None — ripgrep scans files each query (parallel traversal + mmap) | **Local snapshot index built from a git commit** — memory-bounded with disk spilling (default 25% RAM), filters `no-filter` / `hidden-file-filter` / `ripgrep-default-filter` |
| Regex | Full (PCRE2-backed; `unicodeEscapesToPCRE2` converts `\u` escapes; PCRE2 compile-error surfacing) | Full regex + word-boundary (`[docs]`) |
| Multiline | ✅ (ripgrep `--multiline` path in engine) | ✅ (has a `computeLinesDiff` worker; multiline grep) `[src]` |
| Result streaming | ✅ streamed/parsed incrementally (`RipgrepParser`), cancel on `maxResults` | ✅ progress callbacks; results chunked (`BM25Chunk`) |
| `maxResults` | `DEFAULT_MAX_SEARCH_RESULTS = 20000` (`services/search/common/search.ts`) | `top_k` per query (server) |
| Remote | ripgrep runs in remote extension host (ships in `remote/package.json`) | Server-side `RipgrepRawSearchParams` for cloud; local crepe for desktop |
| Speed profile | Fast cold start, no memory cost; re-scans per query | Index build upfront; sub-ms-ish searches after; costs RAM/disk for the snapshot |
| Fallback monitoring | n/a | Feature gate `grep_fallback_monitor`: reasons `index_unavailable` / `exec_failure` / `timeout` / `no_overlap`; statuses `indexReady` / `indexNone` / `indexPendingMax` |

---

## 4. Semantic (meaning-based) search

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| Semantic search in core | **Does not exist.** No embeddings, no vector store, no reranker in `src/vs/workbench/services/search/**` | Full pipeline: server embeddings → KNN → rerank (`SearchRepositoryV2`/`SemSearch`/`SemSearchFast`) |
| Where embeddings computed | n/a | **Server-side only** (`GetEmbeddings`); no local embedding model bundled |
| Models | n/a | Qwen 1.5B custom (free tier), Voyage Code 2, OpenAI text-embedding-3-large |
| Query embedding | n/a | Server-side; result metadata exposes `query_embedding_model`, `embed_latency_ms`, `knn_latency_ms` |
| Reranking | n/a (ripgrep results are ranked by file/score only) | Server-side `RerankerAlgorithm`: `LULEA` / `UMEA` / `NONE` |
| Offline | n/a | ❌ semantic requires the server |
| Privacy of code in the index | n/a (code never leaves the machine) | Paths AES-256-CTR encrypted; key withheld from server in Privacy Mode; server holds embeddings |

---

## 5. "AI search" in the Search view

This is the dimension people most often confuse. **VS Code core does have an
"AI Results" section in the Search view — but core only renders it.** The
semantic work is delegated to an extension through a **proposed API**.

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| Surface | "AI Results" heading in Search view (`AISearch/aiSearchModel.ts`, `AITextSearchHeadingImpl`) | `@Codebase` / `@Symbols` / agent tools; no separate view needed |
| Where the engine lives | **Extension**, via `vscode.workspace.registerAITextSearchProvider` (proposed API `aiTextSearchProvider`, `src/vscode-dts/vscode.proposed.aiTextSearchProvider.d.ts`) | **Built-in**: `anysphere.cursor-retrieval` extension + server |
| Core's part | Provider registry (`searchService.ts` `aiTextSearchProviders` map), `AISearchKeyword`/`AISearchResult` types, result rendering, and the `search.searchView.semanticSearchBehavior` setting (`manual` / `runOnEmpty` / `auto`) | Everything: indexing, sync, retrieval, encryption |
| The actual provider (in this fork) | **Copilot**: `SemanticSearchTextSearchProvider` (`extensions/copilot/src/extension/workspaceSemanticSearch/node/semanticSearchTextSearchProvider.ts`), name `"Copilot"`, registered in `conversationFeature.ts` for scheme `file` | n/a (Cursor's provider is internal) |
| What Copilot's provider does | Wraps `IWorkspaceChunkSearchService` (the `#codebase` index) + **LLM rerank** via a utility-small model endpoint (`copilot-utility-small`) + tree-sitter parsing + combined ranking (`combinedRank.ts`) | Server KNN + `RerankerAlgorithm` |
| Keyword plumbing | `AISearchKeyword` emitted as a progress item; `isAIKeyword` narrows it | Server-streamed results |
| Works without an AI extension | **No AI results** (core is a shell) | ✅ always available |

**Takeaway**: on VS Code core, "semantic search" is an *extension contract*,
not a feature. Cursor made the same capability a *first-class, account-gated
product feature*.

---

## 6. Workspace symbols

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| Mechanism | **Live LSP `workspace/symbol`** queries: `WorkspaceSymbolProviderRegistry` (`contrib/search/common/search.ts`) → providers registered by language servers (`extHostLanguageFeatures.ts` `provideWorkspaceSymbols`) | Server-side symbol index (`SearchSymbolsParams` → `SearchSymbolsResult.SymbolMatch`) |
| Index? | **No** — every keystroke re-queries all providers (`getWorkspaceSymbols` fans out + dedupes) | Yes — symbols indexed server-side alongside chunks |
| Who provides symbols | Any extension (e.g. TypeScript/other language servers); core only orchestrates/dedupes/sorts | Cursor's own indexer (language-aware server-side) |
| Entry points | `#` in Quick Open (`symbolsQuickAccess.ts`), search view, `vscode.executeWorkspaceSymbolProvider` | `@Symbols` mention, agent tool |
| Language coverage | Whatever language servers you have installed (rich, per-language) | Cursor's server-side parser coverage |
| Offline | ✅ works offline (if LSP is local) | ❌ (server) |

---

## 7. File search & Quick Open

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| File-name search | On-demand **glob walk** (`FileSearchEngine`, `services/search/common/fileSearchManager.ts`; web: `worker/localFileSearch.ts`) | Same VS Code fork machinery + file watchers feed the Merkle sync |
| Quick Open ranking | **Fuzzy scoring** in-memory (`fuzzyScore` / `scoreItemFuzzy`, `src/vs/base/common/fuzzyScorer.ts`; `FuzzyScorerCache` is per-session only) | Same fork fuzzy scorer |
| File index | **None** — files are listed on demand, then ranked | Merkle tree (hashes only, not names-for-search) + crepe snapshots |
| History | `search.quickOpen.includeHistory` — recently opened files merged in | Fork + proprietary recency |
| Symbols in Quick Open | `search.quickOpen.includeSymbols` merges workspace-symbol results | `@Symbols` is a separate surface |

---

## 8. Docs indexing (`@Docs`)

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| External documentation search | ❌ none | ✅ `@Docs`: `GetDoc` / `UpsertAllDocs` / `RescrapeDocs(V2)` RPCs; `DocumentationChunk` results |
| Where docs are indexed | n/a | Server-side (docs are scraped/upserted to Cursor's backend) |

---

## 9. Ignore & exclusion model

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| Text search | `search.exclude` + `files.exclude` merged (`getExcludes`), `.gitignore`/`.ignore` via `search.useIgnoreFiles`, global/parent variants, `search.followSymlinks` | Same fork machinery **plus** `.cursorignore` / `.cursorindexingignore` / global list / admin blocklist merged into the Merkle filter (`constructMerkleTree`) |
| Semantic index | n/a (no index) | Ignore list decides **what the server ever sees** (stronger: ignored files never leave the machine) |
| "Don't show in search" vs "don't let AI read" | Single model (`search.exclude`) | Two knobs: `.cursorindexingignore` (search only) vs `.cursorignore` (search + AI access) `[docs]` |
| Admin control | n/a (org policies, not per-index) | Server-admin blocklist + `cursor.general.globalCursorIgnoreList` `[src]` |

---

## 10. Privacy & auth

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| Account required to search | **No** — everything local | Index waits for **sign-in** (path key generation) `[src]`; docs say "works logged out" but indexing doesn't start `[src]` |
| Code leaves the machine? | **Never** (ripgrep + LSP are local/remote-but-yours) | **Yes** — file hashes + (encrypted) paths + file contents for embedding go to `repo42.cursor.sh` |
| Path/name protection | n/a (nothing leaves) | AES-256-CTR per-repo key, HMAC prefix, separators preserved; key **withheld in Privacy Mode** `[src]` |
| Embedding storage | n/a | Cursor infra (Aurora/PlanetScale); CMEK + US residency options `[docs]` |
| Training | n/a | Privacy Mode gates training opt-in (`privacyModeDisallowed`) `[src][docs]` |
| Offline privacy | ✅ total | ⚠️ semantic index is cloud; lexical grep is local |

---

## 11. Offline & resource profile

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| Text search offline | ✅ fully | ✅ crepe (after snapshot built) |
| Semantic search offline | n/a | ❌ |
| RAM/disk footprint | Minimal; ripgrep is a short-lived process | crepe snapshot (25%-of-RAM budget, disk spilling) + merkle state + network |
| Network dependency for search | None (ripgrep local; LSP local or your remote) | Semantic: hard dependency on Cursor's servers |
| Startup cost | None | Watchers + merkle build + handshake on workspace open |

---

## 12. Extensibility

| Dimension | VS Code core | Cursor |
| --- | --- | --- |
| Search APIs | Stable: `TextSearchProvider`, `FileSearchProvider`, `findTextInFiles`; workspace symbols via `WorkspaceSymbolProvider` | Same fork APIs + internal-only retrieval |
| AI search API | **Proposed** `AITextSearchProvider` (opt-in, experimental) | n/a (internal) |
| Can a third party plug a semantic index into core? | ✅ (that's exactly what Copilot does) | No extension point — it's the product |
| Forking implication | A fork inherits the shell + proposed API, must build/borrow the engine | Closed |

---

## 13. Settings & configuration

| Area | VS Code core (settings) | Cursor |
| --- | --- | --- |
| Where results appear | `search.mode` = `view` / `reuseEditor` / `newEditor` (Search view vs search editor) | n/a (agent mentions) |
| Lexical options | `search.smartCase`, `search.followSymlinks`, `search.useIgnoreFiles`, `search.useGlobalIgnoreFiles`, `search.useParentIgnoreFiles`, `search.ripgrep.maxThreads`, `search.exclude`, `search.maxResults` | Fork settings + `Cursor Settings > Indexing` `[docs]` |
| AI results behavior | `search.searchView.semanticSearchBehavior` = `manual` / `runOnEmpty` / `auto` | n/a |
| Indexing controls | **None** (no index to control) | `autoIndexingMaxNumFiles`, `cursor.general.globalCursorIgnoreList`, admin blocklist, `.cursor/keys` override `[src]` |
| On-type search | `search.searchOnType` + `search.searchOnTypeDebouncePeriod` | n/a |

---

## 14. Scaling behavior

| Repo size | VS Code core | Cursor |
| --- | --- | --- |
| Small | ripgrep instant | Overhead of building/syncing an index for a tiny repo |
| Large (100k+ files) | ripgrep stays O(files) per query; no index to maintain — predictable, CPU-bound | Server index amortizes; but cold sync is expensive and capped (`autoIndexingMaxNumFiles` → `not-auto-indexing`) |
| Huge monorepos | ripgrep still works; users rely on `search.exclude` to keep it fast | Cursor needs the index; similar-codebase (SIMHASH) reuse can bootstrap |
| Multi-root | Each folder queried (`folderQueries`, `FolderQuerySearchTree`) | `multi_root_indexing_enabled` server config `[src]` |

---

## 15. Implications for NikaCode (a VS Code fork)

1. **You inherit "no index" for free.** A NikaCode user who isn't signed into
   GitHub/Copilot still gets fast, fully-local ripgrep search, file search, and
   LSP workspace symbols — nothing regresses.
2. **The semantic path is an extension contract, not core.** To offer
   semantic search without Copilot, you either (a) implement
   `AITextSearchProvider` (the Search-view "AI Results" hook) or (b) ship an
   agent tool like `#codebase`. Core won't do it for you.
3. **Cursor shows the full product shape** you'd have to build yourself:
   Merkle-sync client, server embedding/KNN/rerank, path encryption, sign-in
   gating, and a local lexical index (crepe). The cheapest local win is a
   **crepe-style snapshot grep**; the expensive one is the server.
4. **Privacy is the differentiator.** VS Code core never uploads code; any
   semantic-index feature you add (Copilot-style or Cursor-style) changes that
   contract. Cursor's path encryption + Privacy Mode key-withholding is the
   reference design to copy if you build one.

---

## 16. Sources

**VS Code core (this fork, base 1.134.0):**
- `src/vs/workbench/services/search/common/search.ts` — query model, `DEFAULT_MAX_SEARCH_RESULTS = 20000`, `ISearchConfigurationProperties`, `getExcludes`, `SemanticSearchBehavior`, `isAIKeyword`
- `src/vs/workbench/services/search/common/searchService.ts` — `ISearchService`, `aiTextSearchProviders` registry
- `src/vs/workbench/services/search/node/ripgrepTextSearchEngine.ts` — `RipgrepTextSearchEngine`, `getRgArgs`, `RipgrepParser`, PCRE2 handling
- `src/vs/workbench/services/search/common/fileSearchManager.ts` — `FileSearchEngine` glob walk
- `src/vs/workbench/services/search/worker/localFileSearch.ts` — web file search worker
- `src/vs/workbench/contrib/search/browser/anythingQuickAccess.ts` + `src/vs/base/common/fuzzyScorer.ts` — Quick Open fuzzy file search
- `src/vs/workbench/contrib/search/common/search.ts` — `WorkspaceSymbolProviderRegistry`, `getWorkspaceSymbols`
- `src/vs/workbench/api/common/extHostLanguageFeatures.ts` — LSP `workspace/symbol` (`provideWorkspaceSymbols`)
- `src/vscode-dts/vscode.proposed.aiTextSearchProvider.d.ts` + `src/vs/platform/extensions/common/extensionsApiProposals.ts` — proposed `AITextSearchProvider`
- `src/vs/workbench/services/search/common/searchExtTypes.ts` — `AITextSearchProvider`, `AISearchKeyword`, `AISearchResult`
- `src/vs/workbench/contrib/search/browser/AISearch/aiSearchModel.ts` — AI result heading rendering
- `src/vs/workbench/contrib/search/browser/search.contribution.ts` — search settings
- `package.json` / `remote/package.json` — `@vscode/ripgrep-universal ^1.18.0`

**Copilot's AI-search implementation (referenced for §5):**
- `extensions/copilot/src/extension/workspaceSemanticSearch/node/semanticSearchTextSearchProvider.ts`
- `extensions/copilot/src/extension/conversation/vscode-node/conversationFeature.ts`

**Cursor:**
- [`CURSOR-INDEXING-REVERSE-ENGINEERING.md`](CURSOR-INDEXING-REVERSE-ENGINEERING.md) — full evidence (RPCs, encryption, crepe, endpoints)
- Cursor docs (Instant Grep, ignore files, privacy) — see `SEMANTIC-INDEXING.md` §9
