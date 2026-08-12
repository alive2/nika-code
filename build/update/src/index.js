/**
 * NikaCode update manifest endpoint (Cloudflare Worker)
 * ------------------------------------------------------------------
 * Implements the VS Code update protocol that the NikaCode client polls:
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
 *          "timestamp":      <unix seconds>,
 *          "sha256hash":     "<hex sha256 of the setup exe>"
 *        }
 *
 * The Windows client downloads `url`, verifies `sha256hash`, then launches the
 * setup exe with `/verysilent /update=...`; build/win32/code.iss already
 * implements the Inno update protocol (background updates, session-end, cancel).
 *
 * The manifest is derived from the latest GitHub release of the NikaCode repo,
 * so publishing a new release automatically makes it available as an update.
 * The GitHub lookup is cached (Cache API) to stay well under API rate limits.
 */

const DEFAULT_OWNER = 'alive2';
const DEFAULT_REPO = 'nika-code';
const GITHUB_API = 'https://api.github.com';
const CACHE_TTL_SECONDS = 300; // 5 minutes

async function getLatestRelease(owner, repo) {
	const cacheKey = `github:release:${owner}/${repo}`;

	// Try the Cloudflare cache first to avoid hammering the GitHub API.
	const cache = caches.default;
	const cached = await cache.match(cacheKey);
	if (cached) {
		return cached.json();
	}

	const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/releases/latest`, {
		headers: {
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'NikaCode-Update-Worker',
		},
	});

	if (!res.ok) {
		throw new Error(`GitHub API returned ${res.status}`);
	}

	const release = await res.json();
	// Cache the parsed release payload.
	await cache.put(cacheKey, new Response(JSON.stringify(release), {
		headers: { 'Cache-Control': `s-maxage=${CACHE_TTL_SECONDS}` },
	}));

	return release;
}

/**
 * Resolves the commit a release tag points to. The `releases/latest` payload's
 * `target_commitish` is the branch name ("main"), not the commit the tag is on,
 * so we dereference the tag ref.
 */
async function getReleaseCommit(owner, repo, tagName) {
	const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/tags/${tagName}`, {
		headers: {
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'NikaCode-Update-Worker',
		},
	});

	if (!res.ok) {
		throw new Error(`GitHub tag deref returned ${res.status}`);
	}

	const ref = await res.json();
	return ref.object && ref.object.sha;
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

		try {
			const release = await getLatestRelease(owner, repo);
			const tagName = release.tag_name; // e.g. "v1.0.0"
			const latestCommit = await getReleaseCommit(owner, repo, tagName);

			// Caller is already on the latest release -> no update.
			if (latestCommit && clientCommit === latestCommit) {
				return new Response(null, { status: 204 });
			}

			// Find the Windows setup asset.
			const asset = (release.assets || []).find(a => /^NikaCodeSetup-.*\.exe$/.test(a.name));
			if (!asset) {
				return new Response(null, { status: 204 });
			}

			const sha256hash = (asset.digest || '').replace(/^sha256:/i, '');
			const productVersion = tagName.replace(/^v/, '');

			const update = {
				url: asset.browser_download_url,
				version: latestCommit || 'unknown',
				productVersion,
				timestamp: Math.floor(Date.parse(release.published_at) / 1000),
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
