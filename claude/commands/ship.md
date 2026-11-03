---
description: Build, check, review, triage and fix one task autonomously (projects with docs/agents.md); report once at the end
argument-hint: <what to build or change>
---

Task: $ARGUMENTS

Follow the "Agents" section of the project's `CLAUDE.md` and its agent profile `docs/agents.md`
(models and efforts, trust territory, CHECKS, paths). If the project has no `docs/agents.md`,
say so and stop.

1. Read the current stage or phase and the requirement sections the task touches. If the task
   conflicts with the requirements, stop and ask.
2. Classify the tier from the change itself; log it with a one-line reason.
3. Tier 1 and 2: write the spec in `.agent-runs/<date>-<slug>/spec.md` from the profile's spec
   template.
4. Build chunk by chunk with `builder` or `builder-heavy` (the project's rules say which small
   changes you do yourself), with the model and effort the profile names for that role.
5. Gates: CHECKS; the page crawler for visible changes when the profile says the project has one.
6. Run only the tier's reviewers, in parallel, each with only its allowed inputs and the
   profile's model and effort.
7. Triage (yourself with one reviewer, `triage` with two or more), fix in one batch, re-check;
   re-review only Tier 2 logic fixes; at most 2 rounds.
8. Commit (files by name, never `git add -A`; the owner pushes), write the run log, add the
   ledger rows and update the owner's actions file (paths in the profile).

Do not message me until done, except for a stop condition. Finish with the report format from
the project's rules and nothing else.
