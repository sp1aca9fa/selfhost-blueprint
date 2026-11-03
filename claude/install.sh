#!/usr/bin/env bash
# Links this blueprint's shared agents and commands into the user's Claude Code folder, so every
# project on this machine sees them (~/.claude/agents, ~/.claude/commands). Only the one-line
# descriptions load into each session; an agent's full text loads only when it runs.
#
#   claude/install.sh            link (an existing link to elsewhere is replaced)
#   claude/install.sh --check    say what is linked, change nothing
#
# A real folder already at either place is never touched: move it aside first. A project's own
# .claude/agents/<name>.md overrides the shared agent of the same name, so projects should not
# keep copies.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
status=0
for name in agents commands; do
  src="$HERE/$name" dst="$TARGET/$name"
  if [ "${1:-}" = "--check" ]; then
    if [ -L "$dst" ] && [ "$(readlink -f "$dst")" = "$src" ]; then echo "$name: linked"
    else echo "$name: not linked"; status=1; fi
    continue
  fi
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "$dst is a real folder: move it aside first (nothing changed for $name)" >&2
    status=1
    continue
  fi
  mkdir -p "$TARGET"
  ln -sfn "$src" "$dst"
  echo "$name: $dst -> $src"
done
exit $status
