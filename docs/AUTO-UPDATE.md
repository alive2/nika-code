# NikaCode — Auto-Update System

NikaCode self-updates exactly like VS Code: the client polls an update feed
every hour, the feed returns a JSON manifest pointing at the latest setup
installer, and the client downloads, SHA-256-verifies, and silently installs it.

This document is the operational reference for the update system: how it works,
how to deploy/maintain the Cloudflare Worker, how to test, and how to handle the
upgrade path for old builds.

---

## 1. How it works

```
NikaCode client (win32-x64-user / stable / <commit>)
        │  GET /api/update/win32-x64-user/stable/<commit>   (hourly + on demand)
        ▼
Cloudflare Worker  nika-code-update.173david173.workers.dev
        │  GET https://api.github.com/repos/alive2/nika-code/releases/latest
        │  dereference tag ref → commit SHA
        │  find NikaCodeSetup-*.exe asset + its sha256 digest
        ▼
  204 (up to date)  OR  200 {url, version, productVersion, timestamp, sha256hash}
```

| Behavior | Response |
| --- | --- |
| Client commit == latest release tag commit | `204 No Content` |
| Client commit < latest release tag commit | `200` + JSON manifest |
| Bad path | `404` |
| Upstream error (GitHub down, rate limit, etc.) | `204` (silent) |

Manifest fields (client contract from `src/vs/platform/update/common/update.ts`):

```json
{
  "url":            "https://github.com/alive2/nika-code/releases/download/v1.0.1/NikaCodeSetup-1.0.1.exe",
  "version":        "7a1d01c7aab17502a5c7e99050f9d811c15830cd",
  "productVersion": "1.0.1",
  "timestamp":      1786532019,
  "sha256hash":     "dccb350f7e4c991923bf663cf4866be4c67dcad55f0b46a7ca87d3410af8c8d7"
}
```

---

## 2. Components

| File | Purpose |
| --- | --- |
| `build/update/src/index.js` | The Cloudflare Worker (update manifest logic) |
| `build/update/wrangler.toml` | Worker config (`name`, `main`, `compatibility_date`) |
| `build/update/test-worker.mjs` | Local verification harness (mocks `caches.default`, hits the real GitHub API) |
| `.github/workflows/deploy-update-worker.yml` | CI auto-deploy via `cloudflare/wrangler-action` — **currently disabled** (see §4) |
| `product.json` | `updateUrl`, `quality: "stable"`, `target: "user"` |
| `build/win32/code.iss` | Inno Setup update protocol (already implemented) |

---

## 3. The worker, in detail

**Endpoint**: `GET /api/update/{platform}/{quality}/{commit}`

The `platform` is `win32-x64-user` (target `user` + Inno install). The worker
doesn't actually branch on platform/quality — it always serves the single
Windows user-setup we publish — but it keeps the URL shape identical to real
VS Code so the client logic is untouched.

**Source of truth**: GitHub Releases (`alive2/nika-code`).

1. `GET /repos/{owner}/{repo}/releases/latest` → latest release (`tag_name`,
   `assets[]`).
2. `GET /repos/{owner}/{repo}/git/ref/tags/{tag_name}` → dereference to the
   commit SHA (important: `releases/latest` only gives the *branch* commit, not
   the tag commit).
3. Find the asset matching `/^NikaCodeSetup-.*\.exe$/`.
4. `sha256hash = asset.digest.replace(/^sha256:/, '')` — GitHub computes the
   SHA-256 digest automatically when an asset is uploaded, so the manifest hash
   always matches the file.
5. `productVersion = tag_name.replace(/^v/, '')`.

**Caching**: the release payload is cached for 5 minutes via the Cloudflare
Cache API (`caches.default`) to stay within GitHub API rate limits.

**Env overrides** (in `wrangler.toml`): `GITHUB_OWNER`, `GITHUB_REPO` (defaults
`alive2` / `nika-code`).

---

## 4. Deploying / updating the worker

One-time setup:

```powershell
cd D:\Projects\david\NikaReimagined\build\update
npx wrangler login      # opens browser; OAuth token stored in
                        # %APPDATA%\xdg.config\.wrangler\config\default.toml
```

Deploy:

```powershell
npx wrangler deploy
# → https://nika-code-update.173david173.workers.dev
```

Notes:

- The account's `workers.dev` subdomain is `173david173` (this is why the URL
  is `nika-code-update.173david173.workers.dev`). The `subdomain` CLI command
  was removed in modern wrangler — manage it in the dashboard.
- Check deployment status:
  `npx wrangler deployments list`
- **CI auto-deploy is disabled.** The GitHub Actions workflow
  (`.github/workflows/deploy-update-worker.yml`) is kept on disk but has no
  trigger, because the repo has no `CLOUDFLARE_API_TOKEN` secret configured
  (without it, the job failed with "In a non-interactive environment, it's
  necessary to set a CLOUDFLARE_API_TOKEN..."). Deployment is **manual**:
  `cd build/update && npx wrangler deploy` after any change to
  `build/update/**`.
  To re-enable auto-deploy: add a `CLOUDFLARE_API_TOKEN` secret (Workers
  Scripts *Edit* permission) via the repo's Actions secrets settings or
  `gh secret set CLOUDFLARE_API_TOKEN`, then restore the `on:` block in
  `.github/workflows/deploy-update-worker.yml`.

---

## 5. Testing

### Local protocol test (no worker deployed, uses real GitHub API)

```powershell
cd D:\Projects\david\NikaReimagined
node build/update/test-worker.mjs
```

Expected output (against the current latest release):

```
PASS  up-to-date commit -> 204  (status=204)
PASS  stale commit -> manifest  (status=200)
PASS  bad path -> 404  (status=404)
PASS  old v1.0.0 commit -> update available  (status=200)
```

The "old commit → 200" check proves the worker would offer an update to a
client on an older build.

### Live worker test (from a machine that can reach *.workers.dev)

```powershell
# Up to date → 204
curl -i "https://nika-code-update.173david173.workers.dev/api/update/win32-x64-user/stable/<latest-commit>"

# Stale → 200 + manifest
curl "https://nika-code-update.173david173.workers.dev/api/update/win32-x64-user/stable/<old-commit>"
```

### In-app

- **Help → Check for Updates** triggers an immediate explicit check.
- Background checks happen hourly.
- The update downloads, verifies SHA-256, then silently installs; the app
  restarts with the new version.

> **Note**: the dev sandbox blocks `*.workers.dev` at the TLS layer, so
> `curl`/browser tests fail there with `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`.
> That's environmental — verify from a real machine. See
> [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## 6. Shipping an update (TL;DR)

Already covered in [RELEASING.md](./RELEASING.md) — but the update-specific
summary is:

1. Bump `productVersion` in `product.json`.
2. Build app + inno-updater + user-setup (see [DEPLOYMENT.md](./DEPLOYMENT.md)).
3. `git tag v<productVersion>` and push.
4. `gh release create v<productVersion> <setup>.exe --repo alive2/nika-code --latest ...`
5. Done — the worker serves it automatically.

---

## 7. Upgrade path for pre-update builds

- **v1.0.1+**: auto-update enabled (have `updateUrl`). They will update
  automatically.
- **v1.0.0 and earlier**: no `updateUrl`, so the client disables updates
  (`MissingConfiguration`). These users must manually download the latest
  installer from the releases page and run it. The Inno installer upgrades in
  place over an existing install (same AppId).

---

## 8. Troubleshooting quick hits

| Symptom | Likely cause / fix |
| --- | --- |
| No update appears after release | Client commit may equal tag commit (rebuilt same tag). Force-move the tag or wait; check `node build/update/test-worker.mjs` |
| Worker returns 204 always | GitHub rate limit / upstream error — worker fails silent by design. Wait or check worker logs in the dashboard |
| `wrangler deploy` fails "register a workers.dev subdomain" | Account subdomain missing — register in dashboard (this account already has `173david173`) |
| "Hash mismatch" during update | Installer asset replaced on GitHub after release (digest changed). Re-publish cleanly |
| Client never checks | Confirm `product.json` has `updateUrl` + `commit` (build-time stamped). `update.mode` set to `none`? |

---

## 9. Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the update pipeline fits together
- [RELEASING.md](./RELEASING.md) — the release checklist
- [DEPLOYMENT.md](./DEPLOYMENT.md) — building the app/installer
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — gotchas
