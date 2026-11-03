# Shared Claude Code agents

One set of agents for every project built on this blueprint, linked into `~/.claude` by
`install.sh` (master copies stay here, versioned). Each project adds only a short agent profile,
`docs/agents.md` (template: `../templates/docs/agents.md`), that tells the agents what the app is,
what can go wrong, where its rules are, and which model and effort each role uses there.

## Why shared

The agents of the first two projects were 90% the same text; the rest was project context (the
app, its trust territory, its domain checklist, its rules files). Shared agents keep one copy of
the loop and its lessons (for example: restore probes with `git checkout`, never `cp`), and a
project changes only its profile.

Context cost: every session, in every project, loads only each agent's one-line description
(about 400 tokens for all eight). An agent's body loads only when it runs. A project that does not
use the loop has no `docs/agents.md`; `/ship` then stops at once.

A project's own `.claude/agents/<name>.md` overrides the shared agent of the same name. Use that
only for a real exception, and say why in the profile.

## Roles and defaults

The model and effort in each agent's frontmatter are defaults. The profile's "Models and
efforts" table overrides them per project; the orchestrator passes the table's values as `model`
and `effort` when it starts an agent (the profile asks for this explicitly).

| Agent | Default | For |
|---|---|---|
| builder | Sonnet, medium | routine chunks: glue, texts, docs, tests, UI without risky logic |
| builder-heavy | Opus, high | trust territory, design, an ambiguous spec, after the builder failed |
| code-reviewer-light | Sonnet, medium | Tier 1 review |
| code-reviewer | Opus, high | Tier 2 review |
| ux-reviewer | Sonnet, medium | visible changes, from screenshots only |
| trust-reviewer | Sonnet, medium | visible changes showing numbers, money or risk (projects that need it) |
| triage | Opus, medium | merging two or more reviewers' findings |
| summarizer | Haiku, low | long logs, check or crawl output, pasted server output |

The orchestrator is the main session, not an agent: Opus at high effort (the owner picks it). It
holds the context, writes specs, judges findings and talks to the owner; a weaker model there
makes every agent worse. It does small changes itself, since an agent starts cold and re-reads
the rules, the spec and the code.

## Choosing per project

Go heavier where a mistake is silent and lasting; lighter where it is visible or recomputed.

- **Heavy** (Opus, high for builder-heavy and code-reviewer): append-only or hash-chained
  records, money and tax, signals people act on, anything that cannot be recomputed after a bug.
- **Medium** (Opus, medium): derived values are recomputed from kept raw data, so a bug costs a
  few wrong days. Keep `high` for auth and access (a leak between accounts cannot be recomputed
  away).
- **Light** (Sonnet for everything but the orchestrator): small tools, no user data, no money.
- Not Haiku for code review: review needs reasoning across files. Haiku only for mechanical
  summaries.
- A trust reviewer only when pages show numbers people act on; otherwise the UX reviewer also
  asks the trust question (one run fewer per change).
- Triage only when two or more reviewers ran and their areas overlap; otherwise the orchestrator
  triages.

## Revisiting

Every reviewer run is one row in the project's private ledger
(`date,slug,tier,reviewer,findings,accepted,rejected,duplicate`). Every 10 runs of a kind the
orchestrator reads it: a reviewer is noisy when over 70% of its findings were rejected in its last
4 runs, redundant when it had no accepted finding in its last 3 runs (or each was also found by
another reviewer). Noisy or redundant: propose going lighter. A bug a light review let through:
propose going heavier. Changes go to the profile's table, not to these files, unless the lesson
holds for every project.
