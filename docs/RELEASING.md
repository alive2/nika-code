# NikaCode — Releasing a New Version

This is the **most common operation**. Publishing a GitHub release is also what
triggers auto-updates for existing users (see
[AUTO-UPDATE.md](./AUTO-UPDATE.md)), so this is the complete checklist.

---

## 1. Decide the version

Bump `productVersion` in `product.json`:

| Change | Example |
| --- | --- |
| Bug fix / small change | `1.0.1` → `1.0.2` |
| New feature | `1.0.1` → `1.1.0` |
| Breaking | `1.0.1` → `2.0.0` |

Semver applies to the **Nika version**, not the VS Code base. The VS Code base
version (`package.json` → `version`) only changes when you merge new upstream
code and should **not** be bumped for a normal release.

```json
{
  "productVersion": "1.0.2"
}
```

> Also update `product.json`'s `updateUrl` if the worker URL ever changes (it
> currently points at `https://nika-code-update.173david173.workers.dev`).

---

## 2. Build

Run the full build chain from [DEPLOYMENT.md](./DEPLOYMENT.md):

```powershell
npm run gulp vscode-win32-x64
npm run gulp vscode-win32-x64-inno-updater
npm run gulp vscode-win32-x64-user-setup
```

**Output**: `.build\win32-x64\user-setup\NikaCodeSetup-<version>.exe`

> The build stamps `extensions/copilot/package.json` with `buildType: "prod"`
> (and reformats it). Revert it before committing:
> `git checkout -- extensions/copilot/package.json`. A subsequent dev build
> (`npm run compile` in `extensions/copilot`) restores `buildType: "dev"`.

Compute the SHA-256 (needed for release notes):

```powershell
Get-FileHash .build\win32-x64\user-setup\NikaCodeSetup-1.0.2.exe -Algorithm SHA256
```

### 2.5 Sign the build (optional but strongly recommended)

Unsigned installers are blocked by Windows **Smart App Control** / SmartScreen
("We blocked ... because we could not verify its publisher"). If you have a
signing certificate configured (see [Code signing](#code-signing)), sign the
app binaries and the installer before publishing:

```powershell
npm run sign-release
```

The script reads the backend and credentials from environment variables, signs
every `.exe`/`.dll`/`.node` in the built app plus the setup exe, and verifies
the installer signature. If no backend is configured it prints a notice and
exits 0, so the pipeline also works unsigned.

---

## 3. Commit & push

```powershell
git add product.json   # plus any code changes
git commit -m "Bump Nika version to 1.0.2"
git push origin main
```

> **Committing rules** (see `.github/instructions/committing.instructions.md`):
> never use `--no-verify`; let pre-commit/commit-msg hooks run; respect signing.

---

## 4. Tag

```powershell
git tag v1.0.2
git push origin v1.0.2
```

The tag name **must** be `v<productVersion>` (with the `v` prefix) — the update
worker strips the `v` to derive `productVersion` and dereferences the tag to a
commit for update comparisons.

> If you need to re-release the same version at a new commit (e.g. packaging
> fix), delete and re-create the tag, then **force-push** it:
> ```powershell
> git tag -d v1.0.2 && git push origin :v1.0.2
> git tag v1.0.2 && git push --force origin v1.0.2
> ```

---

## 5. Publish the release

Create release notes (see the template below), save to a temp file, then:

```powershell
gh release create v1.0.2 `
  ".build\win32-x64\user-setup\NikaCodeSetup-1.0.2.exe" `
  --repo alive2/nika-code `
  --latest `
  --title "NikaCode v1.0.2" `
  --notes-file .build\release-notes-v1.0.2.md
```

**Why `--repo alive2/nika-code`**: `gh` may otherwise try to resolve the tag
against the `upstream` remote (`microsoft/vscode`); always pass the explicit
`--repo` to target the fork. Mark it `--latest` so the worker's
`releases/latest` resolves to it.

---

## 6. Verify the release

```powershell
gh release list --repo alive2/nika-code --limit 3
# Expect: NikaCode v1.0.2  Latest  v1.0.2  ...

gh api repos/alive2/nika-code/releases/tags/v1.0.2 --jq '{tag: .tag_name, published: .published_at, assets: [.assets[] | {name, digest, browser_download_url}]}'
# Expect the setup exe asset with state=uploaded and a sha256 digest.

gh api repos/alive2/nika-code/git/ref/tags/v1.0.2 --jq '{type: .object.type, sha: .object.sha}'
# Expect type=commit and the sha of the commit you tagged.
```

Also confirm the worker picks it up:

```powershell
cd D:\Projects\david\NikaReimagined
node build/update/test-worker.mjs   # PASS checks; manifest should point at v1.0.2
```

---

## 7. Done — users update automatically

Existing installs (any version with `updateUrl` set, i.e. **v1.0.1 and later**)
will pick up the update within the hour, or immediately via
**Help → Check for Updates**. No further action needed.

> **Older installs (v1.0.0 and earlier)** have no `updateUrl` and will **not**
> auto-update. They must install the new release manually. See
> [AUTO-UPDATE.md](./AUTO-UPDATE.md#upgrade-path-for-pre-update-builds).

## Code signing

Signing gives Windows a publisher to verify, which stops Smart App Control and
SmartScreen from blocking `NikaCode.exe` and the installer on fresh installs.

### Option A — Traditional certificate (PFX) with signtool

1. Buy an **OV** or **EV** code-signing certificate (EV builds reputation
   faster). Export it as a `.pfx` file.
2. Install the Windows SDK (provides `signtool.exe`).
3. Set the environment variables and run the signing script:

```powershell
$env:NIKA_SIGN_PFX_PATH = 'C:\certs\nika-code.pfx'
$env:NIKA_SIGN_PFX_PASSWORD = '...'
# optional: sign with a cert already in the store instead of a PFX
# $env:NIKA_SIGN_PFX_THUMBPRINT = '<sha1>'
npm run sign-release
```

### Option B — Azure Trusted Signing

1. Create a **Trusted Signing** resource in the Azure portal, add a
   certificate profile, and complete identity validation.
2. Install the signing tool:

```powershell
dotnet tool install --global Microsoft.TrustedSigning.Client
```

3. Authenticate (`az login`, or set `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` /
   `AZURE_TENANT_ID` for a service principal) and set the resource details:

```powershell
$env:NIKA_ATS_ENDPOINT = 'https://<account>.codesigning.azure.net'
$env:NIKA_ATS_ACCOUNT = '<account>'
$env:NIKA_ATS_CERT = '<certificate-name>'
$env:NIKA_ATS_PROFILE = '<profile>'
npm run sign-release
```

### Notes

- Both backends use RFC 3161 timestamping (default server
  `http://timestamp.digicert.com`, override with `NIKA_SIGN_TIMESTAMP_URL`), so
  signatures stay valid after the certificate expires.
- Timestamps are embedded by the signing tool; the script also runs
  `signtool verify /pa` on the installer when signtool is available.
- Even with a valid signature, a brand-new certificate can still be blocked
  briefly by Smart App Control while it builds cloud reputation.
- The Inno `SignTool=esrp` definition in `build/win32/code.iss` is only used by
  Microsoft's CI (ESRP); this script signs locally after the build instead.

---

## Release notes template

```markdown
## NikaCode v1.0.2

One-line summary of this release.

### Versioning

| Component | Version |
|---|---|
| **NikaCode** | **1.0.2** |
| VS Code base | 1.134.0 |
| Upstream commit | `b8539477` |

### What's New

- Bullet list of user-visible changes.

### Install on Windows

Download and run **NikaCodeSetup-1.0.2.exe** below. It is a per-user Windows
x64 installer.

SHA-256: `<hash from step 2>`

> The installer is not code-signed yet, so Windows may display a SmartScreen
> warning. Download only from this official release page.
```

Get the upstream commit:

```powershell
git rev-parse upstream/main   # e.g. b85394774d09f3ff383404c08343ce116cc23ba7
```
