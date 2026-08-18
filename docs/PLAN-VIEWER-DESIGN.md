# Cursor-Style "View Plan" — Reverse Engineering & Implementation Plan

> Status: Design doc — no code changes yet
> Date: 2026-08-17
> Scope: NikaReimagined (VS Code 1.134 fork)

## TL;DR

Cursor's "View Plan" is a **custom editor** that renders the plan as rich markdown (with mermaid diagrams) plus an **interactive TODO checklist pinned at the bottom**, backed by a real `*.plan.md` file on disk. The file is the single source of truth; the agent updates the file's checklist (or the todo tool) while executing, and the view **re-renders live** — showing which task is in-progress and ticking items off as they complete. You can also **edit the lists in the view** (add items, toggle checkboxes), which writes back to the file.

The fork already has ~90% of the plumbing: plan markdown rendering (`ChatPlanReviewPart`), a live todo service + widget (`IChatTodoListService` + `manage_todo_list`), a markdown checkbox parser (`parseTodoMarkdown`), mermaid rendering (chat output renderer + markdown-it plugin), and a workbench-native editor template (`AgentPluginEditor`). What's missing is (a) a **dedicated Plan Viewer surface**, (b) a **live todo bridge for agent-host sessions** (the biggest gap — agent-host `update_todo`/`TodoWrite` calls are display-only today), and (c) a **plan file ↔ session binding** so the viewer knows which session's todos to track.

**Recommended approach: a workbench-native editor pane** (`PlanViewEditor` + `PlanViewEditorInput`) registered like `AgentPluginEditor`, opened from a "View Plan" button on `ChatPlanReviewPart`. It renders the plan markdown through the chat markdown pipeline (so mermaid works for free), parses the plan's checklist, overlays live statuses from `IChatTodoListService`, and writes edits through to the plan file.

---

## 1. How Cursor does it (reverse engineering)

From the user's screenshot + Cursor behavior:

### 1.1 The plan is a real file
- Plans live as **`*.plan.md` files in a `Plans/` folder** in the workspace (visible in the Explorer: `Plans > complete_ui_ux_redesign_06be85aa.plan.md`).
- The filename is `<slugified-title>_<short-timestamp>.plan.md`.
- Because it's a real file: it's diffable, shareable, editable in any editor, and the agent can update it with ordinary file tools.

### 1.2 The "View Plan" view is a custom editor
- A **"View Plan" button** in the Composer opens a custom editor tab (Cursor registers a `CustomEditorProvider`-style editor for `.plan.md`).
- The editor renders:
  - **Markdown content** with sections (Context, phases, etc.)
  - **Mermaid diagrams** (` ```mermaid ` fences rendered to SVG)
  - A **TODO checklist at the bottom** — parsed from the markdown's checkbox items, rendered as an interactive list (checkboxes clickable).
- The view is **live**: while the agent implements the plan, checkboxes flip to done and the current task is highlighted. Cursor achieves this because its agent updates the plan file / todo list as it works, and the view re-renders on change.
- The view is **editable**: you can add new items to the markdown lists (including the TODO list) directly in the view; edits persist to the file and feed back into execution.

### 1.3 Checklist convention
- Markdown task checkboxes: `- [ ]` (not started), `- [x]` (done), `- [>]` (in-progress — Cursor's convention).
- The agent maintains one checklist (the plan's "Steps" / "TODO" section) as its working list.

### 1.4 Key architectural insight
**The plan file is the source of truth; the view is a rich renderer + editor overlay that stays in sync via file changes and a live todo channel.** No separate plan model — the markdown structure (sections, mermaid, checklist) IS the plan.

---

## 2. What already exists in this fork

### 2.1 Plan markdown in chat — `ChatPlanReviewPart`
`src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatPlanReviewPart.ts`
- Renders `IChatPlanReview` (`title` + `content` markdown + approval actions) as a chat list item.
- `renderMarkdown()` (line ~313) renders via `IMarkdownRendererService`; re-renders on plan file change (`updatePlanContentFromModel()`, file watcher at line ~281).
- Header has **"Open Full Plan" / "Open Plan"** button (`_reviewButton`, line ~700) which opens the plan file in the markdown editor (`override: MARKDOWN_EDITOR_ID`, pinned).
- Inline feedback via `IPlanReviewFeedbackService` (editor comments).
- **Gap**: uses the *plain* markdown renderer — mermaid code fences do NOT render here (no `codeBlockRendererSync` hook). And "Open Full Plan" goes to the markdown editor, not a rich plan view.

### 2.2 Live todo service + widget — already live
- `IChatTodoListService` (`src/vs/workbench/contrib/chat/common/tools/chatTodoListService.ts`): `IChatTodo { id, title, status: 'not-started' | 'in-progress' | 'completed' }`, `setTodos(sessionResource, todos)`, **`onDidUpdateTodos: Event<URI>`**, persisted per session in Memento.
- `manage_todo_list` tool (`builtinTools/manageTodoListTool.ts`): model calls it → `ChatToolInvocationPart` sees `toolSpecificData.kind === 'todoList'` → `chatTodoListService.setTodos(sessionResource, todos)` (chatToolInvocationPart.ts ~line 120).
- `ChatTodoListWidget` (`widget/chatContentParts/chatTodoListWidget.ts`): expando header "Todos (3/5)" + `WorkbenchList<IChatTodo>` with status icons, auto-collapse, lives in the chat **input area**.
- **This pipeline is workbench-session-only** (works for custom agents like the Plan agent and `manage_todo_list` invocations).

### 2.3 Markdown checkbox parser — already exists
`extensions/copilot/src/extension/chatSessions/copilotcli/common/copilotCLITools.ts`:
- `parseTodoMarkdown(markdown)` (line ~1433): parses `- [ ]`, `- [x]`, `- [>]`, `- [~]` (unordered + ordered) into `{ id, title, status }` — **exactly the Cursor convention**, including `>` = in-progress.
- `updateTodoListFromSqlItems()` (line ~1570): the pattern for pushing external todo data into the workbench todo service (used by the legacy Copilot CLI bridge: SQLite `todos` table → `manage_todo_list` invoke).
- **Gap**: this lives in the *extension*; the workbench has no equivalent parser (needed for the viewer).

### 2.4 Mermaid — renders in chat, not in plan reviews
- `extensions/mermaid-markdown-features/package.json`: `chatOutputRenderers` contribution (`mimeTypes: text/vnd.mermaid`, `codeBlockLanguageIdentifiers: ['mermaid']`) → renders mermaid in **chat markdown parts** via `IChatOutputRendererService`.
- `ChatMarkdownContentPart` (`widget/chatContentParts/chatMarkdownContentPart.ts` line ~242): `codeBlockRendererSync` hook → `chatOutputRendererService.hasCodeBlockRenderer(languageId)` → webview-based mermaid rendering (pan/zoom, open-in-editor).
- Markdown **preview** renders mermaid via markdown-it plugin (`vscode.markdown-it.mermaid-extension`).
- **Gap**: `ChatPlanReviewPart` doesn't hook the code-block renderer, so mermaid doesn't render in plan reviews today.

### 2.5 Plan agent — writes to a virtual path
`extensions/copilot/src/extension/agents/vscode-node/planAgentProvider.ts`:
- The Plan custom agent researches → clarifies → writes the plan to **`/memories/session/plan.md` via the memory tool** (a virtual path resolved into workspace storage, not a user-visible workspace file), then shows the scannable plan in chat.
- Handoffs: **"Start Implementation"** (→ agent) and **"Open in Editor"** (→ untitled prompt file).
- **Gap**: plans aren't real workspace files → no explorer visibility, no viewer, no file-based live sync.

### 2.6 Agent-host plan reviews
- `src/vs/platform/agentHost/common/agentHostPlanReview.ts`: `IAgentHostPlanReview { title, content, actions, canProvideFeedback, answerQuestionId, planUri? }` — carried as `ChatInputRequestWithPlanReview`.
- Copilot SDK: `planReview` handler in `copilotAgentSession.ts` (~line 4960) builds the review from `data.summary`, and optionally a **`planPath` → `planUri` (real file)** when the SDK provides one.
- `stateToProgressAdapter.ts`: `createInputRequestPlanReview()` converts protocol → `ChatPlanReviewData` (line ~264) → rendered by `ChatPlanReviewPart`.

### 2.7 Agent-host TODO tools — display-only (THE GAP)
- Copilot SDK `update_todo`: writes to the SDK's SQLite store; **no workbench todo-list updates** (only telemetry at `copilotAgentSession.ts:4121`).
- Claude `TodoWrite` / `Task*`: rendered as generic tool-invocation rows.
- Only the **legacy Copilot CLI bridge** polls SQLite (`copilotcliSession.ts` ~line 1607) → `updateTodoListFromSqlItems` → live widget. Agent-host sessions don't feed `IChatTodoListService`.

### 2.8 Workbench-native editor template
`src/vs/workbench/contrib/chat/browser/agentPluginEditor/agentPluginEditor.ts` + `agentPluginEditorInput.ts`:
- `EditorPane` subclass (`AgentPluginEditor`) + `EditorInput` (`AgentPluginEditorInput`), registered via `IEditorPaneRegistry` in `chat.shared.contribution.ts` (~line 2250).
- **This is the exact pattern to copy for `PlanViewEditor`.**

### 2.9 Markdown editor already supports task checkboxes
`extensions/markdown-language-features/markdown-editor-src/editor.ts`:
- `@vscode/markdown-editor` has `taskCheckboxRange` + `onToggleCheckbox` (line ~205) — the built-in markdown editor already toggles `- [ ]` checkboxes interactively. Free editing fallback.

---

## 3. Gap analysis

| # | Gap | Impact |
|---|-----|--------|
| G1 | No dedicated Plan Viewer surface | "View Plan" goes to the plain markdown editor; no mermaid, no pinned TODO list |
| G2 | Agent-host todo calls are display-only | The live "what task is it working on now" tracking **does not work** for agent-host sessions (the default for Copilot SDK/Claude execution) |
| G3 | No plan file ↔ session binding | Viewer can't know which session's todos to track |
| G4 | Plans aren't real workspace files (Plan agent → memory path) | No explorer visibility, no file-based live sync, no diffability |
| G5 | Mermaid doesn't render in plan reviews | `ChatPlanReviewPart` uses plain renderer without code-block hook |
| G6 | No workbench-side markdown checklist parser | `parseTodoMarkdown` is extension-only |

---

## 4. Design: Plan Viewer architecture

### 4.1 Data model — bind plan file to session

```
PlanViewEditorInput
  ├─ planUri: URI                 (the *.plan.md file)
  ├─ sessionResource?: URI        (chat session whose todos drive the checklist)
  └─ title: string
```

New service: **`IPlanViewService`** (`src/vs/workbench/contrib/chat/common/planView/planViewService.ts`)
- `registerPlanReview(planUri, sessionResource)` — called by `ChatPlanReviewPart` when a plan review with a `planUri` is rendered (mirrors `IPlanReviewFeedbackService.registerPlanReview`).
- `getSessionResource(planUri)` — viewer asks "which session owns this plan?"
- `onDidRegister: Event<{ planUri, sessionResource }>` — lets an already-open viewer bind when the review appears.
- Persist planUri → sessionResource in the plan file itself via an HTML comment in frontmatter: `<!-- plan-session: <sessionResource> -->` so the binding survives restarts and works without the service (fallback).

### 4.2 The viewer — workbench-native editor pane

**New files:**
- `src/vs/workbench/contrib/chat/browser/planView/planViewEditor.ts` — `PlanViewEditor extends EditorPane`
- `src/vs/workbench/contrib/chat/browser/planView/planViewEditorInput.ts` — `PlanViewEditorInput extends EditorInput`
- `src/vs/workbench/contrib/chat/browser/planView/planViewMedia.css`
- `src/vs/workbench/contrib/chat/common/planView/planViewService.ts` — `IPlanViewService` (binding registry)
- `src/vs/workbench/contrib/chat/common/planView/planChecklist.ts` — workbench-side `parsePlanChecklist()` (port of `parseTodoMarkdown` conventions)

**Registration** (in `chat.shared.contribution.ts` alongside `AgentPluginEditor`):
```ts
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
    EditorPaneDescriptor.create(PlanViewEditor, PlanViewEditor.ID, nls.localize('planView', "Plan")),
    [new SyncDescriptor(PlanViewEditorInput)]
);
```

**Layout (three zones):**

```
┌─────────────────────────────────────────────────┐
│ Header:  [title]  [● planning|▶ in progress|✓ done]   │
│          [Edit in Markdown] [Refresh] [+ Add step]  │
├─────────────────────────────────────────────────┤
│ Markdown body (rendered via chat markdown       │
│ pipeline → mermaid diagrams render!)             │
│                                                 │
│ ## Steps ... ## Context ...                     │
├─────────────────────────────────────────────────┤
│ TODO checklist (pinned footer):                 │
│   ✓ 1. Set up tokens            (done)          │
│   ▶ 2. Build viewer             (in-progress)   │
│   ○ 3. Wire live updates        (not started)   │
│   + Add task                                   │
└─────────────────────────────────────────────────┘
```

### 4.3 Rendering

- **Markdown body**: reuse the chat markdown renderer path — render via `IMarkdownRendererService` **with** `codeBlockRendererSync` hooked to `IChatOutputRendererService.hasCodeBlockRenderer` (same as `ChatMarkdownContentPart`). This makes mermaid + other `chatOutputRenderers` render for free in the plan view.
- **Checklist footer**:
  - Parse the plan markdown's checklist section (the `- [ ]`/`- [x]`/`- [>]` items, ideally under a `## TODO`/`## Steps` heading) with the workbench parser.
  - Overlay live statuses from `IChatTodoListService.getTodos(sessionResource)` **matched by title** (the plan file is authored by the agent; the todo tool is the live state).
  - Render a `WorkbenchList<IChatTodo>` (copy the `TodoListRenderer`/delegate pattern from `ChatTodoListWidget`): green check = done, blue record = in-progress (with a subtle pulse/glow), gray circle = pending.
  - "Current task" = the single `in-progress` item; the header shows its title.

### 4.4 Live updates (the heart of the feature)

**Workbench-session plans** (Plan agent + `manage_todo_list`): **already live** — model → `manage_todo_list` → `chatTodoListService.setTodos` → `onDidUpdateTodos(sessionResource)` → viewer re-renders. Zero new plumbing.

**Agent-host sessions** (Copilot SDK `update_todo`, Claude `TodoWrite`) — **NEW bridge** (fixes G2):
- In `agentHostSessionHandler` / `stateToProgressAdapter`, when a completed tool call is:
  - `update_todo` (Copilot): parse `args.todos` (markdown checklist — same format `parseTodoMarkdown` handles) → `IChatTodo[]`.
  - `TodoWrite` (Claude): parse `args.todos` (array of `{ content/status }`) → `IChatTodo[]`.
- Then call `chatTodoListService.setTodos(sessionResource, todos)` directly (the session handler has both the sessionResource and the chat service).
- **Result**: the existing `ChatTodoListWidget` AND the new Plan Viewer both go live for agent-host sessions — with zero changes to the agent host itself (the state adapter already receives tool-call args).

**File-driven updates** (defense in depth, Cursor-style):
- The viewer also watches the plan file (`IFileService.createWatcher` — pattern already in `ChatPlanReviewPart`) and re-renders the body + re-parses the checklist on change.
- When todos change via the service, optionally write the statuses back into the file's checklist (toggle `- [ ]` → `- [x]`) so the file stays the source of truth. **Decision**: write-back enabled by default but only for items whose titles match (no structural edits).

### 4.5 Editing (add items / toggle checkboxes)

- **Checkbox toggle** in the footer → write `- [x]`/`- [ ]` to the plan file (via `ITextFileService`) AND push to `IChatTodoListService.setTodos` so the agent sees it.
- **"+ Add task"** → prompts for text → inserts `- [ ] <text>` at the end of the checklist section in the file → re-render.
- **"+ Add to list" / markdown body editing**: the body itself stays read-only in the viewer (rendered markdown); edits go through **"Edit in Markdown Editor"** (opens `override: MARKDOWN_EDITOR_ID` — which already has interactive task checkboxes via `@vscode/markdown-editor` and mermaid preview via markdown-it). This matches the user's ask ("add new items to the MD lists") with minimal new code: checkbox/add-task for the TODO list in the viewer; full markdown editing in the markdown editor, with the viewer live-updating from the file watcher.

### 4.6 Entry points

1. **"View Plan" button on `ChatPlanReviewPart`** (new button next to "Open Full Plan"): `editorService.openEditor({ resource: planUri, options: { override: PlanViewEditor.ID, pinned: true } })`.
2. **Command palette**: `workbench.action.chat.openPlan` (`ChatPlanViewContribution`), enabled when a plan review is active.
3. **Explorer**: plans under `Plans/` open in the viewer when the file name matches `*.plan.md` **and** the file is registered with `IPlanViewService` (to avoid hijacking every `*.plan.md`); otherwise fall back to the markdown editor.
4. **Plan agent handoff**: "Start Implementation" passes the plan file URI + session to the next agent (already `send: true` — extend the handoff prompt to reference the file path so the executing agent updates it).

### 4.7 Plan agent changes (G4)

- `planAgentProvider.ts`: change persistence from `/memories/session/plan.md` (virtual) to a **real workspace file**: `Plans/<slugified-title>_<timestamp>.plan.md` (Cursor-style naming), created via the extension's own file write (the agent already has no file tools by design — so the extension writes the file on the agent's behalf: the agent returns structured plan content in its response, and `PlanAgentProvider`/a small contribution writes `Plans/*.plan.md` and adds `<!-- plan-session: ... -->`).
- Keeps showing the scannable plan in chat; the "View Plan" button now opens the viewer.
- Fallback: keep writing the memory copy for existing behavior.

---

## 5. Phased implementation plan

### Phase 1 — Plan Viewer surface (G1, G5, G6)
Steps:
1. `planChecklist.ts` (common): port `parseTodoMarkdown` conventions to the workbench — `parsePlanChecklist(markdown): IChatTodo[]` + `extractChecklistSection(markdown)`; unit tests.
2. `planViewService.ts` (common): `IPlanViewService` registry (registerPlanReview / getSessionResource / onDidRegister); workbench singleton.
3. `planViewEditorInput.ts` + `planViewEditor.ts` (browser): EditorPane with header + markdown body (chat renderer with code-block hook → mermaid) + empty checklist footer; file watcher → re-render.
4. Register pane in `chat.shared.contribution.ts`; add CSS.
5. `ChatPlanReviewPart`: register planUri with `IPlanViewService`; add **"View Plan"** button → open `PlanViewEditorInput`; also hook `codeBlockRendererSync` in `renderMarkdown()` so mermaid renders inline in chat too (fix G5).
6. `ChatPlanViewContribution`: command `workbench.action.chat.openPlan` + menu items.
- **Verify**: open a plan review → "View Plan" → editor tab renders markdown + mermaid; file watcher re-renders on external edits.

### Phase 2 — Live todo bridge for agent-host sessions (G2)
Steps:
1. In `stateToProgressAdapter.ts`/`agentHostSessionHandler.ts`: detect completed tool calls `update_todo` (Copilot) / `TodoWrite` (Claude); extract args.
2. Map args → `IChatTodo[]` (reuse `parsePlanChecklist` for `update_todo`'s markdown; a small mapper for Claude's array shape).
3. `chatTodoListService.setTodos(sessionResource, todos)` from the session handler.
4. Unit tests: state adapter → todo conversion (mock tool-call args).
- **Verify**: run an agent-host session (Copilot SDK or Claude) with `update_todo`/`TodoWrite`; the input-area todo widget updates live (this also fixes the existing widget for agent-host sessions — a standalone win).

### Phase 3 — Viewer live tracking (the demo moment)
Steps:
1. `PlanViewEditor` binds session: on open, `planViewService.getSessionResource(planUri)` (fallback: parse `<!-- plan-session: -->` comment in the file).
2. Subscribe `chatTodoListService.onDidUpdateTodos(sessionResource)` → re-render checklist with **status overlay** (match by title) + **current-task highlight** in header/footer.
3. Write-back: on todo update, toggle matching `- [ ]`/`- [x]` in the file (guarded, title-matched only).
- **Verify**: plan + implement → watch the viewer tick items off live and highlight the active task.

### Phase 4 — Editing (add items)
Steps:
1. Checkbox toggle in footer → file edit + `setTodos`.
2. "+ Add task" → insert `- [ ] <text>` at end of checklist section → re-render + `setTodos`.
3. "Edit in Markdown Editor" button → open with `override: MARKDOWN_EDITOR_ID` (free interactive checkboxes + mermaid preview); viewer re-renders from file watcher.
- **Verify**: toggle/add items in viewer; confirm file changes; confirm agent sees them (via todo service).

### Phase 5 — Plan agent writes real files (G4)
Steps:
1. `planAgentProvider.ts`: on plan completion, the extension writes `Plans/<slug>.plan.md` (from the agent's returned plan content) + `<!-- plan-session: -->` comment; register with `IPlanViewService`.
2. Handoff "Start Implementation" references the plan file path (prompt tweak) so the executing agent updates the same checklist.
3. Explorer integration: `Plans/**/*.plan.md` → opens viewer when registered, else markdown editor.
- **Verify**: Plan agent → plan file appears in Explorer under `Plans/`; "View Plan" opens viewer; implementation agent's `manage_todo_list` calls light up the viewer live.

### Phase 6 — Polish & tests
- ARIA: checklist list roles, status announcements (use `IAccessibilityService`/announce "Task N completed" — accessibility skill: signals + verbosity).
- Icon for the editor + view badge when in-progress.
- Telemetry: open view, toggle, add-task (per telemetry instructions).
- Tests: `planChecklist.test.ts`, `planViewEditorInput` serialization, `planViewService` registry, state-adapter todo mapping, `ChatPlanReviewPart` button/mermaid.
- Memory note: `/memories/repo/plan-viewer.md` with architecture summary.

---

## 6. Key files & symbols reference

| File | Symbols to reuse |
|---|---|
| `widget/chatContentParts/chatPlanReviewPart.ts` | `ChatPlanReviewPart`, `renderMarkdown()`, file watcher, "Open Full Plan" button |
| `common/tools/chatTodoListService.ts` | `IChatTodoListService`, `onDidUpdateTodos`, `IChatTodo` |
| `common/tools/builtinTools/manageTodoListTool.ts` | `ManageTodoListTool` (the model-side writer) |
| `widget/chatContentParts/chatTodoListWidget.ts` | `ChatTodoListWidget`, `TodoListRenderer`, status icons |
| `widget/chatContentParts/chatMarkdownContentPart.ts` | `codeBlockRendererSync` → `IChatOutputRendererService` (mermaid hook) |
| `agentSessions/agentHost/stateToProgressAdapter.ts` | `createInputRequestPlanReview`, tool-call → progress conversion (todo bridge goes here) |
| `agentSessions/agentHost/agentHostSessionHandler.ts` | sessionResource ↔ progress orchestration (setTodos call site) |
| `browser/agentPluginEditor/*` | **Template**: EditorPane + EditorInput + registry registration |
| `platform/agentHost/common/agentHostPlanReview.ts` | `IAgentHostPlanReview`, `planUri` |
| `extensions/copilot/.../copilotCLITools.ts` | `parseTodoMarkdown`, `updateTodoListFromSqlItems` (conventions + bridge pattern) |
| `extensions/copilot/.../planAgentProvider.ts` | Plan agent → writes `Plans/*.plan.md` |
| `extensions/mermaid-markdown-features` | mermaid chat output renderer (already contributed) |

---

## 7. Open decisions (recommendations)

1. **Viewer surface: workbench-native EditorPane** (recommended) vs. extension custom editor. Rationale: direct access to chat services (todo, markdown, output renderer) without RPC; existing template (`AgentPluginEditor`); the fork IS the workbench. Cursor uses an extension custom editor only because it can't touch the workbench.
2. **Live todo source: `IChatTodoListService`** (recommended) as the live channel + file as the structural source. Matches "Copilot already has everything implemented" — we reuse the existing live pipeline instead of teaching agents to rewrite files (agent-host bridge in Phase 2 makes it universal).
3. **Checklist format: `- [ ]` / `- [x]` / `- [>]`** — already supported by `parseTodoMarkdown` and `@vscode/markdown-editor`; matches Cursor's convention.
4. **Plan file location: workspace `Plans/` folder** — explorer visibility, git-diffable, Cursor parity. Session binding via `IPlanViewService` + `<!-- plan-session: -->` comment in the file.
5. **Body editing: markdown editor escape hatch** (not in-view body editing) — the built-in markdown editor already has interactive checkboxes + mermaid preview; in-view editing is limited to checklist toggle/add. Matches the user's "add new items to the MD lists including the todo list" with ~10x less code.
6. **Write-back to file**: on by default, title-matched only, no structural edits (keeps the file clean while staying in sync).
