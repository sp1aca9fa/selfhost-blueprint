# Agent profile

Read by the shared agents (see the blueprint's `claude/README.md`) and by the orchestrator. The
loop is the shared `/ship` (`~/.claude/commands/ship.md`); this file holds only what differs here.
Keep it short: the agents read it on every run.

## The app

<One paragraph: what the app does, for whom, and the worst failure (the mistake that hurts most).>

## Rules files

- Public: `CLAUDE.md`.
- Private: `private/ops/claude-rules.md` (read it if it exists; it is not in the public repo).

## Risk class

<A, B or C (the blueprint's `claude/README.md`), and one line on why.>

## Trust territory (Tier 2)

Areas: <where a mistake is silent or lasting: data collection and parsing, calculations, money,
alerts, auth and access checks, migrations, backups and restore, imports, deletes, server
scripts>.

Paths (a changed file here makes the change Tier 2; Tier 3 triggers are in `/ship`):
- <`packages/core/`, `packages/db/`, ...>
- <single files: `ops/update-server.sh`, ...>
- `ops/ci-status.sh`, `ops/process-check.mjs`, `ops/process-check.json`, `.github/workflows/`

## Domain checklist

Item 1 of the Tier 2 review and the builder-heavy's extra rules:
- <for example: unknown values stay unknown, never 0 or a guess>
- <for example: money always carries its currency>
- <for example: no look-ahead: a value is read only from the day it was known>

## Owner decides

A closed list: anything not here (or in `/ship` section 4's fixed items) the orchestrator decides
and reports. <What changes the meaning of a number, signal or alert; how money or risk is shown;
which data is trusted. Where something settles an entry (a source, the reference tool, the owner's
cases), name it in the entry: doc review then follows it (`/ship` section 9).>

## Doc levels

Doc review (`/ship` section 9) levels each changed doc hunk by its content; this section only
raises a level.
- Docs: <the paths that hold docs, for example `CLAUDE.md`, `README.md`, `docs/`, the glossary in
  `packages/content/en.json`>. Excluded: <generated files, reviewed through their sources, for
  example `REQUIREMENTS.md`; a license text>.
- Floor: <1, 2 or 3>, the lowest level of any doc hunk not at level 0.
- Paths that raise: <for example `docs/requirements/` at least 2>.
- Reference tool: <the outside tool whose results this project matches, and where its docs are; or
  none>.

## Doc review focus

What the doc reviewers check first here (the agents are generic; this is the project's part):
- <for example: every date rule says which day's value it reads>
- <for example: every amount names its currency, and the rounding where money is split>
- <for example: what each rule does with a missing or unknown input>

## Standing rules

Questions the owner settled once, applied without asking again (dated):
- <2026-01-01: cosmetic reviewer asks: take the recommended option.>

## Texts and time

- User-facing text: <where it lives, e.g. `packages/content/en.json`; other languages may be
  partial>.
- Time zone for dates and day boundaries: <the install's zone, or a fixed one for market dates>.

## CHECKS

`pnpm check:all`

## Models and efforts

The orchestrator passes these values as `model` and `effort` when it starts each agent.

| Role | Model | Effort | Note |
|---|---|---|---|
| builder | sonnet | medium | |
| builder-heavy | opus | high | |
| code-reviewer-light | sonnet | medium | |
| code-reviewer | opus | high | |
| Tier 3: builder-heavy, code-reviewer | opus | xhigh | plan, build, normal and adversarial review |
| ux-reviewer | sonnet | medium | visible changes |
| trust-reviewer | - | - | <used or not, and why> |
| triage | - | - | <used when two or more reviewers ran, or not; doc review at level 2-3 always runs two or more> |
| challenger | opus | high | direction only, on request, at a stage's start or for a new design in Tier 3 |
| summarizer | haiku | low | |
| doc-reviewer-consistency | opus | high | doc level 1-3 |
| doc-reviewer-clarity | sonnet | high | doc level 2; a different model on purpose |
| doc-reviewer-source | opus | high | doc level 3; web tools, as the on-trial derive has |
| doc-reviewer-examples | opus | xhigh | doc level 3 |
| doc-reviewer-adversarial | opus | xhigh | doc level 3 |

## Reviews used

- Tier 0: none. Tier 1: code-reviewer-light (+ ux-reviewer if visible). Tier 2: code-reviewer
  (+ ux-reviewer, trust-reviewer if visible).
- Doc review (`/ship` section 9), in any tier, Tier 0 included: doc level 1 consistency; level 2
  consistency and clarity; level 3 consistency, source, examples and adversarial; triage
  (`Mode: docs`) when two or more ran.
- Tier 3: code-reviewer on the plan, then code-reviewer normal and adversarial, triage
  (+ ux-reviewer, trust-reviewer if visible).
- Owner's actions file: code-reviewer-light with `Mode: actions`, once per task, when items with
  commands changed.
- Page crawler for screenshots: <command, or "not yet">.

## Paths

- Spec template: `docs/spec-template.md`.
- Run logs: `.agent-runs/<date>-<slug>/` (git-ignored).
- Ledgers: `private/ops/agent-ledger.csv` (one row per reviewer run) and
  `private/ops/run-ledger.csv` (one row per task); reviewed docs in `private/ops/doc-reviews.csv`.
- Owner's actions: `private/ops/actions.md` (done items in `actions-done.md`).

## Setup changes

Changes from the setup review (`/ship` section 7), dated, with the reason and the numbers:
- <none yet>
