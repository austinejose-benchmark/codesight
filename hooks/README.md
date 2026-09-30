# Hooks

Claude Code lifecycle hooks, declared in `hooks/hooks.json` (auto-discovered on
install). These fire on Claude Code events — **not** on git events.

- **UserPromptSubmit** → `scripts/codesight-route.mjs`. Sends each prompt to a
  running `codesight serve`, so the dashboard jumps to the right part of the map
  before Claude answers. No dependencies, prints nothing (a UserPromptSubmit
  hook's output would be added to Claude's context), exits in well under a
  second, and does nothing when `serve` is not running.

> Do not confuse these with the git pre-commit hook that `codesight hook`
> installs — that one is a plain git hook, a separate thing.
