# NikaCode — Deployment, Versioning & Auto-Update Documentation

NikaCode is a fork of Visual Studio Code with its own **Nika version** (e.g.
`1.0.1`), a custom BYOK chat provider, and **automatic updates** that work just
like VS Code's own updater.

This folder is the reference for everyone who needs to build, ship, or update
NikaCode. Read the docs in this order:

| Document | What it covers |
| --- | --- |
| [**CONTRIBUTING.md**](./CONTRIBUTING.md) | How to contribute (fork → PR → review workflow, branch protection rules) |
| [**ARCHITECTURE.md**](./ARCHITECTURE.md) | How versioning and the update pipeline fit together (background knowledge) |
| [**DEPLOYMENT.md**](./DEPLOYMENT.md) | Building the app and the Windows installer from source |
| [**RELEASING.md**](./RELEASING.md) | Cutting and publishing a release (the thing you do most often) |
| [**AUTO-UPDATE.md**](./AUTO-UPDATE.md) | How auto-updates work, the Cloudflare Worker, and how to test/verify updates |
| [**TROUBLESHOOTING.md**](./TROUBLESHOOTING.md) | Known build/release/update gotchas and their fixes |

## Quick reference

| Thing | Value |
| --- | --- |
| Repo | `https://github.com/alive2/nika-code.git` (`origin`, authed as `alive2`) |
| Upstream | `https://github.com/microsoft/vscode.git` (`upstream`) |
| Current Nika version | `1.0.1` (`product.json` → `productVersion`) |
| VS Code base version | `1.134.0` (`package.json` → `version`, stamped from `upstream/main`) |
| Update feed worker | `https://nika-code-update.173david173.workers.dev` |
| Windows installer | `NikaCodeSetup-<version>.exe` (per-user x64 Inno Setup) |
| Latest release | `https://github.com/alive2/nika-code/releases` |
| App output dir | `D:\Projects\david\VSCode-win32-x64\` (dev machine) |
| Setup output dir | `.build\win32-x64\user-setup\` |

## The 30-second version

1. **To ship a new version**: bump `productVersion` in `product.json` → build →
   publish a GitHub release tagged `vX.Y.Z` with the installer attached.
2. **Users update automatically**: NikaCode polls the Cloudflare Worker hourly;
   the worker reads the latest GitHub release and serves the update manifest.
3. **No manual update-server work needed** — publishing a release is what makes
   the update appear. See [RELEASING.md](./RELEASING.md).

> **Note about the sandbox/dev environment**: this repo is often worked on from
> an environment whose network stack cannot reach `*.workers.dev` (TLS is
> blocked). This does **not** affect real user machines. See
> [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#worker-is-deployed-but-curlbrowser-cannot-reach-it).
