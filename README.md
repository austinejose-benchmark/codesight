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

The map is fully navigable at zero summaries; `enrich` just makes it read nicely.

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
