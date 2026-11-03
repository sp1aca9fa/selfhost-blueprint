# CI

Every project has a GitHub Actions workflow (`templates/.github/workflows/ci.yml`) that runs the
project's full checks and the build on every push and pull request. GitHub runs it for free on
public repos.

## Why

- **A safety net for pushes.** The home server updates itself from every push. CI catches a push
  that breaks the tests or the build even when a local check was skipped or ran in a different
  environment.
- **A clean checkout.** CI sees what a stranger who clones the repo sees: no private submodule,
  no `.env`, no local caches. It proves the public repo stands on its own and that tests use only
  synthetic fixtures.
- **Visible to visitors.** A green check on the repo shows it builds.

## What it runs

`pnpm install --frozen-lockfile`, `pnpm check:all` (typecheck, lint, format check, tests, docs
check, coverage gates the project defines), `pnpm build`. The private submodule is not checked
out; scripts that touch it skip themselves when it is missing. Jobs refuse to run when `CI` is
set, so nothing in CI reaches live sources.

## Rules

- Tests are deterministic: no live network, no real clock races. A flaky test is a bug, fixed
  first (never retried until green, never skipped).
- Never loosen a check to make CI pass; report the failure.
- Later option: the server's self-update can wait for a green CI run on the new commit before
  updating (the GitHub API's commit status). Worth it once more than one person pushes.
