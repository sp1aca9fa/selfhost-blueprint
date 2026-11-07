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
  verify (irreversible actions on real data, the safety net's own code, including the loop's review
  steps and a reviewer's text, integrity formats, changes across repos or the server, a Tier 2 bug
  open after 2 rounds): a reviewed plan, a rehearsal on a copy, a second adversarial review, one
  different approach before the owner.
- **Models and efforts** exactly from the profile's table (set once from the risk class,
  [claude/README.md](../claude/README.md)).
- **Questions sorted before asking**: facts are looked up, conventions and reversible choices
  are taken and reported; only the profile's closed owner list and a few fixed items stop work,
  and even those never block other work. Settled answers become standing rules.
- **The loop steps**: spec, build, gates, review, triage, commit by name with trailers, logs.
- **Writing for the owner**: each actions item 5-20 lines, enough to decide on alone; command steps
  rehearsed on a throwaway copy or marked `Not rehearsed: <why>`.
- **The setup review** every 10 tasks or every month: fixed triggers on the ledgers, the global
  view, the process audit, one batch of drills; proposals with their numbers to the owner, changes
  recorded in the profile. The setup is fixed between reviews, never frozen.

## The owner's files (private ops)

The owner's single place for anything to do or decide is `actions.md`; Claude reads it at the
start of every session and updates it after every piece of work.

- `actions.md`: only what waits on the owner. A. steps to run (commands, where), B. checks in the
  app, C. decisions needed, D. comments to know, F. work log since their last review. Each item
  5-20 lines, enough to decide on without asking or opening other docs (`/ship` section 6).
- `actions-done.md`: what the owner marked done or decided, newest first, dated; the work log.
- `notes.md`: the owner's setup, sources' quirks, Claude's own to-dos.
- `agent-ledger.csv`: one row per reviewer run,
  `date,slug,tier,reviewer,findings,accepted,rejected,duplicate,model,effort,severe,fix_caused`.
- `run-ledger.csv`: one row per task,
  `date,slug,tier,final_tier,builder_retries,checks_failures,fix_rounds,owner_stops,escape_of,builder_model,builder_effort`.
- `drill-ledger.csv`: one row per case run, appended only by the runner,
  `date,case,kind,reviewer,model,effort,tier,planted,caught,other_findings,batch,batch_cases,agent_text,malformed,context_text,case_hash`.
- `drills/<id>/`: the drill cases and their keys, never public.
- `process-reviewed.txt`: one sha per line, commits the process audit lists that a session has looked
  at. A session adds a sha only after looking at that commit.

Rows written before the `model`, `builder_model`, `severe` and `fix_caused` columns stay as they
are, at their old width: never guessed or backfilled. A reader goes by the header row.

## Checking the setup itself

An instruction alone does not show that it was followed, or that it works. Four checks, none of
which changes what a reviewer looks for:

- **Process check** ([ci.md](ci.md), "Process check"): commit trailers against the changed files, in
  CI. It catches a forgotten review, not a false claim, and it never holds back a server.
- **Owner steps** (`/ship` section 6): a command step is run on a throwaway copy before it is
  written, and `code-reviewer-light` in `Mode: actions` reads the actions file for contradictions,
  wrong order and stale values. It runs once per task, only when items with commands changed, and
  its ledger rows use the reviewer name `code-reviewer-light-actions`, so they stay apart from code
  reviews. Limit: no check can see a rehearsal that was skipped; `Not rehearsed` lines are only
  visible.
- **Drills**, below: what reviews miss, scored by a script rather than by the session.
- **The global view**, below: counts across projects, for the setup review.
- **The spend view** (`tools/spend-view.mjs`): where one project's tokens went, from its transcripts,
  with no model calls: main session and agents, by role and by task, and the pools that can shrink
  (cache misses, polling, builders before their first edit, context over 200k). Run it from the
  project's folder or with `--project`. It shows the shape of the spend, not a bill, and it says
  nothing about quality; only drills do that. Task rows start with tasks begun after 2026-11-07,
  when agent descriptions began carrying the slug.

An edit to the loop's review steps or to a reviewer's text is Tier 3 trigger b, and must rerun the
drills for the affected reviewers before it counts as done (`/ship` section 2).

### Drills

A case is a real past change with a known bug: `replay` (a commit from before a review fix) or
`planted` (a bug added to a real change). Each lives in `<ledger folder>/drills/<id>/`, in the
private repo:

```json
{ "id": "s03", "kind": "replay", "reviewer": "code-reviewer", "tier": 2,
  "base": "<sha>", "buggy": "<sha>", "fix": "<sha>", "added": "2026-01-01", "retired": null,
  "checks": "pnpm check:all: pass",
  "bugs": [{ "id": "b1", "what": "<one line>",
             "windows": [{ "file": "packages/x/y.ts", "from": 118, "to": 131, "anchor": "<sha256>" }] }] }
```

Beside `case.json`: `spec.md`, and for `planted`, `planted.patch` applied on `buggy` (`fix` is
null). A bug may have several windows, at most 40 lines each, because a finding at the caller can
name the same bug as one at the callee. Windows are fixed when the case is written. `anchor` hashes
the window's text, so a stale line number leaves the case unscored instead of reading as a miss.
`validate` refuses a bug whose windows cover more than half of the change's added lines: almost any
finding would catch it.

`builder-heavy` writes the cases, using `validate --show-anchors`. A spec is copied from the run
folder only if its modified time predates the `buggy` commit; otherwise it is written from the real
commit's message; either way `validate` checks it for leaks. The main session never opens a case and
reads only counts. A case seen while editing an agent is retired (`retired` gets the date), and a
window never changes after a run. Scores stay out of the agent ledger's accepted and rejected
counts.

Only `code-reviewer` and `code-reviewer-light` have cases. `ux-reviewer`, `trust-reviewer`, `triage`
and `challenger` give no `file:line` answer to score, and adversarial mode shares `code-reviewer`'s
text.

The commands, with `T=$(readlink -f ~/.claude/commands)/../../tools`:

```bash
node "$T/drill.mjs" validate --repo . --ledger-dir <ledger folder>    # no tokens; a session runs it
node "$T/drill.mjs" run --repo <project> --ledger-dir <ledger folder> --batch <new name>
node "$T/drill.mjs" run --repo <project> --ledger-dir <ledger folder> --resume <batch>
node "$T/drill.mjs" compare --ledger-dir <ledger folder> --a <last batch> --b <new batch>
node "$T/drill.mjs" score --ledger-dir <ledger folder> --raw <one case's raw folder> [--write]
node "$T/drill.mjs" probe
```

`run` also takes `--agents-dir <folder>` (a draft text, so it never goes live to be measured),
`--reviewer <name>` (its cases only), `--model` and `--effort` (a named comparison only),
`--case a,b`, `--test-allow <rule>` and `--install <command>`. Raw answers go to `.agent-runs/<date>-<batch>/` in the project; the runner
refuses to start unless that folder is git-ignored. `score` scores a saved answer again with no
tokens.

`--resume` continues a batch instead of starting one, so one blank does not cost a whole new batch: the
same name and `batch_cases`, only that batch's blank or unplanned cases, each in a new raw folder. Give
the same `--reviewer` and `--case` as the batch. It refuses if `agent_text`, the model, the effort or a
`case_hash` differs. A model alias that moved can only be seen after the run, so that row is written
blank at one run's cost. Nothing left to run prints the batch's line and spends nothing.

**How a batch runs.** The reviewer must be a fresh process working inside a throwaway clone: an
Agent-tool reviewer shares the session's folder, so it would see today's code with the bug already
fixed. That process needs the model API, and a session's sandbox has so far refused it (a denied
connection, then a timeout). So a batch is one command the owner runs in their own terminal,
unattended: the session runs `validate`, then writes the `run` command into the actions file with
`Not rehearsed: the sandbox refuses the model API` and its cost (rough, not measured: 0.4-0.7M fresh
tokens for 6 cases; each case's raw `answer.json` holds what the run used). The sandbox is not
loosened for this.

`run` starts with the boundary check, the same one `probe` runs, and prints
`batch <name>: not started, the boundary check did not pass` if a reviewer could read outside its
clone, could not make the reads it needs inside it, or the check could not start. The inside half is
a positive control: `git show HEAD:README.md` and `Read README.md` must bring back a second sentinel
with no denial, so a check that refuses everything does not read as a pass. The probe also records,
as `globalRules`, whether `~/.claude/CLAUDE.md` reached that process, from the process's own one-word
answer: a record, not a gate, and none of that file's text enters the output; and, as `pipedRead`,
whether `git log --oneline -1 | cat` was denied, also not a gate. `run` stops at the first
unscored case and ends with `batch <name>: scored <n>, batch_cases <m>`, exiting 0 only when the two
are equal.

A session does not retry `probe` as a habit: it costs a 5-minute timeout, or about 10k tokens if it
gets through. If it ever exits 0 from a session, that session may run the same `run` command itself;
nothing about scoring or reporting changes. A timeout counts as refused, and the batch stays an
owner command.

**Scoring** is by script, from `[bug|fix|ask] file:line:` findings. A bug is caught when any finding
of at most 40 lines overlaps any of its windows. A wider finding counts as `other`, so a wide finding
on the real bug reads as a miss. Findings outside every window are counted, not judged; a line that
starts like a finding but has no `file:line` counts as `malformed`.

A case is scored only when the JSON status shows success, the answer's last non-empty line starts
`Biggest win:` (one report sentence, `No new actions raised.` or `New actions from this round are in
...`, may follow it), no required read was denied, the model matches and the anchors held. A denied
bare `git diff`, `log` or `show` is a required read: no shell operator, no global option, no deny-list
match. A piped or retried command is not, since the bare read stayed open to it; a denial matching the
deny list is the boundary working. Neither stops anything. A Bash denial with no readable command
stays unknown.

When `caught` is below planted, it is also unknown if an unreadable location could be a file with a
bug: a finding's path that is a suffix or base name of a window's file, or that whole path under
another prefix; a malformed line naming such a path; a line that opens with a recognized tag and
names no file. The miss could be the parser's. A finding on another real file, prose, a wrapped line,
a table row and test output stay scored: the rule runs only below planted, so anything wider would
drop only misses and make recall read high. The reviewed tree's file list (both sides of the range
and the spec, in the raw `meta.json`) only narrows it: a path that is itself another listed file is
that file. Otherwise `caught` is blank: unknown, never 0. A batch counts only when every planned case
is scored (`batch_cases`).

**What stays blind.** The clone holds the base, today's `docs/agents.md` and `CLAUDE.md`, and the
change as one commit dated today; no remote, no other refs, no submodules. The script refuses to
start if a later commit or the fix's added lines are reachable there. The prompt has the normal
three inputs. A reviewer must not be told it is being measured, so the runner refuses to start if
the word `drill` is in the profile, the agent text, the spec, the prompt or the folder name.
`CLAUDE.md` is overlaid too but not scanned: keep the word out of it as well.

**Comparing.** `compare` uses only cases scored in both batches, per case and per reviewer, never
summed across reviewers, and says when fewer than 3 are common. It prints each side's model and
effort, and labels a pair that differs in model, effort, `agent_text` or `context_text`; such a pair
stays in the totals. Only a `case_hash` mismatch (the case itself changed) leaves them. A lower count
goes to the owner with
the n compared, and n matters: with no real change at 70% true recall, the second of two runs is
lower 35% of the time at n=4 and 29% at n=2.

Limits:
- Replayed bugs are ones a reviewer already caught, so recall reads high. Planted bugs are written
  by the same model family.
- A finding inside a window about something else still counts as caught. A finding over 40 lines on
  the real bug reads as a miss, and only a reader of the raw answer can tell. Many narrow findings
  are counted as other, not capped.
- A blank arises only on a doubtful miss, so a resume re-draws misses and never catches, and a resumed
  score can read high. `compare` marks such a case `[resumed]` and says so on the totals line. The
  view's status line does not mark it.
- Only the first `path:line` of a finding is read, so `z.ts:3, y.ts:120: ...` is scored on `z.ts`. A
  tagged line with no file blanks the case, unless a word in it looks like a file
  (`price/volume ratio ...`), when it reads as a miss with `malformed 1`. Both can turn a catch into a
  miss. Check the raw answers after the first real batch, and fix them if they occur.
- The clone has no private rules file, so the review is slightly weaker than a real one.
- The reviewer may know the programme exists (this file is public), and a model may still guess.
- The requested effort cannot be verified from the output; the model can.

### The global view

`node "$T/setup-view.mjs"` scans the blueprint's parent folder (`--root <folder>` for another) for
`*/docs/agents.md`, one level down, reads each profile's risk class and ledger paths, and prints
counts grouped by class, reviewer, model, effort and tier. Each project's ledgers stay the only
record. It prints no slugs, case ids, hashes or file contents.

- Groups are never merged. Under 10 runs, or under 10 planted bugs, a group is marked `too few`.
- Rows with no model are counted and excluded. A row of neither the old nor the new width is
  `malformed`: counted and excluded. A missing ledger is `no ledger`, not zero.
- Acceptance is labeled a hint only. Drill scores are the basis for comparing models. In the agent
  ledger `model` is the profile's alias, so `opus` spans versions; the drill ledger stores the
  concrete id.
- For each project and drilled reviewer it reads three hashes from the ledger. `agent_text` covers
  the reviewer's own agent file and the profile's `## Domain checklist` section (none hashes as
  empty), because the checklist is the reviewer's first criterion; `case_hash` the case's `case.json`,
  `spec.md` and `planted.patch`; `context_text` the project's `docs/agents.md` and `CLAUDE.md`, and
  `~/.claude/CLAUDE.md`, when present.
- A resumed batch is one batch: the latest row per batch and case counts, everywhere, so a blank that
  later scored is not counted twice. The totals line prints `superseded N`, so the difference from the
  CSV's own rows is visible.
- It takes the latest batch for the current text at the profile's model and effort that covers all
  the reviewer's active cases at their current `case_hash`: `current, scored <n> of <n>`. Otherwise
  `batch incomplete, scored <n> of <m>`, or `no batch for current text`, which a changed model or
  effort row in the profile also gives, because those settings have no batch yet. For tier 3 the row
  is the `Tier 3:` row if it lists the reviewer, otherwise the role's row.
- A later named comparison at other settings is ignored and cannot reopen an owner item. A `--case`
  run covers one case, so it satisfies this only for a reviewer with one active case.
- A context difference prints one line, `context changed since the batch of <date>`: information
  only, no actions item, no Open issue.
- A batch that did not run stays visible this way, and reports keep the line under Open issues until
  the batch exists; a command written is not a batch run. A loop edit changes no hash, so the view
  cannot see it: reports carry that batch by name instead. For a draft text, pass the same
  `--agents-dir` as the batch.

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
