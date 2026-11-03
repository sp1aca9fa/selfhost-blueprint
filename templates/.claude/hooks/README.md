# Hooks

Committed `PreToolUse` hooks for hard rules the sandbox cannot express (example: Tora's
`no-turso.py` blocks any shell command that touches the hosted database). A hook reads the tool
call as JSON on stdin and exits 2 with a reason on stderr to block it. Register it in
`.claude/settings.json` under `hooks.PreToolUse` with `"matcher": "Bash"` and
`"command": "python3 \"${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>.py\""`.
