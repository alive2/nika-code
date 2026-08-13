# Contributing to NikaCode

Thanks for wanting to contribute! NikaCode is a single-maintainer fork of
[Visual Studio Code](https://github.com/microsoft/vscode) (`Code - OSS`, base
`1.134.0`) with its own versioning, a BYOK chat provider, and an automatic
update pipeline.

## The contribution model (short version)

- **Only the repository owner can push directly to `main`.**
- Everyone else contributes through **pull requests from a fork**.
- `main` is **branch-protected**: at least 1 approving review is required, and
  only the owner merges.
- Dependabot and the upstream Microsoft CI workflows are disabled on this fork
  — they don't apply here.

## Full guide

Read **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** for the complete
walkthrough: fork setup, feature branches, staying in sync, build & test
commands, commit guidelines, and the review cycle.

## Reporting issues

File issues at **[github.com/alive2/nika-code/issues](https://github.com/alive2/nika-code/issues)**.
For security vulnerabilities, see [SECURITY.md](SECURITY.md) — please do **not**
report those through public issues.
