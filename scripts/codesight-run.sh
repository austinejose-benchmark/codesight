#!/usr/bin/env bash
# codesight plugin runner — ensures the bundled CLI has its deps, then runs it.
# Called by the /codesight slash command. Passes all args to bin/codesight.mjs.
set -euo pipefail

# Plugin root: set by Claude Code for plugin components; fall back to this file's parent.
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The bundled CLI ships without node_modules (git-ignored). Install once, on first run.
if [ ! -d "$ROOT/node_modules" ]; then
  echo "codesight: first run — installing dependencies (one time)…" >&2
  (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund >&2)
fi

# No args → map the current directory (one-shot: scan + summaries + build).
if [ "$#" -eq 0 ]; then
  set -- .
fi

exec node "$ROOT/bin/codesight.mjs" "$@"
