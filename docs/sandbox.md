# The Claude Code sandbox

Every project runs Claude Code in its sandbox. The sandbox confines shell commands: file writes
only inside the project (and listed caches), network only to listed domains. It protects against
a wrong command and against instructions hidden in fetched content; it should not get in the way
of normal work.

## Baseline (`templates/.claude/settings.json`, committed)

- `sandbox.enabled: true`, `failIfUnavailable: true` (no silent fallback to no sandbox),
  `allowUnsandboxedCommands: false`.
- Network: the npm registry, GitHub (`github.com`, `*.github.com`, `*.githubusercontent.com`),
  and the documentation sites the project's providers publish. Nothing else by default.
- Writes beyond the project: package-manager caches only (`~/.cache`, `~/.local/share/pnpm`,
  `~/.npm`).
- Denied: reading `.env*` files; editing `.claude/**` (Claude cannot loosen its own settings).
- `excludedCommands`: only commands that cannot run sandboxed and are safe (the dev server, the
  page crawler's browser, a production build that needs real sockets). Each one named exactly.

## Per project

- Add the official API domains a one-off check may need, and the project's own public address
  (in `settings.local.json` when it reveals something private, such as a tailnet name).
- Add a `PreToolUse` hook for a hard rule the sandbox cannot express (for example: never touch
  the hosted database), committed in `.claude/hooks/`.
- Denied domains for what must never be reached (a hosted database, a source with `noAi` terms).

## Personal settings (`.claude/settings.local.json`, git-ignored)

Permission allow-lists the owner built up, MCP tool permissions, private domains. Array settings
from both files are combined, so the local file only adds.

## Limits

- ssh to the home server is outside the baseline; the owner runs server commands and pastes the
  output. A project may allow its server's address when the owner wants Claude to read logs
  directly (read-only commands only).
- Some tools need workarounds inside the sandbox (for example `next build`, or pnpm's store lock
  needing `XDG_RUNTIME_DIR`); write them in the private rules' "Commands" section.
