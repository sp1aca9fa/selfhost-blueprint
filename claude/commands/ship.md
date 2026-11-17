---
description: Build, check, review, triage and fix one task autonomously (projects with docs/agents.md); report once at the end
argument-hint: <what to build or change>
---

Task: $ARGUMENTS

This file is the loop for every project built on the blueprint, used by `/ship` and read by the
main session before any Tier 1-3 work done without `/ship`, and before any doc change at doc level
1-3 (section 9). The project's `docs/agents.md` (its profile) gives what differs: risk class,
trust-territory paths, models and efforts, owner list, standing rules, CHECKS, paths. No profile:
say so and stop.

Section 9 (doc review), and every rule here that names it or a doc level, applies only in a project
that has adopted it: its `CLAUDE.md` points to section 9 ("after adoption" means from that commit).
Elsewhere those rules are skipped and docs stay plain Tier 0. Adopted, but the profile has no "Doc
levels": say so and stop.

Do not message the owner until done, except for an owner stop (section 4). Finish with the
report format from the project's `CLAUDE.md` and nothing else.

## 1. Tier

Decide by the changed files (`git diff --name-only` for the chunk, or the files the spec will
touch). The highest tier among them wins. Log the tier with the file or trigger that decided it.

| Tier | What | Examples | Handling |
|---|---|---|---|
| 0 | Nothing a user, a job or the data can notice | docs, notes, comments, tests only, a rename with unchanged tests, config with no behavior change | no spec; CHECKS only; never reviewed "to be safe" (exceptions: `Mode: actions`, section 6; doc review, section 9) |
| 1 | Behavior changes, none in trust territory | CLI output and glue, dev tooling, ops scripts that write no stored data, UI that shows no numbers, signals or money, new texts | spec; `builder`; CHECKS; `code-reviewer-light` (+ `ux-reviewer` if visible) |
| 2 | Any file on the profile's trust-territory paths, or a new page | data collection and parsing, checks, calculations, money, alerts, auth and access, migrations, backups and restore, imports, deletes, server scripts that deploy or write data | spec; `builder-heavy`; CHECKS; `code-reviewer` (+ `ux-reviewer`, `trust-reviewer` if visible); logic fixes re-reviewed |
| 3 | Tier 2 that the normal loop cannot verify (triggers below) | a backfill on real data, a new hash-chain format, the self-update path, a check's own code | section 2 |

Tier 3 triggers (only these, never mere doubt):
- a. An irreversible action on real data: a rewrite or drop in a migration, a backfill, a bulk
  delete, a restore. Exception: in a class B project, a one-off meeting every condition of the
  recoverable route (end of section 2) is Tier 2 with that route's steps; section 4 still applies.
- b. The safety net's own code: data checks, health grading, gates, CI, fault injection, alert
  delivery, any edit to this file or to a shared agent's text (section 2, step 7).
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

The shared setup (the blueprint, `B=$(readlink -f ~/.claude/commands)/../..`): an edit to this file
or a shared agent's text is trigger b, and so is a tools edit that changes how drills are scored,
a hash, or what the setup view calls current (section 2, step 4 is shown by the tools' existing
planted-miss tests). Any other edit to its tools alone is Tier 2, reviewed by `code-reviewer` at the
project's row. CHECKS for any blueprint edit: `node --test` on
`$B/tools/*.test.mjs`, with `SHIP_MD=<draft>` while this file is a draft, and again once it lands.
Owner items about the shared setup go only to `$B/private/global-actions.md`, never to a project's
actions file.

## 2. Tier 3 handling

The strongest automated layer, before anything reaches the owner.
1. Plan (a new design first runs the challenger's blind step, section 8): `builder-heavy` (Tier 3 row) writes `.agent-runs/<date>-<slug>/plan.md`: the change,
   its expected gain and size limit (section 5 step 3), how it could fail silently, how it is
   undone, how it is rehearsed, the expected rehearsal output. `code-reviewer` reviews the plan (`Mode: plan`) before any code; one round of plan
   fixes.
2. Build from the plan.
3. Rehearse every irreversible step on a copy (synthetic data or a backup copy) with a tested
   way back; the output must match the plan's expected output. While fixing, rehearse on a small
   sample; the evidence is one full run at the end. The real run on the server is then one owner
   step with the rehearsal's evidence attached.
4. Safety-net changes (trigger b): fault injection shows every fault caught before is still
   caught.
5. Review in parallel: `code-reviewer` (normal) and `code-reviewer` with `Mode: adversarial`;
   `triage` merges.
6. Fixes: at most 2 rounds. Still open: one different approach or a smaller scope (a new plan,
   the same steps). Still open: to the owner.
7. Setup edits (this file, a shared agent's text, the profile's domain checklist, the tools at
   trigger b):
   `claude/` is live on save, so draft in the run folder. Read `$B/private/global-actions.md`
   first (section 1). Before the edit lands or counts as done, by what it changes; the Tier 3
   reviews check which kind it is:
   - A doc reviewer's text, while `drill.mjs` has no doc cases: the back-check of the third bullet
     instead of drills.
   - A reviewer's text or the checklist: rerun the drills for the affected reviewers (section 7),
     a text edit with `--agents-dir <draft folder> --reviewer <name>`. A lower caught count than
     the last complete batch goes to the owner with the numbers, quoting the n `drill.mjs compare`
     printed. A typo is never fixed alone: one in a shared agent's text goes to the global actions
     file's "Waiting for the next edit", one in a checklist to that project's to-do list, each with
     the file and line; the next real edit of that text takes it.
   - What code reviewers get in a normal review (section 5, step 6's code-reviewer sentence): the
     change goes into `REVIEWER_INPUTS` in `$B/tools/drill.mjs`, which builds both that sentence and
     the drill prompt; a test fails while the two differ. Then the drills for every project, each
     project's batch an item in the global actions file, since the view's hash cannot see this edit
     and still prints `current`. An item is done only when that project's drill ledger holds a
     complete batch for the reviewer dated on or after the edit's commit; until then reports keep
     it under Open issues by name.
   - Any other edit, other prompts included (modes, UX and trust inputs, finding limits): no drills,
     since reviewers never read this file and a batch cannot see it. One that could let more
     through (fewer or lighter reviews, a lower finding limit, a narrower tier or trigger, findings
     parked or dropped) gets a back-check: a fresh `code-reviewer` at the Tier 3 row applies the new
     rule to every project's past task logs, saved reports and ledger rows, and counts which findings
     or reviews it would have changed and how serious they were (`severe`, accepted). It says how
     many tasks it read in full; a task without saved reports is unknown, never none. Its prompt
     asks for a count table, not findings, so the 12-finding limit does not apply. One agent-ledger
     row, reviewer `back-check`: `findings` the ones it would have changed, `accepted` those of them
     once accepted, `rejected` the rest, `duplicate` 0, `severe` those once rated severe,
     `fix_caused` 0. The counts go to the
     global actions file, section C, and the edit lands only once the owner agrees. The edit also
     adds its rule to section 7's list and says what a task's `log.md` records each time it is used.

**Recoverable route (class B only).** For a one-time change to stored data that meets all of these.
A condition in doubt counts as false, and then the task stays Tier 3.
- No other Tier 3 trigger applies, and it is not a backfill.
- It writes only the columns the plan names and adds rows only to a table of its own. A collected
  value (a price, a title) never changes.
- It touches no auth, access or account data, no row scoped to one user, and no integrity format.
- Its undo is its own command, not a restore of the backup. The rehearsal runs the change, a
  person's edit on a changed row, one full scheduled cycle, the undo and one more cycle, and compares
  the whole database with a copy given the same edit and the same cycles without the run. The log
  names every table or settings key that differs, with why it is harmless.
- Neither the run, its undo nor the scheduled jobs after them send anything outside the app because
  of it, shown by that same comparison. A send that cannot be held back, or the memory of one that
  the undo does not restore, means this route does not apply.
- A backup is taken before the real run, under a name no later command can overwrite.

Steps, at the profile's Tier 2 efforts, with the log naming how each condition was met. Each prompt
names this route and its mode.
1. Plan and plan review as in step 1 of the list above. The plan also says, for each step, what
   happens if it is run twice or killed there, and it names these guards and no others: a dry run by
   default, a refusal while another job writes the same data, a refusal with no fresh backup, the
   undo, and a stated row count that must match. Another guard needs a named failure seen in the
   rehearsal or the reviews. The plan review's prompt lists the conditions and asks the reviewer to
   break each.
2. Build and rehearse as in steps 2 and 3 of the list above, on synthetic data or the one copy the
   project's rules allow, never on a backup. Rows Claude may not read are rehearsed by an owner
   command printing only counts and checksums. A fault script is part of the rehearsal: it kills the
   command at every write step and reruns it both at once and after one scheduled cycle, kills the
   undo and reruns it, runs the command twice in a row and twice at once, shows a refusal when the
   backup fails, and restores that run's own backup of the copy onto another copy.
3. `code-reviewer`, normal, reading real data only through that same copy. Then the usual triage and
   fixes.
4. After those fixes, one `code-reviewer` pass with `Mode: adversarial`, its prompt limited to kill,
   rerun, two runs at once, undo, backup, a guard failing open, and any way the real command can
   differ from what was rehearsed; at most 5 findings. Its logic fixes get one fix round of their
   own, outside section 5 step 7's count, re-reviewed by a normal pass, not another adversarial one.
   Still open: trigger e.
5. After the last fix, the fault script and the full rehearsal run again on the final commit, and
   the owner's step names that commit. The real run and any undo stay owner steps.

On this route commits carry `Ship-Tier: 2`, and the task's last commit adds
`Ship-Reviews: code-reviewer`. A condition found false before the real run, by a finding a test does
not disprove, restarts the task at step 1 of this section's first list (Tier 3's own steps, not this
route's), at Tier 3 efforts; earlier reviews do not count, and its last commit carries `Ship-Tier: 3`
and `Ship-Reviews: code-reviewer, triage`. Found false after the real run: an owner item with the
undo.

## 3. Models and efforts

Use the profile's table exactly, for every agent started (`model` and `effort`). Allowed
changes, only these: a builder that failed twice hands over to `builder-heavy`; the exceptions
the profile's table names (for example auth work at `high`). Never below the table. A doc reviewer
(section 9) the profile has no row for yet: the class table's row for the profile's risk class
(`$B/claude/README.md`).

## 4. Questions: sort before asking

Every would-be question is one of four kinds; only the last stops anything.
1. A fact: look it up (code, docs, the provider's current docs). Never ask.
2. A convention: take the usual default; list it under "Assumed".
3. A reversible choice: take the recommended option, keep it easy to undo, say so in the report.
4. An owner choice: only what the profile's "Owner decides" lists, plus always: pushing or
   deploying; a new dependency, service or cost; publishing; an irreversible action on real
   data; a conflict with the requirements; a Tier 3 change still open (section 2).
   Owner choices from a doc review: only section 9's list.

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
   later-stage details: left out and put to the owner. The doc text a spec rests on is reviewed
   first where section 9's "When" says so. A number, rule or reading under "Assumed" that the doc it
   points to does not hold is written into that doc in this task (section 9).
   A new feature or one-off also states its expected gain, in numbers, and a size limit in lines.
   When a measured gain comes in small (a review's "adds 1 of 34") or the limit breaks, stop before
   adding guards, fix rounds or stop tests: the main session compares gain and cost, then drops or
   shelves the feature or records in the log why it goes on. Dropping something the owner asked
   for by name is an owner choice (section 4). Nothing the requirements or the domain checklist
   require is dropped this way.
4. Build chunk by chunk: `builder` for Tier 1, `builder-heavy` for Tier 2 and 3, design, an
   ambiguous spec, or after a builder failed. Give the spec path, the chunk and CHECKS; never
   paste code. Small changes the project's `CLAUDE.md` names, the main session does itself (an
   agent starts cold). To keep builders cheap:
   - Each agent's description starts `<slug>: `, so spend can be counted per task.
   - A start map goes in the builder's prompt: the files to read first and the facts already
     settled. Never in the spec, since reviewers read the spec and should look for themselves.
   - A new chunk gets a new builder.
   - An agent that will run a long job (a rehearsal) is started in the background. It runs the job
     with `run_in_background`, ends its turn and wakes on the exit notice. Never poll a log: each
     poll re-reads the whole context.
   - The main session makes small fixes itself (a few lines, one area). A subagent's cache lasts about 5 minutes, so
     resuming one that sat idle longer rewrites its whole context: past about 150k, start a fresh
     builder with the spec, the log and the findings instead.
5. Gates: CHECKS; on failure a small fix by the main session, otherwise back to a builder (step
   4), at most 2 tries. Visible changes: the page
   crawler once for the changed pages, when the profile names one.
6. Review: the tier's reviewers in one message (parallel). Code reviewers get the commit range
   (or the working tree), the spec path and the CHECKS output. UX and trust reviewers get only
   screenshot paths and one line per page on its purpose, nothing else. Doc hunks at doc level 1-3
   add their doc reviewers to this message, with one triage for all (section 9).
7. Triage: the main session checks a single reviewer's findings against the code itself;
   `triage` with two or more. Fix what is right, take the recommended option on cosmetic asks,
   skip what is wrong; owner choices to the actions file. Fixes in one batch. Re-review only
   Tier 2 and 3 logic fixes, by the reviewer that found them. At most 2 fix rounds. In class B only:
   - No real impact: a finding the main session checked against the data, with no affected row and
     no job or person likely to produce one, goes to the project's to-do list with the query, the
     copy's date and what would make it non-zero; no fix or re-review. It counts as accepted,
     `severe` 0, and the log lists it. Rows the checked copy cannot hold (a `noAi` source, blanked
     text, anything newer than the copy) count as unknown, not as none. Never for auth, access or
     leaks between accounts; backups, restore or undo; gates, alert delivery, self-update or
     migrations; a failure that has not happened yet (a kill, a rerun, a refused fetch); a domain
     checklist item or the profile's named worst failure.
   - Fixes breeding findings: when a round after the first has at least 3 findings and most are
     `fix_caused`, those get no fix list; any others take the usual route. The main session decides,
     without asking the owner, whether that design should exist. If so, the findings take the usual
     route. If not, it simplifies or removes the design. That is the round's fix, re-reviewed as a
     logic fix, and it keeps a passing test for the finding the design answered; if it cannot, the
     design stays and the findings take the usual route. In Tier 3 it is the different approach of
     section 2 step 6. Findings left unfixed go to the to-do list and the log. A finding that would
     cost days of wrong values, lasting harm or the profile's named worst failure, or that touches
     auth, access, leaks, backup, restore or undo, is fixed as usual, and no such code or its fault
     test is removed this way. Step 3's limits on dropping apply.
8. Commit files by name (never `git add -A`); the owner pushes. Each commit of a Tier 1-3 task ends
   with `Ship-Task: <slug>` (public once pushed: no private names) and `Ship-Tier: <n>`, in one
   paragraph with the attribution. Each task's last commit before a planned push adds `Ship-Reviews:`
   the reviewers that ran (Tier 3: `code-reviewer, triage`); with nothing left to fix, an
   `--allow-empty` commit carries it. A Tier 0 change on a code path (comment only, a rename) carries
   the first two plus `Ship-Tier-Why: <reason>`. A task with a doc hunk at doc level 1-3, or one
   taken as wording only, in any tier, adds `Doc-Level:` and `Doc-Reviews:` (section 9) where
   `Ship-Reviews:` goes. When `ops/process-check.json` exists, run
   `node ops/process-check.mjs origin/main` at the task's end, so CI is only the backstop (rules:
   the blueprint's `docs/ci.md`).
9. Log: `.agent-runs/<date>-<slug>/log.md` (tier and why, chunks, gate results, finding counts,
   decisions). One row per reviewer run in the agent ledger and one per task in the run ledger, by
   each file's header row. `model`, `effort`: what the agent was started with. `builder_model`,
   `builder_effort`: the builder that finished the task, blank if none ran. `severe`: accepted
   findings that would have cost days of wrong values or lasting harm if shipped. `fix_caused`:
   findings aimed at code an earlier fix in the same task added. `escape_of`: when the task fixes a
   bug an earlier review let through, that task's slug, whoever found the bug, the owner included.
   The main session saves each reviewer's report in full as `reports/<reviewer>-<round>.md` in the
   run folder. Doc reviews add section 9's rows.
   Update the actions file (section 6).
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

Read the ledgers, the global view (`node "$T/setup-view.mjs"`, with
`T=$(readlink -f ~/.claude/commands)/../../tools`) and the spend since the last review
(`node "$T/spend-view.mjs" --since <date>`). When the project has the process check, also
`node ops/process-check.mjs --audit --reviewed <ledger folder>/process-reviewed.txt` and the
process runs since the last review
(`gh run list --workflow Process --limit 100`). Doc-only tasks (section 9) count toward neither the
10 tasks nor the ratios below; the view leaves out their run-ledger rows (no builder), so their
owner stops are read from the run ledger directly. Triggers:
- A reviewer over 70% rejected in its last 4 runs (noisy), or with no accepted finding of its
  own in its last 3 (redundant): propose going lighter or dropping it. Not for the challenger
  (section 8), nor `back-check` (section 2, step 7), where finding nothing is the good outcome.
- Any escape in trust territory: propose going heavier there (model, effort, or a checklist item).
- More than 1 in 5 tasks with `final_tier` above `tier`: propose clearer tier examples or
  trust-territory paths.
- Owner stops rising over 3 reviews: propose standing rules for the repeated kinds.
- Builder retries in more than 1 in 3 tasks: propose a stronger builder or smaller chunks.
- A spend pool over 10% of the total: propose how to shrink it, without cutting a review the
  drills have not measured.
- From the logs, report how each loop rule that could let more through was used. Each such rule
  joins this list with its edit (section 2, step 7): tasks on the recoverable route, findings parked
  as no real impact, rounds redesigned for `fix_caused`; doc hunks taken as `wording only` or kept
  below level 3 by an exclusion (section 9; `log.md` lists each with its doc, line and
  reason): count them and look at a sample, and any that changed a number, rule or step is reviewed
  now; doc questions settled without the owner (section 9's "never" list; `log.md` lists each with
  its basis): count doc-review owner stops and check a sample of those settled without the owner;
  `tracked:` and `blocking:` items still open in `doc-reviews.csv` (section 9): count each kind, with
  the oldest's age.
  Any `escape_of` pointing at one of them: propose removing that rule.
- Doc commits since the last review and after adoption, on the profile's doc paths, by task
  (`Ship-Task`): each task whose last commit before its push has no `Doc-Level:`, and each doc
  commit with no task, is looked at; a hunk at doc level 1-3 in it is reviewed now (section 9).
- `--audit` shows an open task: run its missing review. Its `unclaimed` commits have no task to
  close, and closing one would need a history rewrite: look at each `unreviewed` one, then add its
  sha to that file; only `unreviewed` above 0 is open. Log the count of red process runs; none at all
  despite pushes: the check may have gone quiet, so look at the workflow.

Each proposal goes into an actions file (section C) with its numbers: one about a project's own
setup (its profile, models, paths) into that project's file; one about the shared setup (this loop,
the agents, the tools, the class table) into `$B/private/global-actions.md` (section 1), and never
into a project's file. Read that file at the start of each setup review. The setup changes only
when the owner agrees; the profile's "Setup changes" records the date and the reason. A lesson
that holds for every project goes to the blueprint. A proposal about a project's own setup may
rest on evidence from other projects (acceptance only hints; drill scores are the basis for
comparing models), but is written per project, in each affected project's actions file, against its
risk class: never below its class table. A change to the class table itself is a blueprint change the owner approves.

Drills measure what reviews miss (commands, cases, limits: the blueprint's `docs/claude-setup.md`).
- A batch runs only when the setup changed, since a rerun on an unchanged setup mostly measures
  chance: a reviewer's text (its file or the profile's domain checklist), model or effort changed,
  or what code reviewers get changed (section 2, step 7), or the view prints `model version moved
  since the batch of <date>`. It uses all the reviewer's active cases at the profile's models and
  efforts; other settings only for a named comparison. No calendar batches. Run a comparison twice only when
  a decision rests on a small gap.
- A bug that got past review becomes a new case at the setup review, when a good one can be made from
  it. The view then reads `batch incomplete` until the reviewer's next batch covers it.
- `builder-heavy` writes the cases. The main session never opens them and reads only counts. Never
  tune a reviewer's text to a case; a case seen while editing an agent is retired.
- A batch is one owner command in the actions file, because a session's sandbox refuses the network
  it needs. If `drill.mjs probe` ever exits 0 from a session, that session may run the same command;
  nothing else changes.
- Done only when the view prints `current, scored N of N` for the reviewer and no `model version
  moved` line: a batch for its own text and the domain checklist at the profile's model and effort,
  covering its active cases. A later comparison cannot reopen it. Until then the item stays in the
  actions file and reports keep the view's line under Open issues. A command written is not a batch
  run. `model version not checked` (no agent run on that model to compare) is information only.
- `context changed since the batch of <date>` (the rest of the profile or the rules moved) is
  information only: no item, no Open issue, unless the setup review judges that the edit changes
  what reviewers look for. Then it raises a batch item, with the reason, done when a full batch at
  the new context clears that line (the view already reads `current` before it runs).

## 8. The challenger (direction, not code)

Runs when the owner asks; at most once at the start of a stage or phase; and in every Tier 3 task
that adds or replaces a design (a new part of this loop, a new agent, a new subsystem, a new data or
integrity format), not one that fixes, rehearses or extends an existing design: blind before the plan
is written, compare once it is drafted, before the plan review. Never per routine change. Two
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

## 9. Doc review

Builders, tests and reference implementations are all written from the docs, so a wrong rule in a
doc passes every test. Doc review checks doc text by its content, apart from tiers: in any work,
Tier 0 included, every changed doc hunk at doc level 1-3 is reviewed ("When"), from adoption (top
of this file). A doc is a file on the profile's doc paths ("Doc levels"); a generated file it
excludes is reviewed through its sources. The doc reviewers are generic; the profile's "Doc levels"
and "Doc review focus" say what matters in the project.

**Levels** ("doc level 0-3", L0-L3 in logs; never D0-D3, which are stage names). Each changed hunk
is leveled by its content, and the highest hunk sets the change's level. The profile's floor and
paths only raise a level, never lower it. Doubt goes up. `log.md` records each hunk's level and the
criterion that decided it.
- Level 3: the hunk adds or changes a number (a value something is computed, decided or checked
  with; not an id, a version or a record's date), formula, definition, threshold, tolerance, default,
  method, worked example or expected value; a money, tax or legal rule the app applies (not a
  license notice); an integrity-format or data-check rule; anything code or a reference
  implementation computes from or tests are written from. In any doc, the requirements, `CLAUDE.md`
  and the glossary included. A value restated with a pointer to the doc that sets it (`as in <doc>`)
  is at least level 1, and `doc-reviewer-consistency` checks that it matches that doc exactly;
  restated without a pointer, it counts in full.
- Level 2: a rule agents or builders follow; a feature or page described; a contract between parts
  (an API, a plug-in); the decisions log; restore, rollback, migration and key-handling steps (they
  are followed only once the harm is done).
- Level 1: other steps people or agents follow (setup, runbooks, troubleshooting); help text without
  definitions.
- Level 0: notes, logs, ledgers, the backlog, run folders, work logs, actions files (they keep
  `Mode: actions`, section 6); a wording-only hunk (no number, rule, step or meaning changed).
  Nothing is built from these: a fact code relies on moves to a doc at its level first.

**Reviewers**, one agent each, started in one message (parallel). Each is its own ledger name, so
section 7's noisy and redundant triggers apply to each.

| Doc level | Agents |
|---|---|
| 1 | `doc-reviewer-consistency` |
| 2 | `doc-reviewer-consistency`, `doc-reviewer-clarity` |
| 3 | `doc-reviewer-consistency`, `doc-reviewer-source`, `doc-reviewer-examples`, `doc-reviewer-adversarial` |

`doc-reviewer-derive` is on trial: it runs only in doc drills until a drill shows it catches planted
mistakes the level 3 set misses (then a setup change adds it to level 3 for formula and method
hunks; otherwise it is dropped). A doc drill never gates anything; it runs once before a project's
first catch-up when possible, in the session, on a throwaway clone. `builder-heavy` plants about 12
mistakes in 3-4 of its level 3 docs, replacing the text in the doc, in every restatement and in the
code and tests built from it (at least 4 wrong but consistent rules with their examples changed to
match, plus boundary flips and ambiguities), and writes the derive arm's questions; the level 3 set
and the derive arm run on the clone; `builder-heavy` scores them; the main session reads only the
counts. The clone lies outside the repo; each drill prompt gives only the clone's absolute path, says
to read and search nothing outside it, and never says it is a drill.

Doc reviewers get the commit range (or the working tree), the doc paths with each hunk's level, the
sections in scope, and the spec path inside a task; `doc-reviewer-examples` and
`doc-reviewer-clarity` get `git diff <range> -- <doc paths>` instead of the range, which may hold
code. The scope is the changed hunks and the sections they touch; a doc without headings is in scope
whole; in an append-only log (the decisions log), only its new entries, and a past entry found wrong
is corrected by a new entry, never edited. Each reviewer reads the whole doc as context, and a
finding is in scope when either side of it touches the scope. Two or more ran: `triage` with
`Mode: docs`; one: the main session checks its findings against the docs itself. A hunk that triage
(or that one reviewer) puts at a higher level gets that level's missing agents before the review
counts. A run's scope holds at most about 4,000 words: a larger one is split by sections into parts,
each reviewed on its own, and a doc split this way then gets one whole-doc
`doc-reviewer-consistency` run. A run that hits its finding limit may have stopped short: after the
fixes it reruns on the same scope. A part where a run hits a limit twice is split again; a part that
cannot be split counts as reviewed once a rerun after fixes stays under every limit; still at a
limit after the second fix round, its unfixed findings become blocking open items. Models and
efforts: section 3.

**When.**
- Doc-only work is its own task: a run folder and `log.md`; its commits carry `Ship-Task: <slug>`
  and `Ship-Tier: 0`. A task's doc hunks are reviewed together once, however many commits carry
  them: before push, and before the first commit carrying text a builder in the task builds from.
- Inside a Tier 1-3 task, doc hunks join step 6's batch, one triage for all.
- Before building (section 5, step 3): text at doc level 2-3 the spec rests on that changed after
  adoption, and every level 3 section the spec computes from, must be reviewed (below).
  Not reviewed: changed text is reviewed first (or in the batch, when this task writes it); for an
  older level 3 section, its doc's catch-up task moves to the front. A blocking item open: the task
  waits on it and goes on with everything else (section 4). A tracked one: it builds on the
  conservative reading the doc records.
- Reviewed-docs record: `doc-reviews.csv` in the ledger folder, one row per doc reviewed, written
  after the commit carrying the reviewed text: `date,path,sha,level,modes,scope,open`. `sha`: that
  commit, in the repo that holds the doc (a submodule's own commit for a doc inside it); `modes`: the agents that ran; `scope`: `whole`, or heading slugs (as GitHub makes them)
  separated by `;`; `open`: the items left, separated by `;`, else empty. `scope` and `open` are
  always quoted. A section is reviewed when a row at its level or higher covers it with nothing
  blocking open and no later commit changed it without a row of its own; once an open item is
  settled, a new row for that scope closes it. A doc is reviewed when all its sections are.
- Open items, each prefixed in `open`: `blocking:` (an owner item 1-4 below, readings not yet
  computed, a finding still unfixed after the last fix round) or `tracked:` (a level 3 claim whose
  source was not read, a reference check only the owner can run). A tracked item takes the
  conservative reading (by the profile's domain checklist and worst failure), written into the doc
  as assumed. A task's tracked items become one action step (item 5 below: the owner checks them,
  or puts a copy of the source in `private/`), and its report lists them under Open issues. A
  tracked check that later disagrees: the doc is fixed, and the code built from it becomes a code
  task with `escape_of` (section 5, step 9).
- Catch-up (text from before adoption): one task per doc, or per group of small related docs, scope
  `whole`, in parts as above. Order: docs that code or the reference implementation computes from,
  then other level 3 docs, then level 2. Slugs start `doc-catchup-`,
  and each log keeps the running count of agent runs; past about 300 runs per project the catch-up
  goes on, and each task's report gives the count under Open issues. Findings about code already
  built from the old text become code tasks at their usual tiers.

**Sources.** For each `read:` URL that an accepted finding, or a `Checked:` line confirming a level
3 claim, rests on, the main session searches the page's raw text for the quote; no model reads the
page again. It fetches with `curl` (declaring the host in the call's `allowed_domains` where the
sandbox needs it), turns a PDF into text with `pdftotext` when installed, removes HTML tags, and in
page and quote decodes HTML entities, applies Unicode NFKC, maps curly quotes and dashes to ASCII,
joins words hyphenated across line breaks and collapses whitespace, then runs a fixed-string `grep`; it reads only found or not
found. A page it cannot fetch or turn into text, or a quote not found, counts as not read; a quote
not found on a fetched page is also logged as that reviewer's fault. A level 3 claim in scope that the source reviewer's `Checked:` omits counts as not read. A level 3 claim left not read
is never confirmed; it is tracked (When). A `doc-reviewer-source` run that read nothing counts as
not run, so its claims are tracked, and the blueprint's global actions file gets an item with the
cause (section 1). A task's `No outside example:` lines (from `doc-reviewer-examples`) go into
`log.md`; those a reference tool only the owner runs could give a value for join the task's action
step (item 5 below), the rest go to the project's to-do list.

**Fixes.** The main session edits the docs. Every doc hunk changed after the batch, fixes included
(by a doc or code fix round, or the text the compute step writes), is leveled again by its content;
at level 1-3 its changed lines are re-reviewed by the agent that found it, if any, plus its new
level's full set. At most 2 fix rounds. Still open, or the reviewers disagree on what is right:
`builder-heavy` (Tier 3 row) computes both readings on synthetic cases in the run folder, and in the
reference tool the profile names when the session can run it. The reading that matches the reference
tool, or else the conservative one (by the profile's domain checklist and worst failure), is taken
and recorded as assumed. A reference tool the session cannot run: the conservative reading is taken
and the check is tracked (When). A finding still unfixed after that, on text from the last fix round
or the compute step, is open as blocking; there is no third round: the next doc task on that scope
takes it with its own two rounds (not trigger e). A difference reaches the owner
only through the list below, stated as its effect in user terms (for example "Sharpe 0.82 against
0.79 on the sample"), never as math.

**The owner decides only:**
1. A finding that would change what a requirement asks for (a feature, a target, behavior users
   see), or a doc that contradicts the requirements where no source decides which is right. A
   correction that makes a requirement match its source, the reference tool, or another requirement
   that a dated decisions-log entry, the current stage file or an owner answer names as the current
   side, is a doc fix, with a decisions-log entry and one line per doc in the actions file's work
   log (section F; information, no action). Two requirements with nothing naming the current side:
   this item.
2. A choice on the profile's "Owner decides" list that nothing settles (a source, a standing rule
   such as "as the reference tool does", an earlier answer). Where a list entry names what settles
   it ("tax rules the owner's cases do not settle"), that entry wins over the "never" list below.
3. An approval the project's rules require (a pre-registration, a formula before validation,
   targets), and any change to something the owner approved or that was registered.
4. A difference left after the Fixes step that changes a number the user sees and is on the
   profile's list.
5. An external check only the owner can run (a golden value from a tool behind their account, a
   source the session could not read): an action step (section 6), not a decision.

Never the owner otherwise: whether a rule or formula is right, a convention with a standard or a
read source, wording (except an instruction users act on, such as an alert telling them to trade,
when the profile's list covers what it is about), consistency, an edge case with a conservative
handling (taken and recorded as assumed). Docs keep records of settled decisions and hold no open
owner questions; those go to the actions file. Each assumption states its basis:
`source: <citation>`, `reference tool: <doc>`, `owner: <date>` or `choice: <reason>`.

**Records.**
- Trailers, in the paragraph with the attribution, where `Ship-Reviews:` goes (section 5, step 8):
  `Doc-Level: <0-3>` (the task's highest level; 0 when every hunk that would need review was taken
  as wording only) and `Doc-Reviews: <agents that ran, and triage if it ran>`, adding
  `wording only` when a hunk was taken as such.
- One agent-ledger row per agent run, reviewer the agent's name, `tier` 0 for doc-only work, else
  the task's tier. A doc-only task also gets a run-ledger row at tier 0, with its `owner_stops`. One
  `doc-reviews.csv` row per doc reviewed.
- `log.md`: each hunk's level and its criterion (naming any exclusion that kept it below level 3),
  every `not read` source and quote not found, each hunk taken as wording only with its doc and
  line, and each question settled without the owner with its basis.
