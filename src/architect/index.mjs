// The architect pass: one cached LLM synthesis over the file summaries + structure
// that produces the "rich layer" — the request-flow spine, business domains
// (entities / rules / flows), data stores, infrastructure, and a whole-request
// sequence diagram. This is the expensive-but-optional tier that makes the map
// read like a real architecture map rather than a file tree.
//
// Uses the same provider as enrich (default: the user's Claude Code). One call,
// cached by a hash of the summaries so it only re-runs when they change.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadProvider } from '../enrich/provider.mjs';

// Bump when the SYSTEM shape changes — it is folded into the cache key so a new
// prompt forces one clean regeneration instead of returning stale JSON.
const PROMPT_VERSION = '2-tools-concerns-stage-diagrams';

const SYSTEM = `You are a software architect turning a codebase into an interactive map.
You are given the project name, its languages, and a list of files — each with a one-line summary, notes, its function names, and its internal imports.
From THIS EVIDENCE ONLY (do not invent files), produce a single JSON object with this exact shape:

{
  "purpose": "<1-2 sentences: what this codebase is and does, business-first>",
  "invariants": ["<up to 4 load-bearing rules/constraints the code enforces>"],
  "spine": [                       // the main runtime path, IN ORDER (6-10 stages)
    {"id":"kebab","title":"<stage>","blurb":"<1-2 sentences: what happens here>","files":["<real path>", ...],
     "diagram":"sequenceDiagram\\n  ...<a valid mermaid sequenceDiagram of what happens INSIDE this stage>..."}
  ],
  "domains": [                     // business/functional areas (2-8)
    {"id":"kebab","name":"<Human Name>","summary":"<1-2 sentences>",
     "entities":["<key domain objects>"], "rules":["<important business rules/invariants>"],
     "files":["<real path>", ...],
     "flows":[{"name":"<business flow>","steps":[{"name":"<step>","file":"<real path or null>"}]}]}
  ],
  "tools": [                       // the concrete operations this service exposes to callers (MCP tools, HTTP routes, CLI commands) — up to 12
    {"id":"kebab","name":"<exact operation name, e.g. get_prices>","summary":"<1 sentence>",
     "inputs":["<param — what it is>", ...], "files":["<real path>", ...], "rules":["<key rule/guard>", ...],
     "howItWorks":"<2-4 sentences: the path a call takes end to end>",
     "diagram":"sequenceDiagram\\n  ...<a valid mermaid sequenceDiagram of THIS tool's request to response>..."}
  ],
  "concerns": [                    // cross-cutting mechanisms every call passes through (Authorization, Entitlements, ...) — 0-6
    {"id":"kebab","label":"<Human Name>","detail":"<1-2 sentences>",
     "diagram":"sequenceDiagram\\n  ...<a valid mermaid sequenceDiagram of how this mechanism works>..."}
  ],
  "stores": [                      // external data stores / services the code talks to (0-8)
    {"id":"kebab","label":"<name>","kind":"database|cache|queue|external|file","detail":"<1-2 sentences>"}
  ],
  "infra": [                       // deployment/infra pieces, if any (0-8); [] if none
    {"id":"kebab","label":"<name>","detail":"<1-2 sentences>"}
  ],
  "diagram": "sequenceDiagram\\n  ...<a valid mermaid sequenceDiagram of ONE typical end-to-end request/main flow>..."
}

Rules: every file path must be one of the given paths, verbatim. The spine is the ONE main flow a request/invocation travels — order matters. "tools" are the concrete operations callers invoke, named exactly as the code exposes them. Every "diagram" (each spine stage, each tool, each concern, and the top-level one) must be valid mermaid sequenceDiagram syntax: simple one-word participant aliases, no parentheses or colons inside messages, and detailed enough to show the real request-to-response steps. Keep it tight (<=10 stages, <=8 domains, <=6 flows/domain, <=8 steps/flow, <=12 tools, <=6 concerns, <=8 stores). Output ONLY the JSON object, no prose, no code fences.`;

function buildUser(input) {
  const lines = input.files.map((f) => {
    const fns = f.functions.length ? ` | fns: ${f.functions.join(', ')}` : '';
    const imp = f.imports.length ? ` | imports: ${f.imports.map((p) => p.split('/').pop()).join(', ')}` : '';
    return `- ${f.path} — ${f.summary || '(no summary)'}${fns}${imp}`;
  });
  return `PROJECT: ${input.name}\nLANGUAGES: ${input.languages.join(', ')}\nFILES (${input.files.length}):\n${lines.join('\n')}\n\nReturn the JSON object now.`;
}

function parseArch(text) {
  let obj = {};
  const m = text.match(/\{[\s\S]*\}/);
  try { obj = JSON.parse(m ? m[0] : text); } catch { /* leave empty */ }
  return {
    purpose: obj.purpose || '',
    invariants: Array.isArray(obj.invariants) ? obj.invariants : [],
    spine: Array.isArray(obj.spine) ? obj.spine : [],
    domains: Array.isArray(obj.domains) ? obj.domains : [],
    tools: Array.isArray(obj.tools) ? obj.tools : [],
    concerns: Array.isArray(obj.concerns) ? obj.concerns : [],
    stores: Array.isArray(obj.stores) ? obj.stores : [],
    infra: Array.isArray(obj.infra) ? obj.infra : [],
    diagram: typeof obj.diagram === 'string' ? obj.diagram : '',
  };
}

export async function architect(projectRoot, outDir, opts = {}) {
  const structure = JSON.parse(readFileSync(join(outDir, 'structure.json'), 'utf8'));
  const summariesPath = join(outDir, 'summaries.json');
  const summaries = existsSync(summariesPath) ? JSON.parse(readFileSync(summariesPath, 'utf8')) : {};

  const input = {
    name: structure.project.name,
    languages: structure.project.languages,
    files: structure.files.map((f) => ({
      path: f.path,
      summary: summaries[f.path]?.summary || '',
      functions: (f.functions || []).map((x) => x.name).slice(0, 10),
      imports: f.imports || [],
    })),
  };

  const hash = createHash('sha256').update(PROMPT_VERSION + '\n' + JSON.stringify(input)).digest('hex').slice(0, 16);
  const cachePath = join(outDir, 'architecture.json');
  if (existsSync(cachePath) && !opts.force) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (cached._hash === hash) return cached;
    } catch { /* rebuild */ }
  }

  const { provider } = await loadProvider(opts);
  const text = await provider.complete({ system: SYSTEM, user: buildUser(input), maxTokens: 16000 });
  const arch = parseArch(text);

  // Drop any file references the model invented (keep to real paths).
  const real = new Set(structure.files.map((f) => f.path));
  const clean = (paths) => (paths || []).filter((p) => real.has(p));
  arch.spine = arch.spine.map((s) => ({ ...s, files: clean(s.files) }));
  arch.domains = arch.domains.map((d) => ({
    ...d, files: clean(d.files),
    flows: (d.flows || []).map((fl) => ({ ...fl, steps: (fl.steps || []).map((st) => ({ ...st, file: real.has(st.file) ? st.file : null })) })),
  }));
  arch.tools = (arch.tools || []).map((t) => ({ ...t, files: clean(t.files) }));
  arch._hash = hash;

  writeFileSync(cachePath, JSON.stringify(arch, null, 1));
  return arch;
}
