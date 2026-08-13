# NikaCode — Troubleshooting

Known issues and their fixes, gathered from real build/release/update work on
this fork. Organized by area.

---

## Build & packaging

### `EPERM` on `@github/copilot/sdk/prebuilds/win32-x64/runtime.node`

The copilot extension is being packaged while a running NikaCode instance holds
a lock on the native binary.

**Fix**:

```powershell
Get-Process NikaCode | Stop-Process -Force
```

Then re-run the build.

### `spawn signtool.exe ENOENT` during `patchWin32DependenciesTask`

Local OSS builds don't have the Windows SDK (and thus `signtool.exe`) on PATH.
This is **already fixed** in `build/gulpfile.vscode.ts`:
`hasAuthenticodeSignature()` treats a missing signtool (`ENOENT`) as "no
signature" and lets `rcedit` patch version info directly. The fix landed in
commit `3c1a6045`.

If you see this error, make sure you're building from a checkout that includes
`3c1a6045` (or later) — a stale `gulpfile` won't have the guard.

### Inno Setup: `No files found matching tools\*`

The `tools/` folder (with `inno_updater.exe` + `vcruntime140.dll`) wasn't
populated. Run the inno-updater task **before** the setup task:

```powershell
npm run gulp vscode-win32-x64-inno-updater
npm run gulp vscode-win32-x64-user-setup
```

### `lstat ... shims.txt ENOENT` or "Copilot SDK directory not found"

The copilot packaging race: the dependency glob ran concurrently with the
esbuild postinstall (which `rm`s + recreates `@github/copilot/sdk` and deletes
transient `shims.txt`). **Fixed** in `build/lib/extensions.ts` (`3c1a6045`) with
a `dependenciesGate` that starts the glob only after the local esbuild stream
emits. If it recurs, verify you're on that commit or later.

> `.moduleignore` intentionally strips
> `@github/copilot/{prebuilds,clipboard,ripgrep,pvrecorder,foundry-local-sdk}/**`
> and `sdk/index.js` — that's expected, **not** a bug. After a clean
> compile-copilot-extension-build, `sdk/` should have ~35 files (source has 37).

### `quality: "stable"` causes AppX packaging failures

`product.json` uses `quality: "stable"` (needed for the update protocol). The
upstream build would try to package AppX files (`.build/win32/appx/**`,
`resources/win32/appx/AppxManifest.xml`) and reference `win32ContextMenu`.

**Fixed** in `build/gulpfile.vscode.ts` and `build/gulpfile.vscode.win32.ts`
(`ed2bacb7`): both AppX blocks are now gated on the product defining a
`win32ContextMenu` (which this fork doesn't). This keeps `#ifdef AppxPackageName`
in `code.iss` inactive.

### `.esbuild.mts` complains about missing `VSCODE_QUALITY`

The copilot extension's esbuild config requires `VSCODE_QUALITY`. It's normally
inherited from `product.json`'s `quality` during the gulp build; if you run
esbuild directly, set it explicitly (e.g. `stable`).

### Build is slow / "stuck" for minutes

The full `vscode-win32-x64` build is intentionally from-scratch and takes
~8–10 min (copilot esbuild ~1.5 min, bundle ~1 min, package ~4 min), plus
~5 min for the Inno setup step. That's normal, not a hang.

---

## Release & GitHub

### `gh release create` fails with "tag exists locally but has not been pushed to microsoft/vscode"

`gh` resolved the repo to the `upstream` remote (`microsoft/vscode`). Always
pass `--repo alive2/nika-code`:

```powershell
gh release create v1.0.1 ".build\win32-x64\user-setup\NikaCodeSetup-1.0.1.exe" --repo alive2/nika-code --latest --title "NikaCode v1.0.1" --notes-file <notes>
```

### Update not offered even though a new release exists

The worker compares the **client's stamped commit** against the **tag's commit**.
If you rebuilt the app at a new commit but didn't move the tag, clients whose
commit equals the tag commit get `204`.

- If the release tag points at the same commit the client is built from → no
  update (correct).
- To re-release the same version at a new commit, force-move the tag and
  force-push it (see [RELEASING.md](./RELEASING.md#4-tag)).

---

## Auto-update / Cloudflare

### Worker is deployed, but curl/browser cannot reach it

The dev sandbox **blocks all `*.workers.dev` domains at the TLS layer**
(`ERR_SSL_VERSION_OR_CIPHER_MISMATCH` / `SEC_E_ILLEGAL_MESSAGE`), while
`api.cloudflare.com` and `github.com` work fine. This is environmental.

**Workarounds**:
- Verify the worker logic locally (hits the real GitHub API):
  `node build/update/test-worker.mjs`
- Verify the worker is live via the Cloudflare **dashboard** (Deployments tab).
- Do live `curl` checks from a real machine.

### `wrangler deploy` fails: "You need to register a workers.dev subdomain"

The account had no `workers.dev` subdomain registered. For this account the
subdomain is `173david173` (registered). If it ever shows again, register it in
the dashboard (`Workers` → onboarding) — the `wrangler subdomain` CLI command
was removed in modern wrangler versions.

### `wrangler subdomain <name>` → "Unknown arguments: subdomain"

Removed command. Manage the subdomain in the Cloudflare dashboard instead.

### Worker returns 204 even for stale clients

The worker fails **silent** (returns 204) on any upstream error — GitHub down,
rate limited, or the repo/release missing. Check:
- `gh api repos/alive2/nika-code/releases/latest` works from the CLI.
- The latest release has a `NikaCodeSetup-*.exe` asset with `state: uploaded`.
- Worker logs in the Cloudflare dashboard (Observability).

### "Hash mismatch" during an in-app update

The client SHA-256-verifies the downloaded installer. If the GitHub asset was
replaced/re-uploaded after the release, the `digest` the worker serves changes
and no longer matches. Re-publish cleanly (delete + re-upload the asset, or a
fresh release) so the digest matches the served manifest.

### Client never checks for updates

`src/vs/platform/update/electron-main/abstractUpdateService.ts` disables
updates permanently when `product.json` lacks `updateUrl` **or** `commit`.
Both are required:
- `updateUrl` — present in repo `product.json` (v1.0.1+).
- `commit` — stamped at build time (not in the repo file; verify in the *built*
  `resources/app/product.json`).

Also check the `update.mode` setting isn't `none`, and that
`update.enableWindowsBackgroundUpdates` isn't disabled.

---

## Environment / misc

### Where is the OAuth token for Cloudflare stored?

`%APPDATA%\xdg.config\.wrangler\config\default.toml` (used by `wrangler login`).
It's a personal OAuth token — do **not** commit or share it. For CI use a
scoped `CLOUDFLARE_API_TOKEN` secret instead.

### `npm run gulp` output is noisy / encoded oddly in PowerShell

The gulp logger emits ANSI escapes; in PowerShell redirect to a log and tail it:

```powershell
npm run gulp vscode-win32-x64 *> .build\vscode-win32-x64-build.log
Get-Content .build\vscode-win32-x64-build.log -Tail 10
```

### Keyboard shortcuts don't work (Ctrl+B / Ctrl+Shift+P / Ctrl+J do nothing, F1 works)

Symptom: most shortcuts are dead, but non-letter keys like `F1` still work.
The main-process log shows:

```
Error: Cannot find module './build/Debug/keymapping'
    at ... node_modules\native-keymap\index.js
TypeError: Cannot read properties of null (reading 'getCurrentKeyboardLayout')
```

Root cause: `node_modules/native-keymap` has no compiled binary (only
`build/config.gypi` + `.vcxproj` — the build never produced
`build/Release/keymapping.node`). The Windows keyboard mapper then drops every
letter-key default keybinding (letters are not "immutable" key codes), so
`ctrl+B`, `ctrl+shift+p`, … resolve to nothing while `f1` survives.

**Fix** (rebuild the module for the fork's Electron, which the repo `.npmrc`
already targets — `runtime=electron`, `target=42.8.0`):

```powershell
npm rebuild native-keymap
# verify: node_modules\native-keymap\build\Release\keymapping.node exists
```

Then fully restart NikaCode (the module loads in the main process). Run
`npm run postinstall` if other native modules are also missing binaries.

---

## Quick links

- [DEPLOYMENT.md](./DEPLOYMENT.md) — build steps
- [RELEASING.md](./RELEASING.md) — release checklist
- [AUTO-UPDATE.md](./AUTO-UPDATE.md) — update system + testing
- [ARCHITECTURE.md](./ARCHITECTURE.md) — background
