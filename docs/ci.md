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
- Claude checks the latest runs at the start of every session (`gh run list --limit 3`) and fixes
  a red run first, unasked: it holds back the server's update, and the owner never has to watch
  GitHub's emails.
- A test never depends on today's date: data at a fixed day with code that reads the clock passes
  for weeks, then fails on every run. Pin the clock in the test. To check a project, run its tests
  with the clock shifted forward by a preload (`NODE_OPTIONS=--require <file>`).
- `vitest run --testTimeout=60000`: CI machines are slower than the owner's, and heavy tests near
  the 5 s default fail at random. The limit only catches a hung test; no test may use it to assert
  speed.
- The server's self-update waits for a green CI run on the new commit before updating
  (`templates/ops/ci-status.sh`, `home-server.md` section 7), so a push that breaks the tests or
  the build never reaches the server:
  - The signal is the commit's check runs (GitHub Actions) from the REST API
    (`/repos/<owner>/<repo>/commits/<sha>/check-runs`), read without a token since the repos are
    public, following up to 3 https redirects (a renamed repo); the older commit status API is not
    used. The owner and repo come from
    `git remote get-url origin` (ssh or https github.com forms; anything else gives `unknown`).
  - One word per commit: `success` (at least one run, all completed, each success, neutral or
    skipped), `failure` (a completed run with any other conclusion), `pending` (a run not
    completed yet, or none yet, with no time limit), `unknown` (curl error, HTTP error or rate
    limit, unreadable answer, bad sha). The script never prints the API's answer.
  - Only `success` updates. `pending` and `unknown` change nothing (the next tick asks again; the
    log notes a status once per commit). When the server has gone 24 hours without updating
    while CI is not green, admins are told once (its own text) and it keeps waiting; the clock
    runs from the server's own commit, so daily pushes do not restart it; an update or a reported CI failure does.
    `failure` records the commit like a failed update, at once (nothing changed, so no job lock
    is needed): not asked about again until a newer push, admins told with the step `ci` and its
    own text (the server never left its version).
  - The state is one line, `<here> <target> <status> <since> <told>` (Saku-style templates add
    whether the failure's activity entry was written). An alert no admin channel took (the alert
    command exits 1 when every channel failed; only delivered alerts count for the daily
    de-duplication) is tried again at each check until sent, without a second activity entry;
    the log notes the first try and the first failure only.
  - The update goes to exactly the checked commit (`git merge --ff-only <sha>` after the fetch),
    never a later one that arrived while CI was read.
  - The API is called only while a new, not-failed commit waits: at most 12 calls an hour per app
    at a 5-minute timer, against GitHub's 60 an hour per address unauthenticated (shared by the
    apps on one server).
  - By hand the script prints the status as a warning and updates anyway (the owner chose to).
  - `<APP>_UPDATE_REQUIRE_CI=0` (environment or `.env`, read as the app reads `.env`: quotes,
    `#` comments) turns the gate off, for a fork without CI. The private submodule is not gated:
    CI does not check it out.
  - After a passing CI re-run on a commit that failed: run `ops/update-server.sh` by hand, or
    delete `~/.local/state/<app>/update-failed`. A commit CI never runs on (`[skip ci]`,
    `paths-ignore`, a disabled workflow) is never installed by the automatic update; the 24-hour
    alert says so.
