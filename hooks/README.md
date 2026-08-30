# Hooks (future)

Add Claude Code lifecycle hooks in `hooks/hooks.json` (auto-discovered on install).
These fire on Claude Code events — session start, after a tool runs, etc. — **not**
on git events.

Example idea: a `SessionStart` hook that runs `codesight update` so the map is
fresh when you open the repo. Call the bundled CLI via
`${CLAUDE_PLUGIN_ROOT}/scripts/codesight-run.sh`.

> Do not confuse this with the git pre-commit hook that `codesight hook` installs —
> that one is a plain git hook, a separate thing.

Nothing here yet — this folder is a placeholder.
