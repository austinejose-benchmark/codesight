---
description: Scan a repo and build or refresh its codesight architecture map
argument-hint: "[path | subcommand] [flags] — e.g. \".\", \"build --open\", \"update\", \"hook\""
allowed-tools: Bash
---

Run the bundled codesight CLI. Pass the user's arguments through unchanged; with
no arguments it maps the current directory (scan + summaries + build in one shot).

Run exactly this, then report the result:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/codesight-run.sh" $ARGUMENTS
```

After it finishes:
- The map is written to `.codesight/` in the target repo — summaries, architecture,
  and a standalone HTML viewer.
- Tell the user it is ready, and that `/codesight build --open` opens the viewer.
- If summaries were skipped (no `claude` CLI login and no `ANTHROPIC_API_KEY`), say
  so plainly — the tree-sitter structure map still works with zero summaries.
