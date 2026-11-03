# Starting a new project

Parts to replace are in `<<CAPITALS>>`. `myapp` / `MyApp` / `MYAPP` in the templates become the
project's name in lower case, its display name, and its environment prefix.

## 1. Decide before code

Write `docs/requirements/` first (templates in `templates/docs/requirements/`):
- vision, pillars in priority order, the worst failure;
- the stages, with only stage A detailed and its gate;
- the architecture choices, each with its reason: stack, auth, hosting, **containers or not**
  ([containers.md](containers.md)), **which parts are plug-ins**, what is public and what is
  private;
- the plug-in contract (what a plug-in may and may not do).

Ask the owner what is unclear; don't invent later-stage details.

## 2. Repos

```bash
mkdir -p ~/code/<<GROUP>> && cd ~/code/<<GROUP>>
git init -b main <<APP>> && cd <<APP>>
# The private repo (create it empty on GitHub first, private):
git submodule add git@github.com:<<USER>>/<<APP>>-private.git private
```

Copy the templates and rename:

```bash
B=~/code/<<GROUP>>/selfhost-blueprint/templates
cp -r $B/. .
grep -rl 'myapp\|MyApp\|MYAPP' . --exclude-dir=.git | xargs sed -i 's/myapp/<<APP>>/g; s/MyApp/<<DISPLAY_NAME>>/g; s/MYAPP/<<PREFIX>>/g'
for f in ops/systemd/myapp-*; do mv "$f" "${f/myapp/<<APP>>}"; done
```

The template's `private/ops/` lands inside the private submodule; commit it there. Then fill in every `<<...>>` left in `CLAUDE.md`, `docs/agents.md`, `docs/ux-review.md` and the
private files (`grep -rn '<<' .` lists them). Remove what the project does not use (the trust
review, the container files, the jobs units).

## 3. The agent profile

`docs/agents.md`: what the app is and its worst failure, the trust territory, the domain
checklist, "Owner decides", texts and time zone, CHECKS, and the models table. Choose models with
[claude/README.md](../claude/README.md), "Choosing per project": heavy where mistakes are silent
and lasting, light where they are visible or recomputed.

## 4. Tooling

- pnpm workspace, TypeScript strict, ESLint, Prettier, Vitest; `check:all` runs typecheck, lint,
  format check, tests and `docs:check`.
- `.nvmrc` with the Node version; `packageManager` in `package.json`.
- CI from the template; the first push should be green.
- The sandbox baseline is in `.claude/settings.json`; add only what the project needs
  ([sandbox.md](sandbox.md)).

## 5. Hosting

On the home server: section 2-7 of [home-server.md](home-server.md) (a new port and job minute in
the private table). On the main PC: `ops/copy-backups.sh install <<SERVER_ALIAS>> ~/backups/<<APP>>`
([main-pc.md](main-pc.md)). Record the real values in `private/ops/notes.md`.

## 6. First loop

Run one small task through `/ship` to check the profile, CHECKS and the ledger path work, then
start stage A.
