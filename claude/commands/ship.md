---
description: Build, check, review, triage and fix one task autonomously (projects with docs/agents.md); report once at the end
argument-hint: <what to build or change>
---

Task: $ARGUMENTS

This file is the loop for every project built on the blueprint, used by `/ship` and read by the
main session before any Tier 1-3 work done without `/ship`. The project's `docs/agents.md` (its
profile) gives what differs: risk class, trust-territory paths, models and efforts, owner list,
standing rules, CHECKS, paths. No profile: say so and stop.

Do not message the owner until done, except for an owner stop (section 4). Finish with the
report format from the project's `CLAUDE.md` and nothing else.

## 1. Tier

Decide by the changed files (`git diff --name-only` for the chunk, or the files the spec will
touch). The highest tier among them wins. Log the tier with the file or trigger that decided it.

| Tier | What | Examples | Handling |
|---|---|---|---|
| 0 | Nothing a user, a job or the data can notice | docs, notes, comments, tests only, a rename with unchanged tests, config with no behavior change | no spec; CHECKS only; never reviewed "to be safe" (one exception: `Mode: actions`, section 6) |
| 1 | Behavior changes, none in trust territory | CLI output and glue, dev tooling, ops scripts that write no stored data, UI that shows no numbers, signals or money, new texts | spec; `builder`; CHECKS; `code-reviewer-light` (+ `ux-reviewer` if visible) |
| 2 | Any file on the profile's trust-territory paths, or a new page | data collection and parsing, checks, calculations, money, alerts, auth and access, migrations, backups and restore, imports, deletes, server scripts that deploy or write data | spec; `builder-heavy`; CHECKS; `code-reviewer` (+ `ux-reviewer`, `trust-reviewer` if visible); logic fixes re-reviewed |
| 3 | Tier 2 that the normal loop cannot verify (triggers below) | a backfill on real data, a new hash-chain format, the self-update path, a check's own code | section 2 |

Tier 3 triggers (only these, never mere doubt):
- a. An irreversible action on real data: a rewrite or drop in a migration, a backfill, a bulk
  delete, a restore.
- b. The safety net's own code: data checks, health grading, gates, CI, fault injection, alert
  delivery, this loop's review steps, a reviewer agent's text (section 2, step 7).
- c. An integrity format: hashed or append-only records, canonical serialization, the backup
  format, signatures; authentication or cryptography design (not a routine access check).
- d. A change across repos or the server at once: deploy and self-update, systemd units,
  migration order against a deploy.
- e. A Tier 2 bug still open after 2 fix rounds.

Moves:
- Doubt between 0, 1 and 2: take the higher one.
- A Tier 0 or 1 change that fails CHECKS twice moves up one tier.
- A Tier 2 bug still open after 2 fix rounds moves to Tier 3 (trigger e), not to the owner.
- A Tier 3 change still open after its second approach goes to the owner, with the evidence.

## 2. Tier 3 handling

The strongest automated layer, before anything reaches the owner.
1. Plan: `builder-heavy` (Tier 3 row) writes `.agent-runs/<date>-<slug>/plan.md`: the change,
   how it could fail silently, how it is undone, how it is rehearsed, the expected rehearsal
   output. `code-reviewer` reviews the plan (`Mode: plan`) before any code; one round of plan
   fixes.
2. Build from the plan.
3. Rehearse every irreversible step on a copy (synthetic data or a backup copy) with a tested
   way back; the output must match the plan's expected output. The real run on the server is
   then one owner step with the rehearsal's evidence attached.
4. Safety-net changes (trigger b): fault injection shows every fault caught before is still
   caught.
5. Review in parallel: `code-reviewer` (normal) and `code-reviewer` with `Mode: adversarial`;
   `triage` merges.
6. Fixes: at most 2 rounds. Still open: one different approach or a smaller scope (a new plan,
   the same steps). Still open: to the owner.
7. Setup edits (the loop's review steps, a reviewer's text, the profile's domain checklist):
   `claude/` is live on save, so draft in the run folder. Before it lands or counts as done, rerun
   the drills for the affected reviewers (section 7), a text edit with
   `--agents-dir <draft folder> --reviewer <name>`. A lower caught count than the last complete
   batch goes to the owner with the numbers, quoting the n `drill.mjs compare` printed. The view's
   text hash sees only the reviewer's own file and that checklist, so reports keep a loop edit's
   batch under Open issues until it exists.

## 3. Models and efforts

Use the profile's table exactly, for every agent started (`model` and `effort`). Allowed
changes, only these: a builder that failed twice hands over to `builder-heavy`; the exceptions
the profile's table names (for example auth work at `high`). Never below the table.

## 4. Questions: sort before asking

Every would-be question is one of four kinds; only the last stops anything.
1. A fact: look it up (code, docs, the provider's current docs). Never ask.
2. A convention: take the usual default; list it under "Assumed".
3. A reversible choice: take the recommended option, keep it easy to undo, say so in the report.
4. An owner choice: only what the profile's "Owner decides" lists, plus always: pushing or
   deploying; a new dependency, service or cost; publishing; an irreversible action on real
   data; a conflict with the requirements; a Tier 3 change still open (section 2).

Then:
- The profile's "Standing rules" settle questions the owner already answered once; apply them,
  never ask again. When the owner settles a new kind of question, add it there.
- Never block on the owner: an owner choice goes into the actions file (section C) with a
  recommendation; the work goes on up to that point and with everything else. Everything the
  owner must do or decide goes only in the actions file, never in the report and never mid-run;
  the report says only whether there is anything new there.
- Prefer the route that needs no permission: add-only changes, a setting off by default, a
  dry-run mode, a rehearsal on a copy.
- Steps on the owner's machines: one copy-paste block with the expected output; scripts check
  themselves and print OK or the exact failure.
- A disagreement with a reviewer is settled by a test or the requirements, never by asking.

## 5. The loop

1. Read the current stage or phase and the requirement sections the task touches.
2. Tier (section 1).
3. Tier 1-3: spec in `.agent-runs/<date>-<slug>/spec.md` from the profile's spec template: goal,
   acceptance criteria, the requirement sections it rests on (point, don't copy), pages touched,
   tier. Unclear current-stage details: the conservative reading, under "Assumed". Unclear
   later-stage details: left out and put to the owner.
4. Build chunk by chunk: `builder` for Tier 1, `builder-heavy` for Tier 2 and 3, design, an
   ambiguous spec, or after a builder failed. Give the spec path, the chunk and CHECKS; never
   paste code. Small changes the project's `CLAUDE.md` names, the main session does itself (an
   agent starts cold).
5. Gates: CHECKS; on failure back to the builder, at most 2 tries. Visible changes: the page
   crawler once for the changed pages, when the profile names one.
6. Review: the tier's reviewers in one message (parallel). Code reviewers get the commit range
   (or the working tree), the spec path and the CHECKS output. UX and trust reviewers get only
   screenshot paths and one line per page on its purpose, nothing else.
7. Triage: the main session checks a single reviewer's findings against the code itself;
   `triage` with two or more. Fix what is right, take the recommended option on cosmetic asks,
   skip what is wrong; owner choices to the actions file. Fixes in one batch. Re-review only
   Tier 2 and 3 logic fixes, by the reviewer that found them. At most 2 fix rounds.
8. Commit files by name (never `git add -A`); the owner pushes. Each commit of a Tier 1-3 task ends
   with `Ship-Task: <slug>` (public once pushed: no private names) and `Ship-Tier: <n>`, in one
   paragraph with the attribution. Each task's last commit before a planned push adds `Ship-Reviews:`
   the reviewers that ran (Tier 3: `code-reviewer, triage`); with nothing left to fix, an
   `--allow-empty` commit carries it. A Tier 0 change on a code path (comment only, a rename) carries
   the first two plus `Ship-Tier-Why: <reason>`. When `ops/process-check.json` exists, run
   `node ops/process-check.mjs origin/main` at the task's end, so CI is only the backstop (rules:
   the blueprint's `docs/ci.md`).
9. Log: `.agent-runs/<date>-<slug>/log.md` (tier and why, chunks, gate results, finding counts,
   decisions). One row per reviewer run in the agent ledger and one per task in the run ledger, by
   each file's header row. `model`, `effort`: what the agent was started with. `builder_model`,
   `builder_effort`: the builder that finished the task, blank if none ran. `escape_of`: when the
   task fixes a bug an earlier review let through, that task's slug. Update the actions file
   (section 6).
10. `summarizer` for long logs, check output, crawl reports or pasted server output.

## 6. Writing for the owner (the actions file)

The owner decides from the actions file alone, without asking and without opening other docs.
Each item, 5-20 lines:
- What it is about and why it came up, with the context the owner may not have.
- Every term explained in plain words; numbers with their units.
- What happens now, and what happens if nothing is done.
- The options, each with its risk; the recommendation and why.
- Exactly what to do or answer (a command block marks every part to replace as
  `<<IN_CAPITALS>>`, with a line before it saying what to replace and where to find it).

A command step is run first on a throwaway copy, and its expected output comes from that run. The
copy keeps the real repo's git settings, submodules and remote branches, and a run that should fail
is shown failing. A step that can only run on the server says `Not rehearsed: <why>`. When items with commands were
added or changed: once per task, `code-reviewer-light` with `Mode: actions`, the file's path and the
item ids; one ledger row, reviewer `code-reviewer-light-actions`.

Done items, settled decisions and read comments move to the done file, newest first, dated.

## 7. Setup review (every 10 tasks or every month, whichever comes first)

Read the ledgers and the global view (`node "$T/setup-view.mjs"`, with
`T=$(readlink -f ~/.claude/commands)/../../tools`). When the project has the process check, also
`node ops/process-check.mjs --audit --reviewed <ledger folder>/process-reviewed.txt` and the
process runs since the last review
(`gh run list --workflow Process --limit 100`). Triggers:
- A reviewer over 70% rejected in its last 4 runs (noisy), or with no accepted finding of its
  own in its last 3 (redundant): propose going lighter or dropping it. Not for the challenger
  (section 8).
- Any escape in trust territory: propose going heavier there (model, effort, or a checklist item).
- More than 1 in 5 tasks with `final_tier` above `tier`: propose clearer tier examples or
  trust-territory paths.
- Owner stops rising over 3 reviews: propose standing rules for the repeated kinds.
- Builder retries in more than 1 in 3 tasks: propose a stronger builder or smaller chunks.
- `--audit` shows an open task: run its missing review. Its `unclaimed` commits have no task to
  close, and closing one would need a history rewrite: look at each `unreviewed` one, then add its
  sha to that file; only `unreviewed` above 0 is open. Log the count of red process runs; none at all
  despite pushes: the check may have gone quiet, so look at the workflow.

Each proposal goes into the actions file (section C) with its numbers. The setup changes only
when the owner agrees; the profile's "Setup changes" records the date and the reason. A lesson
that holds for every project goes to the blueprint. A proposal may rest on evidence from other
projects (acceptance only hints; drill scores are the basis for comparing models), but is written
per project, in each affected project's actions file, against its risk class: never below its class
table. A change to the class table itself is a blueprint change the owner approves.

Drills measure what reviews miss (commands, cases, limits: the blueprint's `docs/claude-setup.md`).
- One batch per setup review, per project: 4-6 cases at the profile's models and efforts; others
  only for a named comparison.
- `builder-heavy` writes the cases. The main session never opens them and reads only counts. Never
  tune a reviewer's text to a case; a case seen while editing an agent is retired.
- A batch is one owner command in the actions file, because a session's sandbox refuses the network
  it needs. If `drill.mjs probe` ever exits 0 from a session, that session may run the same command;
  nothing else changes.
- Done only when the view prints `current, scored N of N` for the reviewer: a batch for its own
  text and the domain checklist at the profile's model and effort, covering its active cases. A
  later comparison cannot reopen it. Until then the item stays in the actions file and reports keep
  the view's `no batch for current text` or `batch incomplete` under Open issues. A command written
  is not a batch run. `context changed since the batch of <date>` (the rest of the profile or the
  rules moved) is information only: no item, no Open issue.

## 8. The challenger (direction, not code)

Runs when the owner asks, and at most once at the start of a stage or phase; never per change. Two
steps of one agent: start it with `Step: blind`, the goal and the constraints only (not the current
design); when it returns, continue the same agent with `Step: compare` and the design to read. The
main session judges the verdict: what changes direction or a requirement goes to the owner through
the actions file, ideas to the backlog.

Evaluation: one agent-ledger row per run, reviewer `challenger`: `findings` the approaches
proposed; `accepted` 1 if the run changed a decision, or gave a new reason that settled one (a
well-argued "stay the course" counts), else 0; `rejected` the rest. Its value is irregular, so the
noisy and redundant triggers do not apply and time without a run says nothing. After every 6 runs,
the setup review reports how many of them had `accepted` 1 and the main session's opinion; with none
in 6 it asks the owner whether to keep it. It is never dropped or lightened without the owner.
