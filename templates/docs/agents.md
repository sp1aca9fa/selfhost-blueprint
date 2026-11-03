# Agent profile

Read by the shared agents (see the blueprint's `claude/README.md`) and by the orchestrator. Keep
it short: the agents read it on every run.

## The app

<One paragraph: what the app does, for whom, and the worst failure (the mistake that hurts most).>

## Rules files

- Public: `CLAUDE.md`.
- Private: `private/ops/claude-rules.md` (read it if it exists; it is not in the public repo).

## Trust territory (Tier 2)

<List the areas where a mistake is silent or lasting: data collection and parsing, calculations,
money, alerts, auth and access checks, migrations, backups and restore, imports, deletes, server
scripts.>

## Domain checklist

Item 1 of the Tier 2 review and the builder-heavy's extra rules:
- <for example: unknown values stay unknown, never 0 or a guess>
- <for example: money always carries its currency>
- <for example: no look-ahead: a value is read only from the day it was known>

## Owner decides

Builders and triage stop and ask on: <what changes the meaning of a number, signal or alert; how
money or risk is shown; which data is trusted; anything public or costing money>.

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
| ux-reviewer | sonnet | medium | visible changes |
| trust-reviewer | - | - | <used or not, and why> |
| triage | - | - | <used when two or more reviewers ran, or not> |
| summarizer | haiku | low | |

## Reviews used

- Tier 0: none. Tier 1: code-reviewer-light (+ ux-reviewer if visible). Tier 2: code-reviewer
  (+ ux-reviewer, trust-reviewer if visible).
- Page crawler for screenshots: <command, or "not yet">.

## Paths

- Spec template: `docs/spec-template.md`.
- Run logs: `.agent-runs/<date>-<slug>/` (git-ignored).
- Ledger: `private/ops/agent-ledger.csv`.
- Owner's actions: `private/ops/actions.md` (done items in `actions-done.md`).
