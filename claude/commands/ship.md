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
| 0 | Nothing a user, a job or the data can notice | docs, notes, comments, tests only, a rename with unchanged tests, config with no behavior change | no spec; CHECKS only; never reviewed "to be safe" |
| 1 | Behavior changes, none in trust territory | CLI output and glue, dev tooling, ops scripts that write no stored data, UI that shows no numbers, signals or money, new texts | spec; `builder`; CHECKS; `code-reviewer-light` (+ `ux-reviewer` if visible) |
| 2 | Any file on the profile's trust-territory paths, or a new page | data collection and parsing, checks, calculations, money, alerts, auth and access, migrations, backups and restore, imports, deletes, server scripts that deploy or write data | spec; `builder-heavy`; CHECKS; `code-reviewer` (+ `ux-reviewer`, `trust-reviewer` if visible); logic fixes re-reviewed |
| 3 | Tier 2 that the normal loop cannot verify (triggers below) | a backfill on real data, a new hash-chain format, the self-update path, a check's own code | section 2 |

Tier 3 triggers (only these, never mere doubt):
- a. An irreversible action on real data: a rewrite or drop in a migration, a backfill, a bulk
  delete, a restore.
- b. The safety net's own code: data checks, health grading, gates, CI, fault injection, alert
  delivery.
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
8. Commit files by name (never `git add -A`); the owner pushes.
9. Log: `.agent-runs/<date>-<slug>/log.md` (tier and why, chunks, gate results, finding counts,
   decisions). One row per reviewer run in the agent ledger
   (`date,slug,tier,reviewer,findings,accepted,rejected,duplicate`) and one row per task in the
   run ledger
   (`date,slug,tier,final_tier,builder_retries,checks_failures,fix_rounds,owner_stops,escape_of`;
   `escape_of`: when the task fixes a bug an earlier review let through, that task's slug).
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

Done items, settled decisions and read comments move to the done file, newest first, dated.

## 7. Setup review (every 10 tasks or every month, whichever comes first)

Read both ledgers. Triggers:
- A reviewer over 70% rejected in its last 4 runs (noisy), or with no accepted finding of its
  own in its last 3 (redundant): propose going lighter or dropping it.
- Any escape in trust territory: propose going heavier there (model, effort, or a checklist item).
- More than 1 in 5 tasks with `final_tier` above `tier`: propose clearer tier examples or
  trust-territory paths.
- Owner stops rising over 3 reviews: propose standing rules for the repeated kinds.
- Builder retries in more than 1 in 3 tasks: propose a stronger builder or smaller chunks.

Each proposal goes into the actions file (section C) with its numbers. The setup changes only
when the owner agrees; the profile's "Setup changes" records the date and the reason. A lesson
that holds for every project goes to the blueprint.
