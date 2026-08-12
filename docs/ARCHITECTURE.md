# NikaCode Architecture: Versioning & the Update Pipeline

This document explains *how* NikaCode versioning and auto-updates work under the
hood. Read this first if you want to understand the moving parts before
building, releasing, or debugging updates.

---

## 1. Two versions: Nika version vs. VS Code base

NikaCode deliberately carries **two** version numbers:

| Where | Field | Example | Meaning |
| --- | --- | --- | --- |
| `product.json` | `productVersion` | `1.0.1` | **NikaCode's own version** — what users see and what we bump per release |
| `package.json` | `version` | `1.134.0` | The **upstream VS Code base** this fork is built on |

Rationale: NikaCode tracks upstream VS Code (which moves at its own cadence),
but the *product* ships on its own release schedule. Keeping the fork's version
independent lets a single installer carry e.g. Nika 1.0.1 **and** VS Code
1.134.0, and lets the About dialog and Welcome page show both.

### Where each version is surfaced

- **About dialog** (`src/vs/platform/dialogs/electron-browser/dialog.ts`):
  shows `NikaCode: <productVersion> (user setup)` plus `VS Code: <version>`.
- **Welcome page** (`src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts`):
  shows `Version <productVersion> · VS Code <version>` under the title.
- **Installer filename** (`build/win32/code.iss`): `NikaCodeSetup-<RawVersion>.exe`
  where `<RawVersion>` is the Nika `productVersion` (trailing quality suffix
  stripped, e.g. `1.0.1`).
- **Inno Setup AppVersion** (`code.iss`): the Nika version.

The `productVersion` field is declared in `src/vs/base/common/product.ts`
(`IProductConfiguration.productVersion?: string`) and exposed through
`IProductService`.

---

## 2. How `product.json` gets stamped at build time

`product.json` in the repo is a **template**. During `npm run gulp vscode-win32-x64`,
the packaging task (`build/gulpfile.vscode.ts` → `packageTask`) rewrites it with
build-specific fields:

- `commit` — the git commit SHA the build was produced from (`getVersion()`).
- `date` — build date (from the `writeISODate` task).
- `checksums` — content hashes of packaged files.
- `quality`, `target`, `updateUrl` — copied through from the repo `product.json`.

The **stamped** copy lives at:
`D:\Projects\david\VSCode-win32-x64\resources\app\product.json`
and is what the running app actually reads.

> This `commit` field is what the update client sends to the update feed — it's
> the "version" the server compares against the latest release.

---

## 3. The auto-update pipeline (end to end)

```
NikaCode client (every hour, and on "Check for Updates")
   │  GET https://nika-code-update.173david173.workers.dev/api/update/win32-x64-user/stable/<commit>
   ▼
Cloudflare Worker (build/update/src/index.js)
   │  GET https://api.github.com/repos/alive2/nika-code/releases/latest
   │  dereference tag ref → commit SHA
   │  find NikaCodeSetup-*.exe asset (+ its sha256 digest)
   ▼
   204 No Content                      OR                200 JSON manifest
   (client is up to date)                    { url, version, productVersion,
                                               timestamp, sha256hash }
```

### Client side (already wired, no code changes needed)

- `product.json` carries `updateUrl`, `quality: "stable"`, `target: "user"`.
- `src/vs/platform/update/electron-main/abstractUpdateService.ts` builds the URL
  `{updateUrl}/api/update/{platform}/{quality}/{commit}`.
- `updateService.win32.ts` uses platform `win32-x64-user` (because
  `target: "user"` and it's an Inno Setup install), checks every
  `60*60*1000` ms, downloads the setup exe to a temp path, verifies the
  **SHA-256** hash, then spawns the installer with
  `/verysilent /update=... /mergetasks=runcode,!desktopicon,!quicklaunchicon`.
- `build/win32/code.iss` already implements the Inno update protocol
  (background update detection, session-end/cancel files, `inno_updater.exe`
  garbage collection).
- The `update.mode` setting (default `default`) controls check behaviour;
  background updates can be disabled via `update.enableWindowsBackgroundUpdates`.

### Server side (the Cloudflare Worker)

- Endpoint: `GET /api/update/{platform}/{quality}/{commit}`.
- Sources the **latest GitHub release** of `alive2/nika-code`.
- Dereferences the release tag (`v1.0.1` → commit `7a1d01c7…`) so it can
  compare against the client's `commit`.
- Returns `204` when the client commit **equals** the latest tag commit;
  otherwise `200` with the manifest for `NikaCodeSetup-*.exe`.
- `sha256hash` is taken from the asset's GitHub `digest` (`sha256:` prefix
  stripped) — GitHub computes this automatically on upload.
- Results are cached for 5 minutes (Cloudflare Cache API) to stay within
  GitHub API rate limits.
- On any upstream error it returns `204` (stay quiet on background checks).
- See [AUTO-UPDATE.md](./AUTO-UPDATE.md) for full details and how to redeploy.

---

## 4. Why publishing a release *is* the update

There is **no separate "publish to the update server" step**. The worker reads
GitHub Releases at request time:

> Publish a release tagged `vX.Y.Z` → existing clients see it within the hour.

This keeps the pipeline simple and consistent: the release asset you attach to
GitHub is byte-for-byte the file users download through the updater.

### Important nuance: version vs. commit

The client identifies itself by **commit**, not by Nika version. The worker
compares the client's stamped commit against the latest tag's dereferenced
commit. So:

- A build whose stamped commit equals the latest tag → no update (204).
- A build whose stamped commit is older (any version) → update offered (200).

If you ever rebuild the *same* version tag (e.g. fix a packaging bug and
re-release `v1.0.1` at a new commit), the tag must be force-moved to the new
commit so existing clients detect it.

---

## 5. Relevant source files

| File | Role |
| --- | --- |
| `product.json` | Version, quality, target, updateUrl, branding |
| `package.json` | Upstream VS Code base version |
| `build/gulpfile.vscode.ts` | App packaging (stamps product.json, quality handling) |
| `build/gulpfile.vscode.win32.ts` | Windows setup build (Inno Setup) |
| `build/win32/code.iss` | Inno Setup script + update protocol |
| `build/update/src/index.js` | Cloudflare Worker (update manifest) |
| `build/update/wrangler.toml` | Worker config |
| `src/vs/base/common/product.ts` | `IProductConfiguration` (incl. `productVersion`) |
| `src/vs/platform/update/electron-main/abstractUpdateService.ts` | Client update polling |
| `src/vs/platform/update/electron-main/updateService.win32.ts` | Windows download/install logic |
| `src/vs/platform/dialogs/electron-browser/dialog.ts` | About dialog (both versions) |
| `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts` | Welcome page version line |
