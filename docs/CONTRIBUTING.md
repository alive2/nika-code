# Contributing to NikaCode

Thanks for wanting to contribute! NikaCode is a fork of [Visual Studio Code](https://github.com/microsoft/vscode)
(`Code - OSS`) with its own versioning, a custom BYOK chat provider, and an
auto-update pipeline. Before you open your first pull request, read this page
end-to-end — the **contribution model** for this repo is stricter than the
upstream VS Code project's.

---

## The contribution model (read this first)

NikaCode is a **single-maintainer** project. To keep the tree stable:

- **Only the repository owner (`alive2`) can push directly to `main`.**
- **Everyone else contributes exclusively through pull requests** created from
  a **fork** of the repository.
- The `main` branch is **protected**:
  - Direct pushes to `main` are blocked for everyone except the owner.
  - **At least 1 approving review** is required before a PR can be merged —
    i.e. the owner reviews and merges your work.
  - Force-pushes and branch deletions on `main` are disabled.
  - Merges are limited to a **linear history** (squash or rebase merges).

If you have write access to this repository, treat it as **read-only for
pushing to `main`** — even collaborators are expected to use the fork → PR →
review flow. If you are not a collaborator at all, the fork flow is the only
path, and that is exactly how it is meant to work.

> **Rule of thumb:** any change you want to land goes through a pull request
> that the owner reviews. There are no exceptions, not even for one-line
> typo fixes.

---

## Prerequisites

| Thing | Notes |
| --- | --- |
| A [GitHub account](https://github.com/join) | Required to fork and open PRs |
| [Git](https://git-scm.com/downloads) | 2.30+ recommended |
| [Node.js](https://nodejs.org/) | The version required by the upstream VS Code base (`1.134.x` in this fork) — see `package.json` / `.nvmrc` |
| A package manager | `npm` (used by this repo) |
| ~2 GB free disk + time | The full build takes a while on first run |

You do **not** need push access to this repository. Everything is done through
your own fork.

---

## Step 1 — Fork the repository

1. Go to <https://github.com/alive2/nika-code>.
2. Click **Fork** (top-right). Fork into your own account.
3. Clone **your fork** locally (note: `origin` is *your* fork, not upstream):

   ```sh
   git clone https://github.com/<your-username>/nika-code.git
   cd nika-code
   ```

4. Add the main repository as an upstream remote so you can stay in sync:

   ```sh
   git remote add upstream https://github.com/alive2/nika-code.git
   git fetch upstream
   ```

   Verify your remotes:

   ```sh
   git remote -v
   # origin   https://github.com/<your-username>/nika-code.git (fetch/push)
   # upstream https://github.com/alive2/nika-code.git         (fetch/push)
   ```

5. Configure Git identity if you haven't already:

   ```sh
   git config user.name "Your Name"
   git config user.email "you@example.com"
   ```

---

## Step 2 — Create a feature branch

Always work on a branch, never on `main` of your fork:

```sh
git checkout -b fix/describe-the-change
# e.g. git checkout -b fix/update-timestamp-units
```

Branch naming conventions:

| Prefix | Use for |
| --- | --- |
| `fix/...` | Bug fixes |
| `feat/...` | New features |
| `docs/...` | Documentation-only changes |
| `chore/...` | Tooling, cleanup, dependency bumps |

Keep the branch focused: **one logical change per branch/PR**. If you find
yourself fixing two unrelated things, split them into separate branches and
separate PRs.

---

## Step 3 — Stay in sync with upstream `main`

Before you start work (and again right before opening the PR), pull the latest
`main` from the main repository into your branch:

```sh
git fetch upstream
git rebase upstream/main
```

Rebasing (rather than merging) keeps history linear and makes the eventual
merge clean. If you already pushed your branch to your fork, force-push it
after a rebase (**this is fine on your own fork branch**):

```sh
git push --force-with-lease origin fix/describe-the-change
```

> `--force-with-lease` is the safe way to force-push; it refuses to overwrite
> changes you haven't seen.

---

## Step 4 — Build & test locally

NikaCode builds like the upstream VS Code fork. The docs in this repository
cover the full pipeline:

| What you need | Doc |
| --- | --- |
| Build the app + installer | [docs/DEPLOYMENT.md](./DEPLOYMENT.md) |
| Versioning & the update pipeline | [docs/ARCHITECTURE.md](./ARCHITECTURE.md) |
| Cutting a release | [docs/RELEASING.md](./RELEASING.md) |
| Known gotchas | [docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md) |

Quick sanity checks before opening a PR:

```sh
# install dependencies
npm install

# type-check the client sources
npm run typecheck-client

# run unit tests (add a --grep filter for a focused run)
#   macOS/Linux:  scripts/test.sh
#   Windows:      scripts\test.bat
```

For the built-in extensions (including the Copilot BYOK provider, where most
NikaCode-specific code lives):

```sh
npm run gulp compile-extensions
```

> The repo uses **tabs, not spaces**, and follows the upstream VS Code coding
> guidelines (see `AGENTS.md` / `.github/copilot-instructions.md` for the
> fork-specific rules). Please match the surrounding code style.

---

## Step 5 — Commit your work

```sh
git add <files>
git commit -m "Fix <short imperative description>"
```

Guidelines:

- Write a **clear, imperative** commit message (e.g. `Fix update worker cache
  keys`, not `updated stuff`).
- One logical change per commit; several commits per PR are fine.
- **Do not** commit build artifacts, logs, or generated files. The repo ignores
  runtime logs (`nika.log`, `nikas.log`) — don't force-add them.
- If your change is user-visible, mention it in the PR description so the
  maintainer can decide whether it warrants a release note.

---

## Step 6 — Push to your fork and open a pull request

```sh
git push -u origin fix/describe-the-change
```

Then open the PR:

1. Go to <https://github.com/alive2/nika-code/pulls> (or use the banner GitHub
   shows after pushing).
2. **Base:** `alive2/nika-code` → `main`
   **Compare:** `<your-username>/nika-code` → `fix/describe-the-change`
3. Fill in the PR template:
   - **What** this change does and **why**.
   - How you **tested** it (commands run, scenarios verified).
   - Any screenshots/GIFs for UI changes.
   - Any related issue numbers.

Keep the PR description self-contained: the reviewer should be able to
understand the change without digging through commits.

---

## Step 7 — The review cycle

After you open the PR:

1. The owner will review your changes and leave feedback.
2. **Address review comments** by adding new commits to your branch and pushing
   them (do not rewrite history mid-review unless asked):

   ```sh
   git add .
   git commit -m "Address review feedback: <what changed>"
   git push
   ```

3. If the branch has drifted from `main` during review, rebase again
   (see [Step 3](#step-3--stay-in-sync-with-upstream-main)) and force-push with
   `--force-with-lease`.
4. **Only the owner merges.** `main` requires an approving review, so your PR
   cannot merge itself. The owner will merge (squash or rebase) once they're
   satisfied.

> Because stale reviews are dismissed automatically, any new commit you push
> clears the previous approval — the owner will re-review. That is normal.

---

## What happens after merge

- Merged commits land on `main` via a squash or rebase merge (linear history).
- If the change bumps `productVersion` in `product.json`, the owner will cut a
  new release (see [docs/RELEASING.md](./RELEASING.md)) and the auto-update
  pipeline (see [docs/AUTO-UPDATE.md](./AUTO-UPDATE.md)) will serve it to
  installed NikaCode clients.
- Your fork's `main` will be behind — sync it when you need it:

  ```sh
  git checkout main
  git pull upstream main
  git push origin main
  ```

---

## Rules of thumb (cheat sheet)

| Do | Don't |
| --- | --- |
| Fork + branch + PR for **everything** | Push directly to `main` (blocked anyway) |
| Rebase onto `upstream/main` before opening a PR | Merge `upstream/main` into your branch (prefer rebase) |
| One logical change per PR | Bundle unrelated fixes into one PR |
| Write a clear PR description + test steps | Open a PR with no description |
| Match the existing code style (tabs, guidelines) | Introduce a different formatting style |
| Push new commits while addressing review feedback | Force-push to rewrite history mid-review (unless asked) |
| Keep commit history linear | Push large binary/artifact changes |

Questions? Open an issue on <https://github.com/alive2/nika-code/issues> or
start a discussion — but remember, the maintainer is the final reviewer for
everything.
