# codesight

Turn any repository into an **explorable architecture map** — land on the
high-level flow, drill down through **files → functions → call graph**, and jump
to the exact line on GitHub.

Built to be cheap. The whole navigable skeleton comes from deterministic
**tree-sitter** parsing — no LLM, no network. The only paid part is a **lean,
file-level summary pass** (one sentence + a logic note per file), generated once
and cached by content hash.

It deliberately does *not* produce per-function prose, tours, layers, or
business-domain graphs — that scope is what keeps it roughly an order of
magnitude cheaper than a full knowledge-graph tool.

## Pipeline

```
  scan  ──►  enrich  ──►  build
 (free)     (lean LLM)   (viewer)
```

| Command | Does | Cost |
|---|---|---|
| `codesight scan [path]` | tree-sitter structure → `.codesight/structure.json` | **0 tokens** |
| `codesight enrich [--all]` | lean file summaries, cached by hash | one lean pass |
| `codesight build [--open]` | assemble + emit a standalone HTML viewer | — |
| `codesight serve [--open]` | live dashboard your agent CLI drives | 0 tokens (jev optional) |
| `codesight mcp` | MCP server for Claude Code / Codex | 0 tokens |

The map is fully navigable at zero summaries; the summaries just make it read nicely.

## Keeping it fresh (incremental)

```
codesight update            # only re-do the files that changed + show their impact
codesight hook              # install a pre-commit hook (fast, structure-only)
codesight hook --github     # a CI workflow that refreshes the map on every PR
```

`update` reads the git diff (`--base <ref>` for a PR, `--staged` for a commit),
re-summarises only the changed files, refreshes the links, and prints which other
files import them — the architect (flow/domains) is reused, not re-run. The map
lives in `.codesight/` in the repo (like understand-anything's `.ua/`); the paid
`summaries.json` + `architecture.json` are committed as a portable cache.

## Live dashboard — ask in your terminal, the map follows

```
codesight serve --open      # live dashboard at http://127.0.0.1:4747
```

Keep asking questions in Claude Code (or Codex) as normal. The dashboard reacts:

1. **You press Enter** → a prompt hook sends the question to `codesight serve`.
2. **The router picks the part of the map** (tool, stage, domain, concern) in
   ~1–15 ms locally, or with [jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
   when `TYPESAFE_API_KEY` is set. Clear match → the dashboard jumps. Close call →
   "Did you mean" chips. Off-topic prompt → nothing happens.
3. **The agent answers** using codesight's MCP tools (MCP — Model Context
   Protocol, how agent CLIs call outside tools). It reads the map before the
   source, then points the dashboard at what it explains: `show`, `highlight`,
   `show_code` (exact lines), and `show_diagram` (architecture, user journey,
   sequence, data flow, lifecycle).

Also in the dashboard: **⌘K** (or `/`) searches every file, function, tool and
stage instantly, and "Show code" opens the real code inline — with syntax colours,
function starts marked, and the lines Claude cites highlighted (far-apart ranges fold
the lines between them, like GitHub).

### Learn your way

On first open the dashboard asks **how you learn best**. You can change it any time from the header:

| | What changes |
|---|---|
| **Visual** | Diagrams first. Longer text folds under "Read more". |
| **Text** | Words first. Diagrams wait behind a "Show diagram" button. |
| **Beginner** | Every tool, stage, concern and domain opens with a simple card: one everyday comparison + 3–4 picture steps. |
| **Developer** | The card folds to "Explain simply". |

- **Simple cards** are made in every `codesight` run, after the architect: one small
  Haiku call, cached per section in `.codesight/simple.json` (commit it). Skip with `--no-simple`.
- **Draw this**: on each tool / stage / concern / domain, ask for an Architecture,
  User journey, Sequence, Data flow or Lifecycle diagram. `codesight serve` asks
  Claude under your login (a few seconds), then caches it in `.codesight/diagrams.json`
  (commit it) — instant for you and your teammates after that.
- Your style reaches the agent too: `get_overview` returns it, and the prompt hook adds
  one short line per prompt while the dashboard runs, so Claude draws more for visual
  learners and uses plain words and `show_simple` cards for beginners.

### Learning path + quiz

The overview offers **"Learn this repo in about 30 minutes"**: the request-flow stages
in order. Each step shows the simple card, the diagram, the **key code** (one function,
highlighted), then a short quiz:

- **2 multiple-choice questions** — checked in the browser, instantly, 0 tokens. Every
  option explains why it is right or wrong.
- **Explain it back** — write it in your own words; Claude checks it against the key
  points in a few seconds (needs `codesight serve`).

Progress and scores are saved in your browser; the finish page lists the steps worth
another look. The quiz is made in every `codesight` run after the cards, cached per
stage in `.codesight/quiz.json` (commit it). Skip with `--no-quiz`.

codesight's own model calls run `claude -p` in a lean mode (no MCP servers, plugins,
hooks, or thinking). The beginner-card pass went from 120 s to 15 s.

With jev, only your question and the map's names/summaries leave the machine —
never code. The server listens on `127.0.0.1` only.

**Claude Code:** installing the plugin sets up the MCP server and the prompt hook.

**Codex:** add the MCP server to `~/.codex/config.toml` (add
`"--root", "/path/to/repo"` to `args` if Codex starts it outside the repo):

```toml
[mcp_servers.codesight]
command = "node"
args = ["/path/to/codesight/bin/codesight.mjs", "mcp"]
```

Codex has no prompt hook, so its dashboard moves when the agent calls `show`, not on Enter.

**No API key needed.** Inside a Claude Code session, summaries are generated by
your own Claude Code (the `claude` CLI, headless) under your existing login —
`codesight <path>` runs scan + summaries + map in one shot. `ANTHROPIC_API_KEY`
is only a fallback for standalone/CI use without Claude Code.

## Status

Scaffolding in progress — see the build order:

1. Repo skeleton ✅
2. Vendor the tree-sitter scanner → `codesight scan`
3. Assemble + viewer → a working zero-token explorer
4. `enrich` — lean, cached summaries
5. Spine inference + `codesight.config.json`
6. Tests, examples, publish

## Credits

The deterministic extractor is vendored from
[Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) (MIT) —
see [`NOTICE`](NOTICE). codesight is MIT licensed.
