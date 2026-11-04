# CLAUDE.md (MyApp)

Generic rules for Claude Code, committed. The owner's private rules are in
`private/ops/claude-rules.md`, loaded through the git-ignored `CLAUDE.local.md`.

## Reading protocol (every session)
1. Read `docs/requirements/00-index.md` (its Status table names the current stage).
2. Read the current stage file in `docs/requirements/stages/` (ask if the current stage is unclear).
3. Read only the area files that stage file lists as relevant to the task.
4. Read the full `REQUIREMENTS.md` only for the completion check at the end of a stage, or when
   the owner asks.
5. When the private submodule is checked out: `private/ops/actions.md` and the to-dos in
   `private/ops/notes.md` (see "The owner's actions file").

If a request conflicts with the requirements, point out the conflict and ask before proceeding.

## Pillars (priority order, use them for trade-offs)
1. <<Reliability: never act on wrong data or wrong calculations.>>
2. <<...>>

## Working rules
- Work stage by stage. Only the current stage is detailed; if a later-stage detail is unclear,
  ask, don't invent.
- Don't implement unrequested features; put ideas in `docs/backlog.md` and mention them.
- Small changes: one feature or fix per commit, with tests.
- Ask before adding a dependency (MIT, Apache 2.0, BSD, ISC only; never GPL/AGPL/LGPL), an
  external service, or anything that could cost money.
- Never commit API keys, `.env` files or real data to the public repo. Real recorded responses go
  only in the private submodule.
- Requirement changes: edit the files in `docs/requirements/`, run `pnpm docs:build`, add a
  decisions-log entry. Never edit `REQUIREMENTS.md` directly.
- Unsure about a provider's limits or terms: check its current docs and record the findings.
- Never `git add -A`; add files by name (so a commit holds only what was meant: never a stray
  `.env`, data file, scratch output or another session's edits). Commit when a piece of work is
  done and tested; the owner pushes (a plain `git push` pushes the private submodule first:
  `push.recurseSubmodules=on-demand`).

## The owner's actions file
`private/ops/actions.md` is the one place the owner looks for anything they need to do or decide:
A. steps to run, B. checks in the app, C. decisions needed (each restated for a non-technical
reader, with a recommendation), D. comments to know, F. work log since their last review.
- Read it at the start of every session: the owner may have written answers or marked items done.
- Update it after every piece of work (new steps, decisions, the work log).
- It holds only open items: what the owner marks `[x]`, settled decisions and read comments move
  to `private/ops/actions-done.md` (newest first, dated); the work log moves there once read.
- Each item is 5-20 lines and enough to decide on alone, without asking and without other docs:
  the context, every term explained, what happens now and if nothing is done, the options with
  their risks, the recommendation, exactly what to do or answer (`/ship` section 6).
- Claude's own to-dos and later work go in `private/ops/notes.md` ("To-dos"), also read every
  session.

## Agnostic core (mandatory)
- Nothing particular to one country, provider, shop, language or person is hardcoded in core. It
  is a plug-in or an admin setting.
- Public plug-ins use official APIs; unofficial, scraped or personal ones go in the private
  submodule. Public examples and tests use neutral made-up names.
- Plug-ins never call `fetch` directly (use the SDK's HTTP client) and never write to the
  database.

## Language
Every user-facing string goes through `packages/content`; `en.json` is the base, other language
files may be partial. Code, comments, database values, docs and commits in US English.

## Data rules (never break)
- Import only raw data; never import derived values. Provider-computed values are for
  verification only.
- Unknown stays unknown (never 0, never a guess). Money always carries its currency.
- Never silently overwrite stored data; use the revision log.
- Never disable or loosen a check to make a run pass; report the failure.
- Sources marked `noAi` never reach Claude.

## Security
- Every user-owned table has `owner_id`; every query on it is scoped to the signed-in user, and
  authorization is checked in every server action and route (never only in middleware).
- Never print `.env` values.

## Compute and jobs
- Heavy computation runs in server jobs or the browser (Web Workers), never in a web request.
- Jobs and plug-ins run only on the server; they refuse to run when `VERCEL` or `CI` is set.
  Idempotent, catch up on all unprocessed days, respect quotas, heartbeat only on full success.
- Migrations are add-only (drop in a later migration).

## Testing
- External golden values first; synthetic fixtures in the public repo; no live calls in tests;
  fault cases for every new data path; wrong-user authorization tests. A flaky test is a bug.
- CI gates: lint, typecheck, tests, build, `pnpm docs:check`.

## Agents (the main session orchestrates)
The loop is the shared `/ship` (`~/.claude/commands/ship.md`, from the `selfhost-blueprint`
repo): tiers 0-3 decided by the changed files, Tier 3 handling, which questions may stop the work,
how to write for the owner, the setup review. Read it before any Tier 1-3 work, with or without
`/ship`. This project's profile is `docs/agents.md`: risk class, trust-territory paths, the model
and effort per role (pass them as `model` and `effort` every time an agent is started), the
owner's list, standing rules. The main session plans, writes the spec, routes, triages and
commits; it implements small changes itself (a few files in one area, a review fix, docs).
Subagents cannot spawn subagents.

| Tier | When | Review |
|---|---|---|
| 0 | Docs, comments, tests only, config with no behavior change | None; CHECKS only |
| 1 | Behavior changes outside trust territory | `code-reviewer-light`; `ux-reviewer` if visible |
| 2 | A file on the trust-territory paths; any new page | `code-reviewer`; `ux-reviewer`, `trust-reviewer` if visible |
| 3 | Tier 2 the normal loop cannot verify (`/ship` section 1 triggers) | plan review, then normal and adversarial review |

## Communication
The report after each task, short, no step recap:
```
Done: <what changed; tier and why>
Tested: <checks and tests; what was not tested>
Actions: <"New actions from this round are in <the actions file>." or "No new actions raised.">
Open issues: <unresolved after 2 rounds, known limits; or none>
Assumed: <every assumption about data, calculations or users; or none>
Backlog ideas: <or none>
Reviewers: <each that ran: findings N, accepted N; useful, noisy or redundant (from the ledger)>
```
