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
  no emoji, restating each item before commenting on it, and reports that hold no actions: what
  the owner must do or decide goes only in the actions file, and the report says whether there is
  anything new there.
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

One copy for every project: [claude/commands/ship.md](../claude/commands/ship.md), linked into
`~/.claude/commands`. Projects point to it from their `CLAUDE.md` instead of repeating it, so a
session loads it only when it does agent work. It holds:

- **Tiers 0-3**, decided by the changed files against the profile's trust-territory paths; the
  highest wins, doubt goes up, the deciding file is logged.
- **Tier 3**: the strongest automated layer before the owner, for what the normal loop cannot
  verify (irreversible actions on real data, the safety net's own code, integrity formats,
  changes across repos or the server, a Tier 2 bug open after 2 rounds): a reviewed plan, a
  rehearsal on a copy, a second adversarial review, one different approach before the owner.
- **Models and efforts** exactly from the profile's table (set once from the risk class,
  [claude/README.md](../claude/README.md)).
- **Questions sorted before asking**: facts are looked up, conventions and reversible choices
  are taken and reported; only the profile's closed owner list and a few fixed items stop work,
  and even those never block other work. Settled answers become standing rules.
- **The loop steps**: spec, build, gates, review, triage, commit by name, logs.
- **Writing for the owner**: each actions item 5-20 lines, enough to decide on alone.
- **The setup review** every 10 tasks or every month: fixed triggers on both ledgers, proposals
  with their numbers to the owner, changes recorded in the profile. The setup is fixed between
  reviews, never frozen.

## The owner's files (private ops)

The owner's single place for anything to do or decide is `actions.md`; Claude reads it at the
start of every session and updates it after every piece of work.

- `actions.md`: only what waits on the owner. A. steps to run (commands, where), B. checks in the
  app, C. decisions needed, D. comments to know, F. work log since their last review. Each item
  5-20 lines, enough to decide on without asking or opening other docs (`/ship` section 6).
- `actions-done.md`: what the owner marked done or decided, newest first, dated; the work log.
- `notes.md`: the owner's setup, sources' quirks, Claude's own to-dos.
- `agent-ledger.csv`: one row per reviewer run,
  `date,slug,tier,reviewer,findings,accepted,rejected,duplicate`.
- `run-ledger.csv`: one row per task,
  `date,slug,tier,final_tier,builder_retries,checks_failures,fix_rounds,owner_stops,escape_of`.

## The report

After each task, short, no step recap:
```
Done: <what changed; tier and why>
Tested: <checks and tests; what was not tested>
Actions: <"New actions from this round are in <the actions file>." or "No new actions raised.">
Open issues: <unresolved after 2 rounds, known limits; or none>
Assumed: <assumptions about data, calculations, users (tax with the rule it rests on); or none>
Backlog ideas: <or none>
Reviewers: <each that ran: findings N, accepted N; useful, noisy or redundant>
```

## Server output

Claude's sandbox does not reach the home server. The owner runs commands there and pastes the
output, or saves it under `private/ops/server-output/<date>-<name>.txt`. Long output goes to the
`summarizer` agent first.
