# NikaCode — Building & Deploying from Source

This guide walks through building the NikaCode app and its Windows installer on
the dev machine. The build is the standard VS Code `gulp` pipeline with a few
fork-specific fixes; the full app build takes roughly **8–10 minutes**, and the
Inno Setup packaging a further **~5 minutes**.

> **Prerequisites**: Node.js + npm installed, `node_modules` present
> (`npm install` at the repo root), git remote `origin` pointing at
> `alive2/nika-code`.

---

## 1. Build the app (win32-x64)

```powershell
cd D:\Projects\david\NikaReimagined
npm run gulp vscode-win32-x64
```

What this does (task chain):

```
copyCodiconsTask
→ cleanExtensionsBuildTask
→ compileNonNativeExtensionsBuildTask
→ compileCopilotExtensionBuildTask   (bundles extensions/copilot, incl. postinstall)
→ compileExtensionMediaBuildTask
→ writeISODate
→ esbuildBundleTask                  (bundles the workbench core)
→ vscode-win32-x64-ci
     ├─ packageTask                  (writes app files + stamps product.json)
     ├─ prepareCopilotRipgrepShimTask
     └─ patchWin32DependenciesTask   (rcedit native modules; handles missing signtool)
```

**Output**: `D:\Projects\david\VSCode-win32-x64\` — the runnable app. The
stamped product config is at
`D:\Projects\david\VSCode-win32-x64\resources\app\product.json`.

### Verify the build

```powershell
Get-Content "D:\Projects\david\VSCode-win32-x64\resources\app\product.json" | Select-Object -First 12
```

Expect: `productVersion`, `quality: "stable"`, `target: "user"`,
`updateUrl: "https://nika-code-update.173david173.workers.dev"`, plus a
`commit` and `date` that the build stamped.

---

## 2. Populate the `tools/` folder (inno_updater)

The installer needs `tools\inno_updater.exe` + `vcruntime140.dll` inside the
app directory. Build it **before** the setup step:

```powershell
npm run gulp vscode-win32-x64-inno-updater
```

**Output**: `D:\Projects\david\VSCode-win32-x64\tools\` containing
`inno_updater.exe` and `vcruntime140.dll`.

> If you skip this, Inno Setup fails with
> `No files found matching tools\*`. The `vscode-win32-x64` task does **not**
> populate `tools/` — the inno-updater task is separate by design.

---

## 3. Build the Windows user setup installer

```powershell
npm run gulp vscode-win32-x64-user-setup
```

- Runs Inno Setup (`node_modules/innosetup/bin/ISCC.exe`) with
  `build/win32/code.iss`.
- Reads the Nika `productVersion` and embeds it in the filename:
  `NikaCodeSetup-<RawVersion>.exe` (e.g. `NikaCodeSetup-1.0.1.exe`).
- Per-user x64 installer (`target: "user"`), supports the update protocol.

**Output**: `.build\win32-x64\user-setup\NikaCodeSetup-<version>.exe`

### Verify

```powershell
Get-FileHash .build\win32-x64\user-setup\NikaCodeSetup-1.0.1.exe -Algorithm SHA256
Get-Item  .build\win32-x64\user-setup\NikaCodeSetup-1.0.1.exe | Select-Object Name, Length, LastWriteTime
```

Record the SHA-256 — you'll put it in the release notes.

---

## 4. Run the built app (optional)

```powershell
# From the build output directory
D:\Projects\david\VSCode-win32-x64\NikaCode.exe
```

Or install the setup exe to test the real install/update experience.

---

## 5. Environment variables & build flags

| Variable / flag | Effect |
| --- | --- |
| `VSCODE_QUALITY` | Required by `extensions/copilot/.esbuild.mts` (e.g. `stable`). The `quality` in `product.json` drives version suffixing and AppX gating; set consistently. |
| `--debug-inno` | Pass to the setup task to keep Inno Setup temp output for debugging. |
| `--sign` | Enable the Inno signing step (requires a signing setup; normally skipped locally). |

---

## 6. Rebuilding after a source change

- **Core/workbench TS changes** (`src/vs/**`): the `vscode-win32-x64` task
  recompiles via esbuild — just re-run it.
- **Built-in extension changes** (`extensions/**`): after editing an
  extension's source, run `npm run compile` inside that extension folder first
  (e.g. `cd extensions/copilot && npm run compile`), then re-run the gulp task.
- **`product.json` changes** (version, updateUrl, quality): only require
  re-running `vscode-win32-x64` (and the setup steps) — no TS recompile needed.

---

## 7. Full release build (summary)

```powershell
# 1. App
npm run gulp vscode-win32-x64
# 2. tools/ folder
npm run gulp vscode-win32-x64-inno-updater
# 3. Installer
npm run gulp vscode-win32-x64-user-setup
```

Then follow [RELEASING.md](./RELEASING.md) to tag and publish.
