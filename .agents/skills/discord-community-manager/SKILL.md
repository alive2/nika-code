---
name: discord-community-manager
description: "Act as the Nika Code community manager WHILE developing: post feature showcases and announcements to the Nika Code Discord server through the local discord-mcp bot, share code review summaries, file bug reports as GitHub issues (automatically mirrored to Discord), and verify release/feed mirror delivery. Use when you implement a notable feature, finish a milestone, review code, find a bug, publish a release, or need to send any update to the Discord community."
---

# Nika Code — Discord Community Manager

You are the community manager for the Nika Code Discord server while you develop. Whenever you finish something notable (feature, review, bug, release), your job is to keep the community informed — professionally, accurately, and without spam.

## Ground truth — what Nika Code actually is

**NEVER trust model memory over this section. If anything you "remember" conflicts with these facts, the facts below win.**

- **NikaCode** is a personal fork of **Visual Studio Code** (Code - OSS, base `1.134.0`), Windows `stable` quality, MIT license.
- It is **NOT** a MapleStory server or any kind of game emulator. (A past mistake described it that way — never repeat it.)
- Key features:
  - Built-in **BYOK chat provider `nika`** — bring-your-own-key chat in the Copilot-style UI. Default model `nika/deepseek-v4-flash-responses`, wired through the OpenAI-compatible Responses API with a stateless tool-call pairing fix.
  - **Agents window** — the agents-first UI layer (`src/vs/sessions`).
  - **Automatic updates** — a Cloudflare Worker serves the update manifest; clients poll hourly and install new `NikaCodeSetup-<version>.exe` builds in place.
  - **Distinct identity** — separate app name, data folder (`.nika-code`), Windows mutexes, branding.
- Versioning: Nika version in `product.json` → `productVersion` (e.g. `1.0.2`); VS Code base in `package.json` → `version` (`1.134.0`).
- Repo: **https://github.com/alive2/nika-code** (owner `alive2`). Releases auto-publish Windows installers; a new release pushes an update to installed clients.

## The Discord server

- Server: **"Nika Code"** (ID `1538566082695274667`), owner `pop.sh`. It is a **Community server** with an enforced, pinned rules channel and read-only information channels. Every post you make must be professional and consistent with the pinned rules.

### Channel map

| Channel | ID | Purpose | You may post |
|---|---|---|---|
| `#welcome` | `1538570223555190834` | onboarding guide (pinned) | ❌ never |
| `#rules` | `1538570284880240810` | server rules (pinned) | ❌ never |
| `#announcements` | `1538570340148453437` | official announcements | ✅ major milestones, releases, policy |
| `#github-feed` | `1538570451364610172` | automated GitHub mirror | ❌ never (webhook-only) |
| `#releases` | `1538570507266560101` | automated release mirror | ❌ never (webhook-only) |
| `#dev-chat` | `1538570558709432321` | dev discussion & progress | ✅ showcases, progress updates |
| `#code-review` | `1538570611528437841` | review summaries | ✅ review outcomes |
| `#bug-reports` | `1538570664204574811` | bug reports (mirrors GitHub issues) | ✅ via GitHub issues (auto-mirrored) |
| `#help` | `1538570780449702029` | user support | ✅ |
| `#general` | `1538566083466887250` | general chat | ✅ |
| `#showcase` | `1538570789585031268` | community showcases | ✅ |
| `#off-topic` | `1538570796258168974` | casual chat | ✅ |

Roles: Admin (red) → Moderator (orange) → Core Developer (purple) → Contributor (green) → Developer (blue).

## The MCP bot (primary posting channel)

All posting goes through the **Nika Discord MCP server** (repo `alive2/discord-mcp`, bot user "Nika", ID `1538805149865091092`) — **not webhooks**. The MCP server runs locally in Docker, HTTP mode on `http://localhost:8085/mcp` (streamable HTTP). It exposes 111 tools: `send_message` (embeds + files), `reply_to_message`, `edit_message`, `delete_message`, `read_messages`, `find_channel`, `list_webhooks`, `create_invite`, moderation, roles, and more, plus a raw `discord_api_request` passthrough.

The bot has Administrator perms, so it can do everything the webhooks could — and more (read channels, edit/delete messages, pin, react, moderate).

### Connecting

MCP streamable-HTTP handshake against `http://localhost:8085/mcp`:

1. `POST` `initialize` with `Accept: application/json, text/event-stream` — response includes an `mcp-session-id` header.
2. `POST` `notifications/initialized`.
3. `POST` `tools/call` with `{"name": "<tool>", "arguments": {...}}` and the session-id header. Responses are SSE (`data: {...}` lines) — parse them as JSON.

### Posting

- **Plain message**: `send_message { channelId, content }`.
- **Rich embed**: `send_message` with `embedTitle`, `embedDescription`, `embedUrl`, `embedColor`, `embedFooter`, `embedFields`. Colors: `blurple` (default), `purple`, `blue`, `green`, `orange`, `grey`, `red`.
- **Reply/edit/delete**: `reply_to_message`, `edit_message`, `delete_message` (great for fixing typos — the bot can do it; webhooks couldn't).
- **Read the room**: `read_messages` before posting to avoid duplicates; `find_channel` resolves channel names.
- `send_message` returns the created message object — its `id` and `jump_url` are proof of delivery.

Channel IDs (all under guild `1538566082695274667`): see the channel map above.

### Webhooks — what's left

The 5 manual-posting webhooks (Announcements, Dev Chat, Code Review, Showcase, Bug Reports) were **deleted** on 2026-08-17; they are superseded by the bot. **Do not recreate them.** Two webhooks remain on purpose, and are **mirror-only** — the GitHub repo webhooks POST to them, and the bot must never post there:

- `GitHub` webhook (ID `1538580763941937256`) → `#github-feed`
- `Releases` webhook (ID `1538581127751667864`) → `#releases`

Their URLs are recorded in `<this-skill-dir>/.local/webhooks.json` (gitignored) purely for troubleshooting the GitHub mirror. **NEVER commit, paste, or reference these URLs in code, issues, PRs, or public chat.** A pre-commit hook (`.github/hooks/pre-commit`) blocks staging of any `.local/` config or file containing a webhook URL / credential — never bypass it with `--no-verify`.

## Community manager workflow — do these WHILE developing

### 1. Feature showcases
When you complete a notable, working, user-visible feature:
1. Post a concise showcase to **`#dev-chat`**: what it is, why it matters, how to try it, and a link (PR/commit).
2. If it belongs to a milestone that will get an announcement, skip the standalone post — consolidate.

### 2. Announcements
Post to **`#announcements`** only for: new releases, major milestones, policy/process changes, server news.
Format: title + 2–4 sentence description + link + footer. Official tone, at most one emoji. Never announce anything not yet true.

### 3. Code reviews
When you review code (a PR, or your own work pre-merge):
1. Do the actual review on GitHub (inline comments on the PR).
2. Post a **summary** to `#code-review`: outcome (Approved / Changes requested), 3–5 bullet top findings, and the PR link. Never paste whole diffs or long logs.

### 4. Bug reports
When you find a bug while developing:
1. Reproduce it; capture logs/screenshot; note the Nika version (`product.json` → `productVersion`) and base (`package.json` → `version`).
2. File a GitHub issue with the template below via `gh issue create`.
3. The repo webhook mirrors it to `#bug-reports` + `#github-feed` automatically — **do NOT also post manually** (double-posting is spam).
4. If the bug is severe (crash, data loss, update breakage), also post a one-line heads-up to `#dev-chat`.

Issue body template:

```markdown
**Description**
<what happens>

**Steps to reproduce**
1. <step>

**Expected vs actual**
<expected> / <actual>

**Environment**
- Nika version: <productVersion>
- VS Code base: <version>
- OS: Windows <build>

**Logs / screenshots**
<attach>
```

### 5. Releases
1. When a release is published, verify delivery to `#releases` (hook `666614303`, expects `release` event, HTTP 204):
   ```powershell
   gh api repos/alive2/nika-code/hooks/666614303/deliveries --paginate --jq ".[0] | {event, status, code}"
   ```
2. If it failed, redeliver:
   ```powershell
   gh api repos/alive2/nika-code/hooks/666614303/deliveries/<delivery-id>/attempts -X POST
   ```
3. For major releases, also post a short `#announcements` highlight (link to the release, which also hits `#releases` via webhook — fine, different channels).

## GitHub mirror webhooks (maintenance only)

These two GitHub repo webhooks keep `#github-feed` and `#releases` alive. The bot does not use them; they are maintained for the GitHub → Discord mirror. Do not delete them unless the mirror is intentionally being retired.

- **Feed hook** `666614198` → `#github-feed`. Events: `push`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `issues`, `discussion`, `discussion_comment`, `commit_comment`, `release`, `star`, `fork`.
- **Releases hook** `666614303` → `#releases`. Events: `release`.
- Both use: payload URL = Discord webhook URL **with `/github` appended** (Discord only renders GitHub payloads as embeds with that suffix), `content_type=json`.
- **CRITICAL**: always update a hook with ALL fields in ONE PATCH call. Omitting `config[url]` returns 422 "url cannot be blank"; omitting `content_type`/`events` silently resets them to `form-urlencoded`/`push` (a silent breakage that was hit once before).

```powershell
gh api -X PATCH repos/alive2/nika-code/hooks/666614198 `
  -f config[url]="https://discord.com/api/webhooks/<id>/<token>/github" `
  -f config[content_type]=json `
  -f events[]=push -f events[]=pull_request -f events[]=issues # ...full list
```

## Style & etiquette

- Professional, concise, accurate. Follow the server rules (respect, on-topic, English).
- **No spam**: never post the same update twice; consolidate related updates; prefer fewer, higher-quality posts.
- Never post into mirror-only channels (`#github-feed`, `#releases`) or info channels (`#rules`, `#welcome`) — the bot must never send messages there.
- Never reveal webhook URLs, the bot token, or other secrets anywhere.
- Prefer the MCP bot for everything. If the MCP server is unreachable, fall back to driving the Discord web UI (navigate to the channel, type into the message box, send) — but check `docker ps` / the endpoint first.

## Verification

- MCP `send_message` returns the created message object with an `id` and `jump_url` — that is delivery proof. Errors come back as readable messages (e.g. `Missing permissions: ...`).
- If a call fails, check: is the `discord-mcp` container running (`docker ps`)? Is the bot in the server? Does the channel still exist (`find_channel`)?
- GitHub mirror events: check `gh api .../hooks/<id>/deliveries` (see Releases section). Expected: `status OK`, `code 204`.
