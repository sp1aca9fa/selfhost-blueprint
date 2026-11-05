# Repo layout and names

## Public repo

```
myapp/
  CLAUDE.md                 generic rules for Claude Code (committed)
  CLAUDE.local.md           one line importing private/ops/claude-rules.md (git-ignored)
  .claude/settings.json     sandbox baseline and hooks (committed)
  .claude/settings.local.json   personal permissions and domains (git-ignored)
  .github/workflows/ci.yml  checks and build on every push
  .github/workflows/process.yml   commit trailers against changed files (no effect on the server)
  README.md                 what it is, quick start with a demo seed, the guide table
  REQUIREMENTS.md           built from docs/requirements/ (never edited by hand)
  docs/
    requirements/           00-index.md (status table), area files, stages/, 14-decisions-log.md
    agents.md               the agent profile (for the shared agents)
    spec-template.md        the form for every Tier 1-3 change
    ux-review.md            instructions for the UX reviewer (who they are, what to look for)
    trust-review.md         only when pages show numbers people act on
    setup.md, running.md, backups.md, home-server.md, plugins.md, languages.md, ...
    backlog.md              ideas not in the current stage
  apps/web/                 the web app (when there is one)
  packages/
    core/                   pure logic, no I/O
    db/                     schema, migrations (add-only), queries, backup and restore
    auth/                   passwords, TOTP, sessions, access checks
    content/                every user-facing string (next-intl; en.json is the base)
    plugin-sdk/             the plug-in contract, the HTTP client, the job CLI
  plugins-public/           public plug-ins and the plug-in template
  ops/                      generic server and PC scripts, systemd unit templates, the process check
  scripts/                  dev tooling (docs build, typecheck of private plug-ins, crawl)
  private/                  the private submodule (not checked out in CI or by others)
  .agent-runs/              Claude's run logs, raw drill answers (git-ignored)
```

## Private submodule

```
private/
  plugins/                  the owner's plug-ins (any kind: collectors, importers, channels)
  ops/
    claude-rules.md         private rules, imported by CLAUDE.local.md
    notes.md                the owner's setup, sources' quirks, to-dos
    actions.md              only what waits on the owner (steps, checks, decisions, comments, work log)
    actions-done.md         what the owner finished or decided, newest first
    agent-ledger.csv        one row per reviewer run
    run-ledger.csv          one row per task (tiers, retries, owner stops, escapes)
    drill-ledger.csv        one row per drill case run, appended only by the runner
    drills/                 drill cases and their keys, never public
    process-reviewed.txt    shas of commits the process audit lists that a session has looked at
    server-output/          output the owner pasted from the server, for Claude to read
    *.sh                    personal scripts
  docs/                     private docs that are more than notes
  test/fixtures/            real recorded responses
```

The submodule is named `private/` because it holds the owner's whole private operation, not only
plug-ins.

Pushing: each repo sets `git config push.recurseSubmodules on-demand`, so a plain `git push`
pushes the private submodule's new commits first, then the main repo (the main repo's commit names
a submodule commit the server must be able to fetch). If the submodule push fails, the main push
stops too.

A push naming a commit or another branch (`git push origin <hash>:main`) fails with `src refspec
... must name a ref` when the submodule has new commits to send, because git passes the same name
on to the submodule, and nothing is pushed. Push the submodule first, then the main repo with
`git push --recurse-submodules=check origin <hash>:main`; `check` refuses if the submodule's commit
is not on GitHub yet.

## Names

- Packages: `@myapp/<name>`.
- Environment variables: prefixed `MYAPP_` (`MYAPP_DATA_DIR`, `MYAPP_STATE_DIR`,
  `MYAPP_BACKUP_DIR`), except the well-known ones (`DATABASE_URL`, `AUTH_SECRET`,
  `HEALTHCHECK_URL`). The prefix keeps two apps on one machine apart.
- systemd units: `myapp-app.service`, `myapp-daily.timer`, `myapp-update.timer`.
- Windows tasks: `myapp-backup-copy`.

## Where data lives (XDG folders)

| What | Where | Override |
|---|---|---|
| database, daily backups, analysis copy | `~/.local/share/myapp/` (`backups/`, `analysis/`) | `MYAPP_DATA_DIR` |
| logs, stamps, locks | `~/.local/state/myapp/` | `MYAPP_STATE_DIR` |
| Node for the services | `~/.local/share/myapp/node` (a link to the nvm version) | |
| the code | `~/code/myapp` | |
| off-box copies on the main PC | `~/backups/myapp/` | the copy script's folder argument |

One folder per app under `~/backups/` keeps every app's copies side by side and apart from any
local development backups.

## Numbers and dates

float64 for analytics; decimal.js for money, tax and quotas; money always carries its currency.
Dates as `YYYY-MM-DD` in the zone the app's requirements name; display in the install's zone.
