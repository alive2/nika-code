# NikaCode Token Usage Tracking — Design & Implementation

**Status:** **Implemented.** DeepSeek token usage is tracked per message,
session, workspace, and day, surfaced live in the status bar and in a new
`Usage` section of Nika Settings (Nika's dashboard). Costs use DeepSeek's
peak / off-peak billing (effective 2026-08-16) and are shown alongside token
counts and a per-day chart. Companion docs:
[`INDEXING-DESIGN.md`](INDEXING-DESIGN.md) (semantic indexing),
[`ARCHITECTURE.md`](ARCHITECTURE.md) (general fork architecture).

---

## 1. What we're building (one paragraph)

A **DeepSeek-only token ledger** for NikaCode:

- A setting — `nika.usage.enabled` (default on) — that gates recording.
- A **live status-bar item** (`nika.usageStatus`): while a response streams it
  shows a running output-token counter; when idle it shows today's totals plus
  the current DeepSeek **rate period** (`PEAK` / `OFF-PEAK`). Clicking opens
  Nika Settings on the `usage` section.
- A **Usage dashboard** in the Nika Settings webview: current rate period,
  KPIs (today / last 14 days tokens and cost), a hand-rolled inline SVG
  **tokens-per-day bar chart**, sessions table, workspaces table, recent
  requests table, and a *Clear usage data* button.
- **Real chat session ids** threaded from Copilot Chat and the Agents window
  so session grouping reflects actual conversations, with a heuristic
  fallback for callers that don't thread one.

**No server is involved.** Everything runs in the extension host and persists
in `globalState`.

---

## 2. Grounding: what the fork already has

- `modelOptions` is a **free-form passthrough** end-to-end:
  `LanguageModelChatRequestOptions.modelOptions` →
  `ProvideLanguageModelChatResponseOptions.modelOptions` → the Nika provider.
  It was already used for `_capturingTokenCorrelationId`, `_otelTraceContext`,
  `_telemetryTurn`, and `_nikaThinkingEffort`.
- The exact server usage arrives at stream end as a
  `new vscode.LanguageModelDataPart(utf8(JSON(APIUsage)), CustomDataPartMimeTypes.Usage)`
  emitted by `CopilotLanguageModelWrapper.provideLanguageModelResponse`
  (`languageModelAccess.ts`). `APIUsage` carries `prompt_tokens`,
  `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`,
  and `completion_tokens_details.reasoning_tokens`.
- Nika Settings is a single vanilla-JS webview with a strict CSP
  (`default-src 'none'`; no CDN libs, no `fetch`), so the per-day chart is a
  hand-rolled inline SVG.
- The `NikaIndexingStatus` status-bar item established the `showProgress =
  'loading'` stable-spin pattern reused here.

---

## 3. DeepSeek pricing model (peak / off-peak)

Effective 2026-08-16 16:00 UTC, DeepSeek bills **peak vs off-peak**:

| | Peak (per 1M tokens) | Off-peak |
|---|---|---|
| **Cache hit (input)** | Flash $0.014 · Pro $0.044 | half of peak |
| **Cache miss (input)** | Flash $0.44 · Pro $1.32 | half of peak |
| **Output** | Flash $1.32 · Pro $3.96 | half of peak |

- **Peak hours (UTC):** `01:00–04:00` and `06:00–10:00` — half-open
  boundaries (`04:00` is off-peak, `06:00` is peak).
- `-responses` models bill at their base model rate
  (`deepseek-v4-pro-responses` → `deepseek-v4-pro`).
- Cost per request = `hit×$hit + miss×$miss + output×$output`, scaled `×0.5`
  off-peak, with the cache split taken from `APIUsage.prompt_tokens_details`.

---

## 4. Files

### New

| File | Role |
|---|---|
| `extensions/copilot/src/extension/byok/vscode-node/nikaPricing.ts` | Pricing table, `isDeepSeekPeakHour`, `getDeepSeekTokenCost`, `formatCost`, `formatTokenCount` |
| `extensions/copilot/src/extension/byok/vscode-node/nikaUsageTracker.ts` | `NikaUsageEvent` ledger in `globalState` (cap 5000, prune oldest), `TokenTrackingProgress` wrapper, per-day/session/workspace aggregations |
| `extensions/copilot/src/extension/byok/vscode-node/nikaUsageStatus.ts` | Status-bar item with live counter + PEAK/OFF-PEAK idle state |
| `.../test/nikaPricing.spec.ts` | Peak boundaries, cost math, formatting |
| `.../test/nikaUsageTracker.spec.ts` | Record/persist/prune, aggregates, progress wrapper, heuristic ids |

### Modified

| File | Change |
|---|---|
| `extensions/copilot/.../nikaProvider.ts` | Constructs `NikaUsageTracker`/`NikaUsageStatus`; DeepSeek branch wraps the progress reporter, reads `_nikaSessionId`, records exact usage (or live-estimate fallback) on success and `{error:true}` on failure |
| `extensions/copilot/.../nikaSettingsEditor.ts` | New `usage` section: rate card, KPIs, SVG chart, sessions/workspaces/messages tables, clear button, `nika.usage.enabled` |
| `extensions/copilot/.../extChatEndpoint.ts` | Path A: threads `conversationId` as `_nikaSessionId` in `modelOptions` |
| `src/vs/platform/agentHost/node/copilot/byokLmProxyService.ts` | Path B (core): threads `auth.sessionId` as `_nikaSessionId` in the bridge request |
| `extensions/copilot/package.json` + `package.nls.json` | `nika.usage.enabled` config + NLS |

---

## 5. Session id threading

- **Path A — Copilot Chat (extension-only):**
  `defaultIntentRequestHandler` already supplies `conversationId` (=
  `conversation.sessionId`) in `IMakeChatRequestOptions`. `extChatEndpoint.ts`
  destructures it and adds `...(conversationId ? { _nikaSessionId: conversationId } : {})`
  to `vscodeOptions.modelOptions`.
- **Path B — Agents window (one core file):**
  `byokLmProxyService.ts` parses `Bearer <nonce>.<sessionId>` and rebuilds the
  bridge request as `{ ...bridgeRequest, modelOptions: { ...(bridgeRequest.modelOptions ?? {}), _nikaSessionId: sessionId } }`
  (spread — `modelOptions` is `readonly` on `IByokLmChatRequest`).
  `agentHostByokLmHandler` passes `modelOptions` through untouched.
- **Fallback:** when no `_nikaSessionId` is present (e.g. MCP sampling),
  `NikaUsageTracker` builds a heuristic id from
  `workspace|initiator` + a 30-minute burst window so nothing goes untracked.

---

## 6. Live vs exact token counts

- **Live:** `TokenTrackingProgress` counts streamed
  `LanguageModelTextPart` / `LanguageModelThinkingPart` characters
  (≈4 chars/token) for a throttled status-bar estimate; the status bar shows a
  stable-spin indicator while streaming.
- **Exact:** the `'usage'` data part is parsed when the stream completes;
  exact prompt/completion/cached/reasoning tokens and the computed cost are
  what get recorded to the ledger.
- **Fallback:** if a request succeeds but no `'usage'` part arrives, the live
  estimate is recorded so the request is still accounted for.

---

## 7. Validation

- Extension: `npx tsc --noEmit --project tsconfig.json` (only pre-existing
  `copilotcliPromptResolver.ts` errors) + `npm run compile` (esbuild) clean.
- Unit: `vitest` — pricing (10), usage tracker (10), ext endpoint incl.
  `_nikaSessionId` (12), DeepSeek/OpenAI endpoints (47), full
  `byok/vscode-node/test` folder (94 pass / 3 skipped).
- Core: `npm run typecheck-client` clean; `test/unit/node` `ByokLmProxyService`
  suite incl. the `_nikaSessionId in modelOptions` test passes.
