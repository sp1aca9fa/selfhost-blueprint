# Requirements index (start here)

## How to read
1. Read this index.
2. Read the file for the **current stage** in `stages/`. It lists the area files needed.
3. Read only the area files relevant to the task.
4. Read the full `REQUIREMENTS.md` (built from these files by `pnpm docs:build`) only for the
   completion check at the end of a stage, or when the owner asks.

## Status
| Stage | Topic | Status |
|---|---|---|
| A | <<First slice and its gate>> | not started |
| B-... | See `stages/` | not started |

## Global constraints (apply to every task)
- Pillars in priority order: <<...>>.
- Nothing particular to one country, provider, language or person is hardcoded in core. It is a
  plug-in (15) or an admin setting (12).
- A closed, self-hosted app for a few accounts; everyone brings their own data. No paid service
  unless the owner approves.

## Area files
| File | Contents | Read when working on |
|---|---|---|
| 01-vision-targets.md | Vision, pillars, product model, targets, gates | Trade-offs, stage reviews |
| 02-process.md | Rolling wave, stage reviews, backlog, decisions | Planning, new ideas |
| 04-data-pipeline.md | Sources, imports, schedule, checks, health | Anything touching data |
| 08-ux-language.md | Languages, defaults, help texts, acceptance | Any UI, content |
| 12-architecture-stack.md | Stack, auth, admin settings, hosting (containers or not, and why), layout | Setup, infra |
| 13-testing.md | Test strategy, fixtures, golden values | Tests |
| 14-decisions-log.md | Decision history | When a decision changes |
| 15-plugins.md | Plug-in kinds, contract rules, public vs private, the template | Any data source or plug-in |

Numbers are kept stable when files are added (gaps are fine).
