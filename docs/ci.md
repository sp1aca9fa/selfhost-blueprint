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
- Claude checks the latest runs at the start of every session
  (`gh run list --workflow CI --limit 3`) and fixes a red run first, unasked: it holds back the
  server's update, and the owner never has to watch GitHub's emails.
- Separately, a red run of the process workflow (`gh run list --workflow Process --limit 3`) means
  review the open task. It has no effect on the server ("Process check" below).
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
  - One word per commit, over the counted runs (all but the process job, dropped by its exact
    name): `success` (the run named exactly `check` concluded success, and every counted run
    completed, each success, neutral or skipped), `failure` (a completed counted run with any other
    conclusion), `pending` (a counted run not completed yet, or no `check` that concluded success,
    with no time limit: CI not started yet, renamed or removed, or `check` skipped or neutral, so CI
    did not test the commit, which the 24-hour alert then reports),
    `unknown` (curl error, HTTP error or rate limit, unreadable answer, bad sha; also more runs
    than the page of 100 shows, counted before the process job is dropped, unless a visible
    counted run failed). The script never prints the API's answer.
  - `check` is the job id in `ci.yml`. Renaming it holds every update back until the script
    follows; a project with another CI job id changes the script to match.
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

## Process check

`templates/.github/workflows/process.yml` runs `ops/process-check.mjs` on every push to `main`: do
the pushed commits carry the trailers their changed files require? It catches a forgotten review,
not a false claim. A red run means "review the open task", and it never holds back a server.

Trailers go in the last paragraph of the commit message, before the attribution:

```
Ship-Task: add-export
Ship-Tier: 2
Ship-Reviews: code-reviewer
Co-Authored-By: ...
```

A trailer anywhere else is not read, so it counts as missing and fails loudly. `Ship-Task` must match
`^[a-z0-9-]+$`, and it is public once pushed: the same no-private-names rule as a commit subject.
`Ship-Reviews` lists names separated by commas or spaces. A repeated trailer fails.

### The rules

- **Floor by path**, from `git diff-tree -r --no-renames --root`, so moving a trust file elsewhere
  still counts its old path. Gitlinks are left out first. Floor 2: a file matches a `tier2` pattern
  and no `tier0` pattern, or is added and matches `tier2New`. Floor 0: every file matches `tier0`.
  Otherwise floor 1.
- **Each commit with floor 1 or more** needs `Ship-Task` and a `Ship-Tier` at or above the floor. A
  lower claim needs `Ship-Tier-Why: <reason>` and prints a notice: paths cannot see a comment-only
  change or a rename, which are Tier 0.
- **Each task in the range:** its highest tier decides the reviewers (`reviews` in the config), and
  its last commit in the range must list them all in `Ship-Reviews`. Chunk commits omit the line. If
  there is nothing left to fix, an `--allow-empty` commit closes the task.
- **A task still open at the end of a push fails.** That is the case worth flagging: the server took
  code before its review. The fix is to run the missing review and commit under the same slug. No
  history rewrite, and the next push's range is judged on its own, so a mistake is red once.
- **A commit with no `Ship-Task` has no task to close**, and only a history rewrite could add one.
  So: look at it, then add its sha to `process-reviewed.txt` in the private ledger folder. `--audit`
  keeps listing it as `unclaimed`; what stays open is `unreviewed`, the commits not in that file.
- **A push that changes the config is judged by both versions**, the one before the push and the one
  it brings, and fails if either fails. So emptying a reviewer list, or moving a trust path to
  `tier0`, cannot pass in the same push. Failures only the old rules find say `(by the config before
  this push)`, and the next push starts from the new rules, so this too is red once. A config before
  the push that cannot be read fails the run.

Why this shape: per commit would force chunk commits to lie, or a review before each commit. "Last
commit of the push" would let a reviewed task cover an unreviewed one pushed with it.

| Case | Treatment |
|---|---|
| Older than the check | Not checked. The boundary is the oldest commit that added `ops/process-check.json`, itself excluded, so re-adding it cannot move the start forward. |
| No config at `after` | No workflow there either: pass. Workflow still there: fail. |
| Merge commit | Not checked and counted; its parents are checked. Limit: conflict edits inside a merge are unseen. |
| Gitlink-only bump | No trailers needed; any present are checked. A mixed commit is judged on its other files. |
| Tier 0 by path | No trailers needed: docs and tests, including tests on trust paths. |
| Owner commit | No automatic exemption. `Ship-Owner: <why>` passes with a notice and joins no task. Otherwise a red run, and the next session reviews the change. An absent attribution line is not the signal: if the harness ever stopped adding it, every commit would pass silently. |
| Revert | No exemption: it is a change like any other. |
| `before` is zeros | Checks boundary..after: the first push of a repo. No earlier config. |
| `before` not found or not an ancestor (a force push) | Fail, `range unknown`. Never a silent pass. |
| A shallow clone | Fail, `range unknown`: its boundary would be wrong. The workflow uses `fetch-depth: 0`. |

Every run prints what it counted, for example `pass: checked 2, older 0, exempt 1 (gitlink), exempt
0 (tier 0), owner 0, merges 0 not checked`, so a check that read an empty range shows it. It prints
shas, fixed texts, validated slugs and config names, never commit text.

### By hand

- `node ops/process-check.mjs origin/main` at the end of a task, so CI is only the backstop.
- `node ops/process-check.mjs --audit --reviewed <ledger folder>/process-reviewed.txt` (not in the
  workflow, no CI effect) reads boundary..HEAD and prints tasks never closed, the commits that fail a
  rule with no task to close (`unclaimed 2: <sha> <sha>`), those not in the file (`unreviewed 1:
  <sha>`), and counts: `audit: tasks 12, open 1, unclaimed 2, unreviewed 1, why 3, owner 1`. A task
  that closed in a later push is not open. An unclaimed commit stays listed, since it cannot be closed
  without a history rewrite. The setup review reads it, because a task closed in no push, or a commit
  with no trailers, is otherwise flagged by nothing after its one red run.
- `process-reviewed.txt` holds one sha per line, any length from 7. A session adds a sha only after
  looking at that commit. Only `unreviewed` above 0 is open. A missing file lists nothing, so every
  unclaimed commit counts; a line that is not a sha fails the audit. It is a list of shas rather than
  a count because a count cannot tell a new commit from an old one that stopped failing, and a config
  change can move commits both ways: tightening one makes a properly reviewed task read unclaimed,
  and that commit gets looked at too.

### The config

`ops/process-check.json` holds `tier2`, `tier2New`, `tier0`, `reviews` and `profileBullets`. Patterns
are anchored at the repo root: `*` and `?` stay inside one folder, a `**` segment spans folders, and a
trailing `/` means everything under that folder. Other glob syntax is refused, since it would
silently match nothing. A config the script cannot use fails the run.

It must agree with the trust-territory Paths list in `docs/agents.md`, and a test in the process job
checks both ways. Each bullet, whitespace normalized, needs a `profileBullets` entry with its
`patterns`, a `reason` (for example, a private folder CI cannot see), or both. So a bullet with no
backticks is covered and a reworded bullet forces a look. Each `tier2` and `tier2New` pattern must
belong to a bullet, and each pattern a bullet names must be enforced. The template's config matches
the template's placeholder bullets, so filling in the profile means updating the config.

`tier2New` is for paths where only a new file is Tier 2, such as a new page.

### Why it cannot hold back a server

A separate workflow is not enough. `ops/ci-status.sh` reads every check run of the commit, from every
workflow, so a red process run alone would give `failure`, and a fast green one with CI not created
yet would have given `success` for a commit CI never tested. So the script does two things:

- It drops the check run named exactly `process-check` before the verdict. A run with no name, or any
  other name, still counts, so the gate keeps failing safe. The page guard (more than 100 runs) uses
  the unfiltered counts.
- `success` needs a run named exactly `check` that concluded `success`. A rename, an added workflow,
  missing CI, or a `check` that concluded `skipped` or `neutral` (CI did not test the commit) gives
  `pending` and the existing 24-hour alert. So `check` must have no job-level `if:`, `name:` or
  `strategy:` (the last two rename the run), which a test asserts. Other runs keep the rule: skipped
  and neutral count as passed.

The second way a check can hold back a server is the normal suite, which CI and the server's version
check both run. So `ops/process-check.test.mjs` stays out of it: `ops/` is in no test project there,
and the process job runs the file by exact path (a glob that matches nothing passes with 0 tests).
The files still go through the project's linter and formatter, like any file.

What keeps this true: `ops/process-check.test.mjs` asserts the job id in `process.yml` equals the name
in `ci-status.sh`, and that the job sets no `name:` (it would rename the check run). The gate's own
tests (`ops/ci-status.test.mjs` in the templates; in a project they belong in the normal suite, so
they run in the job the server waits on) read every workflow file: only `ci.yml` has a job `check`,
only `process.yml` a job `process-check`, no other job is named either, and `check` sets no job-level
`name:` or `strategy:`. A step's `name:` is fine.

### Adding it to a project

Two pushes, in this order. The server runs its installed `ci-status.sh` against the new commit, so the
filter only takes effect after an update:

1. Push the new `ops/ci-status.sh` and its tests. The condition for the second push, run on the server
   from the repo, with `<state folder>` the folder holding `update.log`:

   ```bash
   s="$(git rev-parse --short HEAD)" && if [ "$(grep -c process-check ops/ci-status.sh)" = 1 ] && grep -qE "<App> is up: .* -> $s " <state folder>/update.log; then echo "OK $s"; else echo "NOT YET"; fi
   ```

   It wants `OK <short sha>`. It reads HEAD rather than the first push's sha, because a submodule bump
   pushed with it makes HEAD a later commit. The grep alone is not enough: an update merges first and
   runs its checks after, so during an update that then fails and goes back, it reads 1. Only the
   automatic update writes that log line, so an update by hand leaves `NOT YET` with the filter
   installed: push any later commit other than the next step's, let it install, and run this again.
2. Only then push the workflow, script, tests and config, and add `.github/workflows/` and the
   `ops/process-check` files to the profile's Paths. The script's failure message points at
   `docs/ci.md`, so the project needs a short one with a "Process check" section. The script and its
   test stay byte-identical to the templates, so a project whose linter does not declare Node's
   `process` and `console` for `.mjs` files adds that for these two files.

To undo, go the other way: remove the workflow, check the server, then revert the filter. With the
filter gone and the job still running, a red process run holds the server back again, from the push
after the revert: the revert itself goes in under the installed filter.

### Limits

- Trailers are self-reported. This catches a forgotten review, not a false claim.
- A push that edits `process.yml` or the script runs its own edited version, and GitHub reads the
  workflow from the pushed commit. Only the config is also judged by its earlier version. Both files
  are on the Paths list, so such an edit is Tier 2 by path, and a person reads that diff.
- CI cannot see a private submodule's contents, so private code is unverified. A bump shows only as
  a gitlink.
- Reviewers that depend on whether a change is visible (UX, trust) are not required: "visible" is not
  a path.
- Deleting the workflow silences the check, and nothing inside it can detect that. The Paths list
  makes the deletion Tier 2, and the setup review counts process runs.
