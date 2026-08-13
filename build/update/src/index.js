/**
 * SeeCode update manifest endpoint (Cloudflare Worker)
 * ------------------------------------------------------------------
 * Implements the VS Code update protocol that the SeeCode client polls:
 *
 *   GET /api/update/{platform}/{quality}/{commit}
 *
 * The client (src/vs/platform/update/electron-main/abstractUpdateService.ts)
 * constructs this URL from product.json's `updateUrl` and calls it every hour
 * (or per `update.mode`). The server decides whether the caller is up to date:
 *
 *   - 204 No Content        -> caller is current, no update
 *   - 200 + JSON manifest   -> caller is outdated, return update info:
 *        {
 *          "url":            "<download URL of the setup exe>",
 *          "version":        "<commit the new build is based on>",
 *          "productVersion": "<product version like 1.0.1>",
 *          "timestamp":      <epoch milliseconds>,
 *          "sha256hash":     "<hex sha256 of the setup exe>"
 *        }
 *
 * The Windows client downloads `url`, verifies `sha256hash`, then launches the
 * setup exe with `/verysilent /update=...`; build/win32/code.iss already
 * implements the Inno update protocol (background updates, session-end, cancel).
 *
 * The manifest is derived from the latest GitHub release of the SeeCode repo,
 * so publishing a new release automatically makes it available as an update.
 * The GitHub lookup is cached (Cache API) to stay well under API rate limits.
 */

const DEFAULT_OWNER = 'Tetnd';
const DEFAULT_REPO = 'SeeCode';
const GITHUB_API = 'https://api.github.com';
const CACHE_TTL_SECONDS = 300; // 5 minutes

/**
 * GitHub fetch with optional token. The worker runs on shared Cloudflare egress
 * IPs which are aggressively rate-limited by GitHub's unauthenticated API, so a
 * `GITHUB_TOKEN` secret (set via `wrangler secret put GITHUB_TOKEN`) keeps the
 * manifest endpoint reliable.
 */
async function githubFetch(path, env) {
	const headers = {
		'Accept': 'application/vnd.github+json',
		'User-Agent': 'SeeCode-Update-Worker',
	};
	if (env.GITHUB_TOKEN) {
		headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
	}

	const res = await fetch(`${GITHUB_API}${path}`, { headers });
	if (!res.ok) {
		throw new Error(`GitHub API returned ${res.status}`);
	}

	return res.json();
}

/**
 * Cache a JSON payload keyed by an https URL. Cloudflare's Cache API requires
 * http(s) cache keys — a bare string like "github:release:..." throws in the
 * real runtime (which previously made every request fall into the catch and
 * return 204). Cache failures are swallowed so the request still falls back to
 * GitHub directly.
 */
async function cachedJson(cacheKey, loader) {
	const cache = caches.default;
	try {
		const cached = await cache.match(cacheKey);
		if (cached) {
			return cached.json();
		}
	} catch (err) {
		console.error('cache match error:', err.message);
	}

	const data = await loader();

	try {
		await cache.put(cacheKey, new Response(JSON.stringify(data), {
			headers: { 'Cache-Control': `s-maxage=${CACHE_TTL_SECONDS}` },
		}));
	} catch (err) {
		console.error('cache put error:', err.message);
	}

	return data;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// Only handle the update manifest path; everything else is 404.
		const match = url.pathname.match(/^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
		if (!match) {
			return new Response('Not found', { status: 404 });
		}

		const [, platform, quality, clientCommit] = match;
		const owner = env.GITHUB_OWNER || DEFAULT_OWNER;
		const repo = env.GITHUB_REPO || DEFAULT_REPO;
		const releaseCacheKey = `${GITHUB_API}/repos/${owner}/${repo}/releases/latest`;

		try {
			const release = await cachedJson(releaseCacheKey, () => githubFetch(`/repos/${owner}/${repo}/releases/latest`, env));
			const tagName = release.tag_name; // e.g. "v1.0.2"

			// Resolve the commit a release tag points to. `releases/latest` only
			// gives the branch name (`target_commitish`), not the commit the tag
			// is on, so we dereference the tag ref. Cached too (5 min) to keep
			// GitHub calls to a minimum.
			const tagRef = await cachedJson(
				`${GITHUB_API}/repos/${owner}/${repo}/git/ref/tags/${tagName}`,
				() => githubFetch(`/repos/${owner}/${repo}/git/ref/tags/${tagName}`, env)
			);
			const latestCommit = tagRef.object && tagRef.object.sha;

			// Caller is already on the latest release -> no update.
			if (latestCommit && clientCommit === latestCommit) {
				return new Response(null, { status: 204 });
			}

			// Find the Windows setup asset.
			const asset = (release.assets || []).find(a => /^SeeCodeSetup-.*\.exe$/.test(a.name));
			if (!asset) {
				return new Response(null, { status: 204 });
			}

			const sha256hash = (asset.digest || '').replace(/^sha256:/i, '');
			const productVersion = tagName.replace(/^v/, '');

			const update = {
				url: asset.browser_download_url,
				version: latestCommit || 'unknown',
				productVersion,
				// Milliseconds since epoch. The client (abstractUpdateService /
				// updateService.darwin.ts) expects Date.getTime()-style ms — sending
				// seconds made the UI render "Release date: Jan 21, 1970".
				timestamp: Date.parse(release.published_at),
				sha256hash,
			};

			return new Response(JSON.stringify(update), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (err) {
			// On any upstream failure, report "no update" so background checks
			// stay quiet; explicit checks surface an error via the UI.
			console.error('update manifest error:', err.message);
			return new Response(null, { status: 204 });
		}
	},
};
