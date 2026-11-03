# Tora and Saku against this blueprint

Tora came first; Saku was built from it and grew further. On 2026-11-03 both were compared and
aligned where it paid off. What still differs, and why:

## Aligned (2026-11-03)

| Area | Now in both |
|---|---|
| Claude rules | public `CLAUDE.md` (generic) + private rules imported by `CLAUDE.local.md` |
| Agents | shared agents from this repo; each project's `docs/agents.md` profile with its own models and efforts |
| Reviewer ledger | in the private ops folder (versioned, private) |
| Spec template | public `docs/spec-template.md` |
| Server and PC scripts | public `ops/` (generic), private ops for personal ones |
| Server guide | public (`docs/home-server.md` in Tora, `docs/setup.md` in Saku), private specifics in notes |
| CI | GitHub Actions on every push |
| Off-box backups | `ops/copy-backups.sh` into `~/backups/<app>`, hidden Windows task, analysis copy |

## Still different, on purpose

| Area | Tora | Saku | Why left |
|---|---|---|---|
| Private submodule name | `collectors/` | `plugins/` | Blueprint uses `private/`. Renaming touches the server (one step per app) and every path in docs and scripts; planned as its own task. |
| Requirements | one `requirements.md` + `docs/history.md` | split files, built `REQUIREMENTS.md`, `docs:check` | Migrating Tora's long file costs a lot for little gain while it works. New projects use the split. |
| Environment variables | mostly unprefixed (`BACKUP_DIR`) | prefixed (`SAKU_...`) | Renaming would break the server's `.env`. New projects use the prefix. |
| Plug-in naming | `collector-sdk`, `collectors-public` | `plugin-sdk`, `plugins-public` | Domain names; both fine. New projects use `plugin-sdk`. |
| Texts | `apps/web/messages/` | `packages/content/` | Saku has no web app yet; a new project uses `packages/content`. |
| Sandbox | on (committed baseline, a no-Turso hook) | off | Saku's work needs ssh to the server and live checks today. Recommended: turn it on with the baseline plus the server's address, after the A1 gate. |
| Build of small changes | the orchestrator does small changes itself | builders do almost everything | Saku's trust territory is wider; its `CLAUDE.md` decides. |

## Pending

- Rename both private submodules to `private/` (server step per app, `update-server.sh` path
  handling, docs).
- Saku: commit a sandbox baseline (`.claude/settings.json`; its `.gitignore` then needs to stop
  ignoring `.claude/*`).
- Tora: remove the forwarding stubs in `collectors/ops/` once the server's units point at `ops/`.
