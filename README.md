# selfhost-blueprint

The pattern behind the owner's self-hosted apps (first Tora, then Saku), written down so a new
project starts from the settled version instead of copying an older app and its drift.

The apps share one shape: an agnostic core that anyone can run on their own machine, data brought
in through plug-ins, the owner's personal parts in a private submodule, a home server that runs
everything, and Claude Code building and reviewing changes through a fixed loop of agents.

## What is here

| Path | What it is |
|---|---|
| [docs/pattern.md](docs/pattern.md) | The architecture: agnostic core, plug-ins, raw data only, public and private |
| [docs/repo-layout.md](docs/repo-layout.md) | Folders, names, environment variables, where data lives |
| [docs/claude-setup.md](docs/claude-setup.md) | Public and private rules, the agent profile, the loop, the owner's files |
| [docs/sandbox.md](docs/sandbox.md) | The Claude Code sandbox baseline and when to add to it |
| [docs/ci.md](docs/ci.md) | What CI runs and why every project has it |
| [docs/containers.md](docs/containers.md) | Why the owner's server runs without containers, and the optional ones for others |
| [docs/home-server.md](docs/home-server.md) | The mini PC: box, Node, services, address, watch, backups, updates, shutdown |
| [docs/main-pc.md](docs/main-pc.md) | The owner's main PC (Windows + WSL): backup copies, analysis copy, hidden tasks |
| [docs/new-project.md](docs/new-project.md) | Starting a new project from this blueprint, step by step |
| [docs/alignment.md](docs/alignment.md) | Where Tora and Saku still differ from this blueprint, and why |
| [claude/](claude/README.md) | The shared agents and `/ship`, linked into `~/.claude` by `claude/install.sh` |
| [templates/](templates/) | Files to copy into a new project (rename `myapp`, `MyApp`, `MYAPP`) |

## Setting up a machine

```bash
git clone <<THIS_REPO_URL>> ~/code/selfhost-blueprint    # or wherever your projects live
~/code/selfhost-blueprint/claude/install.sh             # links the shared agents into ~/.claude
```

Replace `<<THIS_REPO_URL>>` with this repo's clone address (GitHub > Code > SSH).

The global git ignore keeps only personal Claude files out of every repo (`CLAUDE.local.md`,
`.claude/settings.local.json`); `CLAUDE.md` and `.claude/` are committed (see
[claude-setup.md](docs/claude-setup.md)).
