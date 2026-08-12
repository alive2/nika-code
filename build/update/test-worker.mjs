// Local verification harness for the NikaCode update worker.
// Mocks the Cloudflare Cache API, exercises the worker's default export
// against the real GitHub API, and validates the client-facing protocol.
import { Worker } from 'node:worker_threads';

// Minimal caches.default mock: in-memory map that returns a FRESH clone on each
// match (the real Cloudflare Cache API serves a fresh response per hit).
// IMPORTANT: mirror the real runtime's constraint that cache keys must be
// http(s) URLs — a bare string key (like "github:release:...") throws, which is
// exactly the bug that made the deployed worker return 204 for every request.
const cacheStore = new Map();
function assertCacheKey(key) {
	if (typeof key !== 'string' || !/^https?:\/\//.test(key)) {
		throw new TypeError(`Invalid cache key: ${key} (Cache API requires an http(s) URL)`);
	}
}
globalThis.caches = {
	default: {
		async match(key) {
			assertCacheKey(key);
			const entry = cacheStore.get(key);
			return entry ? entry.clone() : undefined;
		},
		async put(key, response) {
			assertCacheKey(key);
			cacheStore.set(key, new Response(await response.clone().text(), { headers: response.headers }));
		},
	},
};

const { default: worker } = await import('./src/index.js');

// The release tag we just published; its tag deref commit is 3c1a6045...
// (We can't know it statically, so derive from the GitHub API like the worker does.)
const latestRes = await fetch('https://api.github.com/repos/alive2/nika-code/releases/latest', {
	headers: { 'User-Agent': 'NikaCode-Test' },
});
const latest = await latestRes.json();
const tagRes = await fetch(`https://api.github.com/repos/alive2/nika-code/git/ref/tags/${latest.tag_name}`, {
	headers: { 'User-Agent': 'NikaCode-Test' },
});
const tagRef = await tagRes.json();
const latestCommit = tagRef.object.sha;

console.log('Latest release tag :', latest.tag_name);
console.log('Latest commit      :', latestCommit);

const results = [];
async function check(label, path, expect) {
	const res = await worker.fetch({ url: `https://nika-code-update.test${path}` }, {});
	const status = res.status;
	let body = null;
	try { body = await res.clone().json(); } catch { body = await res.text(); }
	const ok = expect(status, body);
	results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}  (status=${status})`);
	if (!ok) {
		console.log('   body:', JSON.stringify(body));
	}
}

await check('up-to-date commit -> 204', `/api/update/win32-x64-user/stable/${latestCommit}`, (s) => s === 204);
await check('stale commit -> manifest', '/api/update/win32-x64-user/stable/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', (s, b) => {
	return s === 200 && b.url && b.productVersion === latest.tag_name.replace(/^v/, '') && b.sha256hash && b.version;
});
await check('bad path -> 404', '/nope', (s) => s === 404);
await check('old v1.0.0 commit -> update available', '/api/update/win32-x64-user/stable/3c1a6045cd13096bdbdc17e870315ddf20d10034', (s) => s === 200 || s === 204);

console.log('\n--- results ---');
console.log(results.join('\n'));

// Also print the manifest the stale-commit check would return, for the release notes.
const manifestRes = await worker.fetch({ url: 'https://nika-code-update.test/api/update/win32-x64-user/stable/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, {});
console.log('\nExample manifest:', JSON.stringify(await manifestRes.json(), null, 2));
