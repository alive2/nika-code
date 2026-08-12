// Local verification harness for the NikaCode update worker.
// Mocks the Cloudflare Cache API and the GitHub API so every check is
// deterministic and offline-safe; run with LIVE=1 to additionally smoke-test
// against the real (rate-limited, unauthenticated) GitHub API.
//
// Usage:
//   node test-worker.mjs          # deterministic mock tests (default)
//   LIVE=1 node test-worker.mjs   # also exercise the live GitHub API

// ---------------------------------------------------------------------------
// Cloudflare Cache API mock. Mirrors the real runtime's constraints:
//   - cache keys may be Request objects or http(s) URL strings
//   - non-http(s) keys THROW (this was the original production bug that made
//     every request silently return 204)
//   - match() returns a fresh clone per hit
// ---------------------------------------------------------------------------
const cacheStore = new Map();
function normalizeCacheKey(key) {
	const url = key instanceof Request ? key.url : String(key);
	if (!/^https?:\/\//.test(url)) {
		throw new TypeError(`Invalid cache key: ${key} (Cache API requires an http(s) URL)`);
	}
	return url;
}
globalThis.caches = {
	default: {
		async match(key) {
			const url = normalizeCacheKey(key);
			const entry = cacheStore.get(url);
			return entry ? entry.clone() : undefined;
		},
		async put(key, response) {
			const url = normalizeCacheKey(key);
			cacheStore.set(url, new Response(await response.clone().text(), { headers: response.headers }));
		},
	},
};

// ---------------------------------------------------------------------------
// GitHub API mock. Lets us test cache hits, token headers and failure
// behavior without depending on live unauthenticated API calls (the exact
// thing the GITHUB_TOKEN support exists to avoid).
// ---------------------------------------------------------------------------
const GITHUB_CALLS = [];
const FIXTURE_RELEASE = {
	tag_name: 'v1.0.2',
	published_at: '2026-08-12T14:38:19Z',
	assets: [
		{
			name: 'NikaCodeSetup-1.0.2.exe',
			browser_download_url: 'https://github.com/alive2/nika-code/releases/download/v1.0.2/NikaCodeSetup-1.0.2.exe',
			digest: 'sha256:cd5f008cc7fc679e5664e2a1b499cf9484848776fc6d57d8c844585f30fb1771',
		},
	],
};
const FIXTURE_TAG_REF = { object: { sha: '15b7df016fef11553431c5b78341ac7e089bef48', type: 'commit' } };
const LATEST_COMMIT = FIXTURE_TAG_REF.object.sha;
const EXPECTED_SHA256 = 'cd5f008cc7fc679e5664e2a1b499cf9484848776fc6d57d8c844585f30fb1771';

const realFetch = globalThis.fetch;
function installGitHubMock({ fail = false } = {}) {
	globalThis.fetch = async (url, init = {}) => {
		const u = String(url);
		GITHUB_CALLS.push({ url: u, headers: init.headers || {} });
		if (fail) {
			return new Response('GitHub unavailable', { status: 500 });
		}
		if (u.includes('/releases/latest')) {
			return new Response(JSON.stringify(FIXTURE_RELEASE), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		if (u.includes('/git/ref/tags/')) {
			return new Response(JSON.stringify(FIXTURE_TAG_REF), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		return new Response('Not found', { status: 404 });
	};
}

const { default: worker } = await import('./src/index.js');

const results = [];
function record(label, ok, detail = '') {
	results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

async function callWorker(path, env = {}) {
	return worker.fetch({ url: `https://nika-code-update.test${path}` }, env);
}

async function bodyOf(res) {
	try { return await res.clone().json(); } catch { return await res.text(); }
}

// ---------------------------------------------------------------------------
// 1. Cache key handling — the original production bug
// ---------------------------------------------------------------------------
installGitHubMock();

{
	let threw = false;
	try { await caches.default.match('github:release:alive2/nika-code'); } catch { threw = true; }
	record('non-http cache key throws (like real runtime)', threw);
}

// Warm the cache with one request, then verify a second identical request is
// served from cache with no additional GitHub calls.
GITHUB_CALLS.length = 0;
await callWorker('/api/update/win32-x64-user/stable/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const callsAfterMiss = GITHUB_CALLS.length;
await callWorker('/api/update/win32-x64-user/stable/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const callsAfterHit = GITHUB_CALLS.length;
record('cache miss populates cache', callsAfterMiss > 0, `${callsAfterMiss} github call(s)`);
record('cache hit served without GitHub calls', callsAfterHit === callsAfterMiss, `${callsAfterMiss} -> ${callsAfterHit}`);

// ---------------------------------------------------------------------------
// 2. Client-facing protocol behavior
// ---------------------------------------------------------------------------
{
	const res = await callWorker(`/api/update/win32-x64-user/stable/${LATEST_COMMIT}`);
	record('up-to-date commit -> 204', res.status === 204, `status=${res.status}`);
}
{
	const res = await callWorker('/api/update/win32-x64-user/stable/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
	const body = await bodyOf(res);
	const ok = res.status === 200
		&& body.url === FIXTURE_RELEASE.assets[0].browser_download_url
		&& body.version === LATEST_COMMIT
		&& body.productVersion === '1.0.2'
		&& body.sha256hash === EXPECTED_SHA256
		// timestamp must be epoch MILLISECONDS (> 1e12 = after 2001-09-09); a
		// seconds value (~1.7e9) renders as "Jan 1970" in the update UI.
		&& typeof body.timestamp === 'number'
		&& body.timestamp === Date.parse(FIXTURE_RELEASE.published_at);
	record('stale commit -> manifest with correct fields', ok, `status=${res.status}`);
}
{
	const res = await callWorker('/nope');
	record('bad path -> 404', res.status === 404, `status=${res.status}`);
}

// ---------------------------------------------------------------------------
// 3. GITHUB_TOKEN support
// ---------------------------------------------------------------------------
{
	cacheStore.clear();
	GITHUB_CALLS.length = 0;
	installGitHubMock();
	await callWorker('/api/update/win32-x64-user/stable/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { GITHUB_TOKEN: 'ghp_test_token' });
	const releaseCall = GITHUB_CALLS.find(c => c.url.includes('/releases/latest'));
	const auth = releaseCall ? releaseCall.headers['Authorization'] : undefined;
	record('GITHUB_TOKEN sends Authorization header', auth === 'Bearer ghp_test_token', `auth=${auth}`);
}

// ---------------------------------------------------------------------------
// 4. Fail-open: an upstream error must return 204, not 500
// ---------------------------------------------------------------------------
{
	cacheStore.clear();
	installGitHubMock({ fail: true });
	const res = await callWorker('/api/update/win32-x64-user/stable/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
	record('GitHub failure -> 204 (fail open)', res.status === 204, `status=${res.status}`);
}

// ---------------------------------------------------------------------------
// 5. Optional live smoke test against the real GitHub API
// ---------------------------------------------------------------------------
if (process.env.LIVE) {
	const latestRes = await realFetch('https://api.github.com/repos/alive2/nika-code/releases/latest', { headers: { 'User-Agent': 'NikaCode-Test' } });
	const latest = await latestRes.json();
	const tagRes = await realFetch(`https://api.github.com/repos/alive2/nika-code/git/ref/tags/${latest.tag_name}`, { headers: { 'User-Agent': 'NikaCode-Test' } });
	const tagRef = await tagRes.json();
	record('live: latest release fetchable', latestRes.ok && !!latest.tag_name, `tag=${latest.tag_name}`);
	record('live: tag deref fetchable', tagRes.ok && !!tagRef.object && !!tagRef.object.sha);
}

console.log('\n--- results ---');
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
if (failed > 0) {
	console.error(`\n${failed} check(s) failed`);
	process.exitCode = 1;
} else {
	console.log('\nAll checks passed.');
}
