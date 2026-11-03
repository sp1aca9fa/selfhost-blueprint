# The pattern

## An agnostic core

The public repo is an app anyone can run for themselves. Nothing particular to one country,
provider, shop, broker, language or person is hardcoded in the core. What differs between
people is either:

- a **plug-in** (a data source, an importer, a rate provider, a notification channel), or
- an **admin setting** (base currency, time zone, languages, schedules, costs).

The owner is just one install: their plug-ins and settings live in the private submodule and in
their database, never in the core.

## Bring your own data

- Plug-ins fetch and parse; the core stores, checks and computes. Plug-ins never write to the
  database and never call `fetch` directly: they use the SDK's HTTP client (one place for
  politeness, quotas, retries, timeouts and secret masking).
- Import only **raw** observations (prices, bars, rates, listings). Derived values (indicators,
  valuations, signals) are computed by the app from raw data, so they can be recomputed after a
  bug fix. Provider-computed values are for verification only.
- Raw data is never silently overwritten: revisions are logged; exclusions are marked, not
  deleted.
- Unknown stays unknown (never 0, never a guess). Money always carries its currency.
- Public plug-ins use official APIs. Unofficial, scraped or personal ones go in the private
  submodule. Public examples and tests use neutral made-up names.
- Sources whose terms forbid AI use are marked `noAi`: their raw data never reaches Claude (not
  in MCP answers, not in pasted output).

## Public and private

| Public repo | Private submodule (`private/`) |
|---|---|
| the core, the SDK, public plug-ins and a plug-in template | the owner's plug-ins (scrapers, personal sources) |
| generic docs and setup guides with placeholders | the owner's setup, sources' quirks, notes, decisions about private things |
| `CLAUDE.md` (generic rules), `docs/agents.md` | `ops/claude-rules.md` (private rules), the ledger, the owner's actions |
| generic ops scripts (`ops/`) | personal ops scripts (for example one that also stops another app) |
| synthetic test fixtures | real recorded responses for tests |

Never in the public repo: API keys, `.env` files, market or user data, real recorded responses,
private names, account details or personal amounts. A mixed decision is split: the generic part
in the public decisions log, the specifics in the private notes.

## Requirements first

Each project keeps its requirements in the repo (see `templates/docs/requirements/`): numbered
area files, a stage plan with gates, and a decisions log. Only the current stage is detailed;
later stages stay outlines until they start. Requirement changes go through the decisions log.
Claude reads the index and the current stage every session and asks when a request conflicts.

## Server work stays on the server

Jobs and plug-ins run only on the home server (or the owner's machine), never in CI or a hosted
preview: they refuse to run when `CI` or `VERCEL` is set. Jobs are idempotent, catch up on missed
days, respect quotas, and ping the heartbeat only after full success. Heavy computation runs in
jobs or the browser, never in a web request.

## Read-only analysis copy

The server's newest daily backup, unpacked on the owner's main PC, is the **analysis copy**.
Claude's read-only tools (an MCP server, ad hoc queries) read it; they never touch the live
database. It also proves every backup can be opened.

## Agents build, the owner decides

Claude Code works through a fixed loop (spec, build, checks, tiered review, triage, commit, log; `claude/commands/ship.md`)
with shared agents. It stops and asks only for what is the owner's to decide. See
[claude-setup.md](claude-setup.md).
