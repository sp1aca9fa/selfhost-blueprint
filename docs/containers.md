# Containers

## Decision (2026-11-03)

The owner's home server runs the apps **without containers** (systemd services and timers, one
Node per app through a stable link, XDG folders per app). Each blueprint project also ships an
**optional** `Dockerfile` and `compose.yaml` for other people who want `docker compose up`
instead of the setup guide.

## Why not on the owner's server (for now)

- One small machine, one owner, SQLite files: containers would add image rebuilds to every
  self-update, volume permissions on the database files, and a second layer of logs and restarts
  on top of systemd, for little isolation gain (each app already has its own Node, folders, units
  and CPU limits).
- Some apps need the desktop session (Tora's browser on a virtual screen for store feeds), which
  is awkward in a container.
- The self-update with rollback, the safe shutdown and the backup copy are simple shell scripts
  against systemd; containers would mean rewriting them.

## When to revisit

Switch an app to containers when any of these becomes true:
- it needs a service the machine should not run directly (Postgres, Redis, a search engine);
- it needs a system library version that clashes with another app;
- it moves to a different or shared host, or other people deploy it as the main path;
- two apps' Node or system dependencies start to conflict.

Each new project records this choice in its requirements (architecture area), instead of
skipping it.

## The optional container (for others)

`templates/Dockerfile` builds the app with the repo's Node version; `templates/compose.yaml` runs
the web app and the scheduled jobs (a second service running the job CLI on a loop), with one
volume for `/data` (database, backups) and `.env` from the host. It is tested in CI only for
"builds"; the owner's server is the tested path. Keep it working when the build steps change.
