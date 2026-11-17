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
(about 700 tokens for all fifteen). An agent's body loads only when it runs. A project that does not
use the loop has no `docs/agents.md`; `/ship` then stops at once.

A project's own `.claude/agents/<name>.md` overrides the shared agent of the same name. Use that
only for a real exception, and say why in the profile.

## Roles and defaults

The loop itself (tiers, Tier 3, questions, the owner's actions file, the setup review) is in
`commands/ship.md`, the one copy every project follows.

The model and effort in each agent's frontmatter are defaults. The profile's "Models and
efforts" table overrides them per project; the orchestrator passes the table's values as `model`
and `effort` when it starts an agent, and never goes below them.

| Agent | Default | For |
|---|---|---|
| builder | Sonnet, medium | Tier 1 chunks: glue, texts, docs, tests, UI without risky logic |
| builder-heavy | Opus, high | Tier 2 and 3, design, an ambiguous spec, after the builder failed; Tier 3 plans |
| code-reviewer-light | Sonnet, medium | Tier 1 review |
| code-reviewer | Opus, high | Tier 2 review; Tier 3 plan, normal and adversarial reviews |
| ux-reviewer | Sonnet, medium | visible changes, from screenshots only |
| trust-reviewer | Sonnet, medium | visible changes showing numbers, money or risk (projects that need it) |
| triage | Opus, medium | merging two or more reviewers' findings |
| challenger | Opus, high | a second opinion on direction, on request, at a stage's start or for a new design in Tier 3 (`commands/ship.md` section 8) |
| summarizer | Haiku, low | long logs, check or crawl output, pasted server output |
| doc-reviewer-consistency | Opus, high | doc level 1-3: contradictions with the requirements, other docs, rules and code (`commands/ship.md` section 9) |
| doc-reviewer-clarity | Sonnet, high | doc level 2: where two builders would build it differently, from the text alone |
| doc-reviewer-source | Opus, high | doc level 3: claims against outside authorities, each with a quoted line or `not read`; web tools, as derive has |
| doc-reviewer-examples | Opus, xhigh | doc level 3: recomputes stated numbers and typical cases from the doc alone |
| doc-reviewer-adversarial | Opus, xhigh | doc level 3: edge inputs and readings every test written from the doc would pass |
| doc-reviewer-derive | Sonnet, high | on trial, doc drills only: derives a rule blind from the question a section answers |

The orchestrator is the main session, not an agent: Opus at high effort (the owner picks it). It
holds the context, writes specs, judges findings and talks to the owner; a weaker model there
makes every agent worse. It does small changes itself, since an agent starts cold and re-reads
the rules, the spec and the code.

## Choosing per project: the risk class

Each profile names one risk class, chosen once when the project starts; the class fixes the
table. Only the setup review (`commands/ship.md` section 7) changes it, with the owner's yes.

- **A, silent and lasting**: money or tax, append-only or hash-chained records, signals people
  act on; a bug cannot be recomputed away.
- **B, recomputable**: derived values are rebuilt from kept raw data, so a bug costs a few wrong
  days; user accounts or access may still exist.
- **C, low stakes**: small tools, no user data, no money.

| Role | A | B | C |
|---|---|---|---|
| builder | Sonnet medium | Sonnet medium | Sonnet medium |
| builder-heavy | Opus high | Opus medium (high for auth and access) | Sonnet high |
| code-reviewer-light | Sonnet medium | Sonnet medium | Sonnet medium |
| code-reviewer | Opus high | Opus medium (high for auth and access) | Sonnet high |
| Tier 3: builder-heavy, code-reviewer | Opus xhigh | Opus xhigh | Opus high |
| ux-reviewer, trust-reviewer | Sonnet medium | Sonnet medium | Sonnet medium |
| triage | Opus medium | Opus medium | Sonnet medium |
| challenger | Opus high | Opus high | Sonnet high |
| summarizer | Haiku low | Haiku low | Haiku low |
| doc-reviewer-consistency | Opus high | Opus medium | Sonnet high |
| doc-reviewer-clarity | Sonnet high | Sonnet medium | Sonnet medium |
| doc-reviewer-source | Opus high | Opus high | Sonnet high |
| doc-reviewer-examples | Opus xhigh | Opus high | Opus high |
| doc-reviewer-adversarial | Opus xhigh | Opus high | Opus high |
| doc-reviewer-derive | Sonnet high | Sonnet high | Sonnet high |

Why:
- Opus where correctness depends on reasoning across files; Sonnet for contained work.
- The higher effort where a miss is silent; `medium` where a miss shows up or is recomputed.
- Auth and access at `high` in class B: a leak between accounts cannot be recomputed away.
- Never Haiku for code or review; Haiku only for mechanical summaries.
- `max` is not used by default (much more cost for little over `xhigh`); the owner may ask for it
  on one run.
- A trust reviewer only when pages show numbers people act on; otherwise the UX reviewer also
  asks the trust question (one run fewer per change).
- Triage only when two or more reviewers ran; otherwise the orchestrator triages.
- The challenger does not follow the class's code-reviewer in class B: a wrong direction is not
  recomputed away, and it runs rarely, so `high` costs little. `xhigh` adds little here: it needs
  range, not checking.
- Doc reviewers: code and tests are written from the docs, so a wrong rule passes every test. Six
  agents, not one with modes: their tools differ (only the source reviewer and the on-trial derive
  reviewer get web tools), and each has its own ledger rows, so overlap between them shows up in the
  noisy and redundant triggers.
- `doc-reviewer-consistency` follows the class's code-reviewer row: it reads across files the same
  way.
- `doc-reviewer-clarity` is on Sonnet in every class, on purpose: most docs are written by Opus
  sessions, and a different model reads the text more like a different builder would. It never
  reads code. `doc-reviewer-derive`, on trial, is on Sonnet high in every class for the same reason,
  so a drill's result does not depend on the class.
- `doc-reviewer-examples` and `doc-reviewer-adversarial` stay on Opus in every class: recomputing
  numbers and finding the reading every test passes is reasoning, a miss is silent in any class,
  and they run only at doc level 3. `xhigh` in class A, as for Tier 3 code.
- `doc-reviewer-source` at `high`, not `xhigh`, in A and B: it needs careful reading and quoting,
  not depth. Its web queries carry only the name of a paper, standard or term.
