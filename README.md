# NikaCode

<p align="center">
  <img alt="NikaCode" src="resources/nika/nika-icon.png" width="128">
</p>

**NikaCode** is a personal fork of [Visual Studio Code](https://code.visualstudio.com)
(`Code - OSS`, base `1.134.0`) with its own versioning, a built-in **BYOK chat
provider** (bring-your-own-key), and an **automatic update pipeline** that
delivers new versions straight to installed clients — just like VS Code's own
updater.

| | |
| --- | --- |
| Nika version | `1.3.3` (`product.json` → `productVersion`) |
| VS Code base | `1.134.0` (`package.json` → `version`) |
| Quality | `stable` (user install, Windows) |
| Releases | [github.com/alive2/nika-code/releases](https://github.com/alive2/nika-code/releases) |
| Update feed | `https://nika-code-update.173david173.workers.dev` (Cloudflare Worker) |
| Discord | [discord.gg/RdXzRzPVD9](https://discord.gg/RdXzRzPVD9) |
| License | [MIT](LICENSE.txt) |

---

## Why NikaCode?

NikaCode is a single-maintainer fork. It exists to bundle a few opinionated
things that upstream VS Code doesn't ship by default:

- **BYOK chat provider (`nika`)** — bring your own API key and use it from the
  built-in Copilot-style chat. Ships **DeepSeek V4 Flash** (default:
  `nika/deepseek-v4-flash-responses`) and **DeepSeek V4 Pro** via the
  OpenAI-compatible Responses API, with a stateless tool-call pairing fix so
  multi-turn tool use works reliably — including in agent-host sessions.
- **Local semantic indexing (`#codebase`)** — fully offline workspace indexing
  with on-device embeddings (BAAI `bge-small-en-v1.5` via onnxruntime), local
  vector search, an indexing scheme manager (`local` / `off` / `github-remote`),
  auto-refresh on workspace changes, and animated status-bar progress
  (`Nika Indexing X/Y`). The `semantic_search` tool is exposed to BYOK
  endpoints whenever a local index is available.
- **DeepSeek token usage tracking** — a persistent usage ledger (per day /
  session / workspace) with **peak & off-peak pricing** (cost math built in),
  a live status-bar item with a **PEAK/OFF-PEAK billing-period countdown**, and
  a full **Usage dashboard** inside Nika Settings: KPIs, an SVG tokens-per-day
  chart, and sessions / workspaces / requests tables. See
  [docs/TOKEN-USAGE.md](docs/TOKEN-USAGE.md).
- **Nika Settings** — a dedicated settings editor opened from the title bar
  button or the account menu, with provider setup guidance, model pickers, and
  the usage dashboard.
- **Agents window** — the agents-first UI layer (`src/vs/sessions`) alongside
  the classic workbench. Nika models are surfaced in agent-host sessions
  through the BYOK bridge, and a `sessions.list.showOnlyNikaAndCurrentWorkspace`
  setting filters both the Agents window and the Copilot Chat sessions view to
  Nika + current-workspace sessions.
- **Automatic updates** — a Cloudflare Worker serves the update manifest; the
  client polls it hourly and installs new `NikaCodeSetup-<version>.exe` builds
  in-place (Windows user install), with no manual "update server" to maintain.
- **A polished default experience** — Dark High Contrast default theme,
  Open VSX extension support with bundled Material Icons, PDF attachments
  preserved in BYOK chat, a first-run provider setup guide, and a version
  badge on the Welcome page.
- **A distinct identity** — separate app name, data folders (`.nika-code`),
  Windows mutexes, and branding so it can coexist with a regular VS Code
  install.

Everything else is stock VS Code — the editor, extensions, and ecosystem all
work as upstream.

---

## Installation

Grab the latest installer from the
[Releases page](https://github.com/alive2/nika-code/releases):

- **Windows**: `NikaCodeSetup-<version>.exe` (per-user Inno Setup install).

NikaCode updates itself automatically — publishing a new release is all it
takes to push an update to installed clients (see
[docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md)).

---

## Community

Join the **Nika Code Discord server**: [**discord.gg/RdXzRzPVD9**](https://discord.gg/RdXzRzPVD9)

It's the official community hub for everything NikaCode:

- **`#announcements`** — official announcements and release highlights
- **`#github-feed`** — every commit, PR, issue, and review mirrored automatically
- **`#releases`** — new releases and version notes
- **`#dev-chat`**, **`#code-review`**, **`#bug-reports`** — development discussion, review summaries, and bug reports (issues filed on GitHub land here automatically)
- **`#help`**, **`#showcase`**, **`#general`**, **`#off-topic`** — support, community showcases, and general chat

The server is moderated and runs on a strict-but-welcoming code of conduct:
treat others with respect, keep discussions on topic, and read `#rules` on
arrival. Development happens openly — every commit, pull request, and release
is mirrored to the server in real time.

---

## Documentation

The `docs/` folder is the reference for everything from building to shipping:

| Document | What it covers |
| --- | --- |
| [**CONTRIBUTING.md**](docs/CONTRIBUTING.md) | How to contribute (fork → PR → review workflow, branch protection rules) |
| [**ARCHITECTURE.md**](docs/ARCHITECTURE.md) | How versioning and the update pipeline fit together |
| [**DEPLOYMENT.md**](docs/DEPLOYMENT.md) | Building the app and the Windows installer from source |
| [**RELEASING.md**](docs/RELEASING.md) | Cutting and publishing a release |
| [**AUTO-UPDATE.md**](docs/AUTO-UPDATE.md) | How auto-updates work, the Cloudflare Worker, and how to verify updates |
| [**TOKEN-USAGE.md**](docs/TOKEN-USAGE.md) | How DeepSeek token usage & cost tracking works (pricing, ledger, dashboard) |
| [**SEMANTIC-INDEXING.md**](docs/SEMANTIC-INDEXING.md) | How `#codebase` indexing works vs. Cursor's indexing |
| [**CURSOR-INDEXING-REVERSE-ENGINEERING.md**](docs/CURSOR-INDEXING-REVERSE-ENGINEERING.md) | Raw reverse-engineering evidence for Cursor's indexing (protocol, encryption, crepe, endpoints) |
| [**VSCODE-CORE-VS-CURSOR-INDEXING.md**](docs/VSCODE-CORE-VS-CURSOR-INDEXING.md) | Deep comparison: how stock VS Code search/indexing works vs. Cursor's |
| [**INDEXING-DESIGN.md**](docs/INDEXING-DESIGN.md) | Design + implementation plan for scheme-selectable Nika semantic indexing (setting + progress in Nika's dashboard) |
| [**INDEXING-PLAN.md**](docs/INDEXING-PLAN.md) | Executable task breakdown (milestones, files, acceptance criteria, tests) for the indexing work |
| [**TROUBLESHOOTING.md**](docs/TROUBLESHOOTING.md) | Known build/release/update gotchas and their fixes |

---

## Building from source

NikaCode builds like upstream VS Code, but it is a **Windows-targeted fork**
(the installer and update pipeline are Windows-specific). See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full walkthrough. The short
version:

```powershell
# 1. Install dependencies (Electron 42.8.0, build-from-source for native modules)
npm install

# 2. Build the app
npm run gulp vscode-win32-x64

# 3. Build the update/installer tooling, then the setup
npm run gulp vscode-win32-x64-inno-updater
npm run gulp vscode-win32-x64-user-setup
```

> **Note on native modules:** the repo's `.npmrc` targets
> `runtime=electron`, `target=42.8.0`, `build_from_source=true`. If a native
> module is missing its compiled binary (e.g. no `.node` file under its
> `build/Release/`), rebuild it with `npm rebuild <module>` before packaging.
> See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## Contributing

NikaCode is a **single-maintainer** project with a strict contribution model:

- Only the repository owner can push directly to `main`.
- Everyone else contributes through **pull requests from a fork**, reviewed and
  merged by the owner (`main` is branch-protected with a required review).
- Dependabot and the upstream Microsoft CI workflows are disabled on this fork
  — they don't apply here.

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the full guide.

---

## License

Copyright (c) the NikaCode authors and Microsoft Corporation.

Licensed under the [MIT](LICENSE.txt) license.

NikaCode is a fork of [Visual Studio Code](https://github.com/microsoft/vscode)
(`Code - OSS`), also MIT-licensed.
