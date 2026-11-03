# CLAUDE.md (MyApp)

Generic rules for Claude Code, committed. The owner's private rules are in
`private/ops/claude-rules.md`, loaded through the git-ignored `CLAUDE.local.md`.

## Reading protocol (every session)
1. Read `docs/requirements/00-index.md` (its Status table names the current stage).
2. Read the current stage file in `docs/requirements/stages/` (ask if the current stage is unclear).
3. Read only the area files that stage file lists as relevant to the task.
4. Read the full `REQUIREMENTS.md` only for the completion check at the end of a stage, or when
   the owner asks.
5. When the private submodule is checked out: `private/ops/actions.md` (the owner may have
   written answers into it).

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
- Never `git add -A`; add files by name. Commit when a piece of work is done and tested; the owner
  pushes (private submodule first, then this repo).

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
Agents are shared across projects (the `selfhost-blueprint` repo's `claude/agents`, linked into
`~/.claude`); this project's profile is `docs/agents.md` (the app, trust territory, domain
checklist, and the model and effort per role: pass those as `model` and `effort` every time an
agent is started). `/ship <task>` runs the whole loop. The main session plans, writes the spec,
routes, triages and commits; it implements small changes itself (a few files in one area, a
review fix, docs). Subagents cannot spawn subagents.

**Tiers** (judge by the diff; trust territory decides the whole change):
| Tier | When | Review |
|---|---|---|
| 0 | Docs, comments, config with no behavior change, test-only changes | None; CHECKS only |
| 1 | Product code outside trust territory | `code-reviewer-light`; `ux-reviewer` if UI |
| 2 | Trust territory (`docs/agents.md`); any new page | `code-reviewer`; `ux-reviewer` (and `trust-reviewer` if used) if UI |

A Tier 0 or 1 change that fails CHECKS twice moves up a tier. Never review Tier 0 "to be safe".

**Loop:**
1. Spec in `.agent-runs/<date>-<slug>/spec.md` (`docs/spec-template.md`): goal, acceptance
   criteria, the requirement sections it rests on (point, don't copy), pages touched, tier.
   Unclear current-stage details: the conservative reading, under "Assumed". Unclear later-stage
   details: left out and put to the owner.
2. Build: `builder` for routine chunks, `builder-heavy` for trust territory, design, an
   ambiguous spec, or after a builder failed. Give the spec path, the chunk and CHECKS; never
   paste code.
3. Gates: CHECKS (`pnpm check:all`); on failure back to the builder, at most 2 tries. UI: the
   page crawler once for the changed pages.
4. Review: the tier's reviewers in one message (parallel). Code reviewers get the commit range,
   spec path and CHECKS output. UX and trust reviewers get only screenshot paths and one line per
   page, nothing else.
5. Triage: the main session verifies a single reviewer's findings against the code itself;
   `triage` only when two or more reviewers ran. Act without asking: fix what is right, take the
   recommended option on cosmetic asks, skip what is wrong; anything under "Owner decides" goes
   to the owner. Fixes in one batch. Re-review only Tier 2 logic fixes, by the reviewer whose
   finding it was. At most 2 fix rounds; what is still open goes in the report.
6. Log facts in `.agent-runs/<date>-<slug>/log.md` and one row per reviewer run in
   `private/ops/agent-ledger.csv` (`date,slug,tier,reviewer,findings,accepted,rejected,duplicate`).
   Update `private/ops/actions.md`.
7. `summarizer` for long logs, check output, crawl reports or pasted server output.

**Stop and ask** only for: a destructive or irreversible action; pushing or deploying; a new
dependency, external service or cost; a request that conflicts with the requirements; anything
under "Owner decides" in `docs/agents.md`; two failed fix rounds on a bug. When the owner asked
for continuous work, prepare the decision in `private/ops/actions.md` section C with a
recommendation and continue with other work.

## Communication
The report after each task, short, no step recap:
```
Done: <what changed; tier and why>
Tested: <checks and tests; what was not tested>
Needs you: <decisions and blockers, each restated, with a recommendation; or nothing>
Open issues: <unresolved after 2 rounds, known limits; or none>
Assumed: <every assumption about data, calculations or users; or none>
Backlog ideas: <or none>
Reviewers: <each that ran: findings N, accepted N; useful, noisy or redundant (from the ledger)>
```
