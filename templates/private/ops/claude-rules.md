# Rules for Claude Code in MyApp (private)

Loaded every session through the main repo's `CLAUDE.local.md` (git-ignored; it only imports this
file). The generic rules are in the public `CLAUDE.md`; this file keeps only what is private.

## Where things are
- At the start of every session read `private/ops/actions.md`, the To-dos in `private/ops/notes.md`,
  and the latest CI runs (`gh run list --workflow CI --limit 3`): a red run on a pushed commit is
  fixed first, since it holds back the server's update.
- Separately, `gh run list --workflow Process --limit 3`: a red process run means review the open
  task, and it has no effect on the server. No workflow of that name: the check is not added yet.
- The owner's setup, sources' quirks and to-dos: `private/ops/notes.md`.
- The owner's checklist and open decisions: `private/ops/actions.md`, holding only what still needs
  the owner. Done steps, settled decisions and the work log: `private/ops/actions-done.md`.

## Hard rules (private)
- No private plug-in code, real recorded responses, <<private names: shops, hosts, accounts>> or
  personal amounts in public files.
- <<Special terms of private sources (what Claude must never fetch or bypass).>>

## Commands (Claude's environment)
- <<Workarounds the sandbox needs: Node path, pnpm store lock, tools that cannot run here.>>

## The server
- Claude's sandbox cannot reach it. The owner runs commands there and pastes the output (or saves
  it under `private/ops/server-output/`).
- <<Host alias, ports, other apps on the box.>>
