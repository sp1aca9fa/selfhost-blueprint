# The home server

All of an app runs on one small always-on machine at home (a mini PC with a low-power CPU uses
about 6-10 W): the web app, the database (a local SQLite file), the scheduled jobs, and anything
that needs a home connection. Several apps share the box. Each app's own `docs/home-server.md` or
`docs/setup.md` has its specific steps; this is the common ground. Parts to replace are in
`<<CAPITALS>>`.

## 1. The box

- Ubuntu Server LTS. `sudo apt update && sudo apt full-upgrade -y`;
  `sudo timedatectl set-timezone <<YOUR_ZONE>>` (for example `Asia/Tokyo`). Security updates
  install themselves (`/etc/apt/apt.conf.d/20auto-upgrades`).
- ssh with a key from the main PC (`ssh-keygen`, `ssh-copy-id`), then key-only logins:
  `PasswordAuthentication no` and `KbdInteractiveAuthentication no` in
  `/etc/ssh/sshd_config.d/10-keys-only.conf` (check the key works first). An ssh host alias on
  the main PC (`~/.ssh/config`: `Host <<ALIAS>>`) is what the PC's scripts use.
- Reserve the box's addresses in the router. Prefer a cable (a netplan file with
  `route-metric: 100` makes the cable preferred and Wi-Fi the fallback; `sudo netplan try`
  undoes itself if ssh drops). On Wi-Fi, turn its power saving off.
- In the BIOS: "Restore on AC power loss", so the box comes back after a power cut.
- Remove what you do not use (an old Docker with an admin page open on the network, for example).

## 2. Node, the code, the data (per app)

- Node with nvm, the version the repo names in `.nvmrc` (`nvm install`, `corepack enable`; pnpm
  comes from `packageManager`). The services run Node through a stable link, so a new Node needs
  no unit change:
  `ln -sfn "$(dirname "$(dirname "$(nvm which default)")")" ~/.local/share/<<APP>>/node`.
- The code in `~/code/<<APP>>`: a read-only deploy key on GitHub per repo (write access off), an
  ssh host alias each (`Host github-<<APP>>-private`), clone, point the private submodule at its
  alias, `pnpm install`.
- Data in `~/.local/share/<<APP>>/` (database, `backups/`), logs and locks in
  `~/.local/state/<<APP>>/`. `.env` in the repo with `AUTH_SECRET` (keep it in a password
  manager too: a restored database needs the same one), plug-in keys, `HEALTHCHECK_URL`.

## 3. Services

From each repo's `ops/systemd/` templates (replace `<user>`), into `/etc/systemd/system/`:

- `<<APP>>-app.service`: the web app on `127.0.0.1:<<PORT>>` only (the address in section 4
  brings the outside in). `Restart=on-failure`.
- `<<APP>>-daily.timer` + `.service`: an hourly check that runs the day's job once when it is due
  (`OnCalendar=*-*-* *:<<MINUTE>>:00`, `Persistent=true`, so a missed hour runs at boot). Jobs
  are idempotent and catch up on every missed day.
- `<<APP>>-update.timer` + `.service`: the self-update every 5 minutes (section 7).
- Share the box politely: `Nice=10` and a `CPUQuota=` on jobs; give each app its own port and its
  own minute in the hour, so two apps' jobs do not start together.

`sudo systemctl daemon-reload && sudo systemctl enable --now <<APP>>-app.service <<APP>>-daily.timer <<APP>>-update.timer`.

| App | Port | Job minute |
|---|---|---|
| <<APP>> | <<PORT>> | <<MINUTE>> |

(Keep this table in the private notes for the owner's apps.)

## 4. The address (Tailscale)

- Tailscale on the box and on every device. `tailscale serve --bg <<PORT>>` gives
  `https://<<MACHINE>>.<<TAILNET>>.ts.net` to tailnet devices only: no router port opened, a
  changing home IP does not matter. Preferred.
- `tailscale funnel` publishes to the whole internet; only when someone outside the tailnet must
  reach it. Several apps: one HTTPS port each (`--https=8443`).
- A `tailscale funnel reset` clears every app's mapping: a watchdog that resets must set the other
  apps' mappings up again (from `.env`, never hardcoded).

## 5. Watching from outside

Nothing on the box can report that the box is down.

- **Heartbeat**: each daily job pings healthchecks.io (`HEALTHCHECK_URL`) only after full
  success; a missing ping raises the alarm by email or Discord. Check after setup that pings
  arrive (a ping that silently fails looks like a working setup). Node gives each connection
  attempt only 250 ms by default; far hosts need more (the SDK's HTTP client raises it to 1 s).
- **Admin alerts** (Discord webhook, Telegram bot) for failed runs and updates, at most once a day
  per kind.

## 6. Backups

- Each daily job ends with a backup: a consistent snapshot (`VACUUM INTO`), SQLite's integrity
  check, gzip, written whole or not at all, named `<<APP>>-YYYY-MM-DD.db.gz` (the server's date).
  Kept: the newest 30 days plus the first of each month for 12 months.
- Off the box: the main PC pulls them over ssh ([main-pc.md](main-pc.md)). A backup only on the
  box does not survive losing the box.
- Restore only into a new, empty database, never over an existing one; then migrate, check health,
  and let the jobs refetch the days after the backup.

## 7. Updates

`ops/update-server.sh --auto` (the update timer): when GitHub has new commits, it pulls both repos
(main and private submodule), installs the `.nvmrc` Node if new, installs packages, migrates
(add-only migrations, so going back needs no down-migration), builds, restarts the app and checks
it answers. Never while a job runs. When a step fails it goes back to the version before, keeps
that running, tells the admins, and does not retry that version until a newer push. A repo with
uncommitted changes is not updated. The restart needs a sudoers rule allowing only
`systemctl restart <<APP>>-app`.

It updates only to a commit GitHub CI passed on (`ops/ci-status.sh <sha>` reads the commit's check
runs; no token for a public repo), and to exactly that commit even when a later one arrived
meanwhile. The main repo's `origin` must say `github.com`: clone a public repo from its https
address, which needs no key. With an ssh host alias as origin, the script answers `unknown` for
every commit and the server never updates (the private submodule's alias is fine). While CI runs, or when GitHub gives no usable answer (no network, an error, its rate
limit), nothing changes and the next tick asks again, logging once per commit and status; after 24
hours without an update (counted from the server's own commit, so newer pushes do not restart it; an update or a reported CI failure does)
the admins are told once. A failed CI run is treated like a failed update, at once (not retried
until a newer push, admins told with its own text, step `ci`; an alert no channel took is tried
again at each check until sent). After a passing re-run of CI on that commit, run the script by hand
or delete `~/.local/state/<<APP>>/update-failed`. A commit CI never runs on (`[skip ci]`,
`paths-ignore`, a disabled workflow) is never installed automatically. The private submodule is not
gated (CI does not check it out). By hand, the script prints the CI status as a warning and updates
anyway. `<<APP>>_UPDATE_REQUIRE_CI=0` turns the gate off for a fork without CI. See `ci.md`.

Push order matters (the main repo's commit names a submodule commit the server must be able to
fetch), so each repo sets `git config push.recurseSubmodules on-demand`: a plain `git push` pushes
the private submodule first.

## 8. Turning it off

`ops/safe-shutdown.sh` waits for running jobs and updates to finish, stops the timers and apps,
then powers off (`--also <prefix>` for other apps' units, `--dry-run` to see what it would do). A
failed or empty unit listing aborts; aborting restarts the timers. A private wrapper can stop all
of the owner's apps at once.

## 9. The machine's own record

The owner's real values (host alias, addresses, tailnet name, ports, which apps run, quirks met)
go in each app's private `ops/notes.md`, never in public docs.
