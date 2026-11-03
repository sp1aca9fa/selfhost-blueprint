# The main PC (Windows + WSL)

The owner develops on a Windows PC inside WSL (Ubuntu), where Claude Code runs. The PC is not a
server: it is often off, so nothing the apps need every day runs here. It keeps the off-box backup
copies and the analysis copies, and is where Claude reads data from.

## Folders

| What | Where (WSL) |
|---|---|
| projects | `~/code/<<GROUP>>/<<APP>>` |
| this blueprint | `~/code/<<GROUP>>/selfhost-blueprint` (agents linked into `~/.claude`) |
| off-box backup copies | `~/backups/<<APP>>/` (one folder per app) |
| analysis copy | `~/.local/share/<<APP>>/analysis/<<APP>>.db` |
| copy logs | `~/.local/state/<<APP>>/copy-backups.log` |

A local development database and its backups (if any) stay in the app's normal data folder,
never in `~/backups/`, so the mirror never deletes or mixes them.

## The backup copy (`ops/copy-backups.sh`)

Each app ships the same script shape (template: `templates/ops/copy-backups.sh`):

```bash
ops/copy-backups.sh <<SERVER_ALIAS>> ~/backups/<<APP>>            # copy now
ops/copy-backups.sh install <<SERVER_ALIAS>> ~/backups/<<APP>>    # the Windows task
```

- It counts the server's non-empty backups over ssh (BatchMode, no prompts) and mirrors them with
  rsync. Deletions mirror the server's pruning only when the server holds 3 or more backups; with
  fewer (a new or wiped disk) nothing is deleted here. A failed count stops the run without
  copying or deleting.
- It then unpacks the newest backup into the analysis copy: to a `.part` file, SQLite's integrity
  check (when `sqlite3` is installed), WAL and SHM files of the old copy removed, moved into place,
  and given the backup's time (so a rewritten same-day backup refreshes it).
- It refuses to run when `CI` or `VERCEL` is set.

## Windows tasks without a window

A task that starts `wsl.exe` directly opens a console window each run; closing it kills the run
mid-copy. The install form registers the task through a hidden console instead:

```
conhost.exe --headless wsl.exe -d <distro> -- bash -lc "<script> <args>"
```

Task settings: 10 minutes after logon and every 6 hours from 00:30, start when available (catches
up after sleep), only with a network, on battery too, 30-minute limit, a second start ignored
while one runs, run as the logged-on user with limited rights. Task names: `<<APP>>-backup-copy`.

Check a task: `powershell.exe -NoProfile -Command "Get-ScheduledTask -TaskName <<APP>>-backup-copy | Get-ScheduledTaskInfo"`.
Result 0 is success; 0xC000013A (3221225786) means the console was closed or WSL shut down.

## Reading data

Claude's read-only tools (MCP servers, queries) open the analysis copy read-only, never the live
database. Its freshness is the copy log's newest backup name. Sources marked `noAi` are left out
of anything Claude reads.

## Talking to the server

The owner runs server commands and pastes the output; long output can be saved under
`private/ops/server-output/<date>-<name>.txt` with a one-off `ssh <<SERVER_ALIAS>> '<command>' >
file`. Non-interactive ssh does not load nvm: put the app's Node link on the `PATH` in the
command.
