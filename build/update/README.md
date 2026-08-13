# SeeCode Auto-Update Infrastructure

SeeCode self-updates exactly like VS Code: the client polls an update feed
URL every hour, the feed returns a JSON manifest pointing at the latest setup
installer, and the client downloads, SHA-256-verifies, and silently installs it
via the Inno Setup update protocol (`build/win32/code.iss` already implements
this).

## How it works

```
SeeCode client (win32-x64-user / stable / <commit>)
        │  GET /api/update/win32-x64-user/stable/<commit>   (hourly)
        ▼
Cloudflare Worker  seecode-update.173david173.workers.dev
        │  fetches https://api.github.com/repos/Tetnd/SeeCode/releases/latest
        │  dereferences the tag to a commit, finds SeeCodeSetup-*.exe
        ▼
  204 (up to date)  OR  200 {url, version, productVersion, timestamp, sha256hash}
```

Publishing a new GitHub release automatically makes it available as an update —
no worker changes needed.

## Components

| File | Purpose |
| --- | --- |
| `src/index.js` | Cloudflare Worker implementing the update manifest protocol |
| `wrangler.toml` | Worker config (`name`, `main`, `compatibility_date`) |
| `test-worker.mjs` | Local verification harness (mocks `caches.default`, hits real GitHub API) |
| `.github/workflows/deploy-update-worker.yml` | Optional CI deploy via `cloudflare/wrangler-action` |

## Deploying the worker

```sh
npx wrangler login        # one-time browser auth
cd build/update
npx wrangler deploy
```

The worker URL is already wired into `product.json` -> `"updateUrl"`.

## Shipping an update

1. Bump `productVersion` in `product.json` (e.g. `1.0.1`).
2. Build the app + user setup installer:
   ```sh
   npm run gulp vscode-win32-x64
   npm run gulp vscode-win32-x64-inno-updater
   npm run gulp vscode-win32-x64-user-setup
   ```
3. Publish a GitHub release tagged `v1.0.1` (use `gh release create`) with the
   new `SeeCodeSetup-1.0.1.exe` asset.
4. Existing installs will detect the update within the hour (or immediately
   via **Help → Check for Updates**).

## Testing

```sh
# Local protocol checks against the real GitHub API:
cd build/update && node test-worker.mjs

# Live worker (from a machine that can reach *.workers.dev):
curl "https://seecode-update.173david173.workers.dev/api/update/win32-x64-user/stable/<old-commit>"
#   -> 200 + manifest JSON
curl "https://seecode-update.173david173.workers.dev/api/update/win32-x64-user/stable/<latest-commit>"
#   -> 204 (up to date)
```

## Notes

- The GitHub lookup is cached for 5 minutes via the Cloudflare Cache API to
  stay within GitHub API rate limits.
- On any upstream error the worker returns `204`, so background update checks
  stay silent; manual checks surface the error in the UI.
- Environment variables `GITHUB_OWNER` / `GITHUB_REPO` (see `wrangler.toml`)
  override the default repo `Tetnd/SeeCode`.
