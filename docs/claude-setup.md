# Claude Code setup

## Public and private rules

- **`CLAUDE.md` is committed.** It holds the generic rules: reading protocol, pillars, working
  rules, data rules, the agents loop, tiers, report format, style. Anyone who clones the repo
  (and the owner on a new machine) gets a working setup. Template: `templates/CLAUDE.md`.
- **Private rules** live in the private submodule (`private/ops/claude-rules.md`): where the
  owner's notes are, private names to keep out of public files, sources' special terms, the
  owner's machines and commands. `CLAUDE.local.md` (git-ignored) is one line importing it:
  `@private/ops/claude-rules.md`.
- **Global preferences** (every project) are in `~/.claude/CLAUDE.md`: few tokens, no em dashes,
  no emoji, and restating each item before commenting on it.
- The global git ignore (`~/.gitignore_global`) lists only `CLAUDE.local.md`,
  `.claude/settings.local.json`, `.mcp.json` (it may hold keys) and tool scratch folders.

Rule of thumb: if a rule names something private (a shop, a host, a person, an account), it is
private; otherwise it is public.

## Agents

Shared agents (this repo's `claude/`), one profile per project (`docs/agents.md`, template in
`templates/docs/agents.md`). The profile says what the app is and its worst failure, the rules
files, the trust territory, the domain checklist, what the owner decides, where texts go, the
CHECKS command, the model and effort per role, which reviews are used, and the paths of the
spec template, run logs, ledger and actions file. Why and how to choose models:
[claude/README.md](../claude/README.md).

## The loop (`/ship <task>`)

1. **Spec** (Tier 1 and 2) in `.agent-runs/<date>-<slug>/spec.md`: goal, acceptance criteria, the
   requirement sections it rests on (pointed to, not copied), pages touched, tier, "Assumed".
2. **Build**: `builder` for routine chunks, `builder-heavy` for trust territory. Small changes
   the orchestrator may do itself (each project's `CLAUDE.md` says how small).
3. **Gates**: CHECKS; the page crawler for visible changes (phone, wide, dark, each language).
4. **Review by tier**, reviewers in parallel, each with only its allowed inputs (code reviewers:
   commit range, spec, CHECKS output; UX and trust reviewers: screenshots and one line per page).
5. **Triage**: the orchestrator alone with one reviewer, `triage` with two or more. Act without
   asking: fix what is right, take the recommended option on cosmetic asks, skip what is wrong;
   anything the owner decides goes to them. Fixes in one batch; re-review only Tier 2 logic
   fixes; at most 2 rounds.
6. **Commit** files by name (never `git add -A`); the owner pushes. Run log in `.agent-runs/`,
   one ledger row per reviewer run, the owner's actions file updated.

| Tier | When | Review |
|---|---|---|
| 0 | docs, comments, config with no behavior change, tests only | none; CHECKS only |
| 1 | product code outside trust territory | code-reviewer-light (+ UX if visible) |
| 2 | trust territory | code-reviewer (+ UX, trust if visible) |

A Tier 0 or 1 change that fails CHECKS twice moves up a tier. Never review Tier 0 "to be safe".

**Stop and ask** only for: destructive or irreversible actions, pushing or deploying, new
dependencies (MIT, Apache 2.0, BSD, ISC only), external services or costs, conflicts with the
requirements, the profile's "Owner decides" items, two failed fix rounds.

## The owner's files (private ops)

- `actions.md`: only what waits on the owner. A. steps to run (commands, where), B. checks in the
  app, C. decisions needed, D. comments to know, F. work log since their last review. Each
  decision: 10-20 lines for a non-technical reader (terms explained, what happens now, the
  proposal, the risk either way, a recommendation). Commands mark every part to replace as
  `<<IN_CAPITALS>>`, with a line before saying what to replace and where to find it.
- `actions-done.md`: what the owner marked done or decided, newest first, dated; the work log.
- `notes.md`: the owner's setup, sources' quirks, Claude's own to-dos.
- `agent-ledger.csv`: `date,slug,tier,reviewer,findings,accepted,rejected,duplicate`.

## The report

After each task, short, no step recap:
```
Done: <what changed; tier and why>
Tested: <checks and tests; what was not tested>
Needs you: <decisions and blockers, each restated, with a recommendation; or nothing>
Open issues: <unresolved after 2 rounds, known limits; or none>
Assumed: <assumptions about data, calculations, users (tax with the rule it rests on); or none>
Backlog ideas: <or none>
Reviewers: <each that ran: findings N, accepted N; useful, noisy or redundant>
```

## Server output

Claude's sandbox does not reach the home server. The owner runs commands there and pastes the
output, or saves it under `private/ops/server-output/<date>-<name>.txt`. Long output goes to the
`summarizer` agent first.
