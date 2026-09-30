// The MCP tools codesight gives an agent CLI. Two kinds:
//   read — answer from the map (summaries, flow, imports) instead of grepping
//          the repo: fewer steps, fewer tokens, faster answers.
//   show — drive the user's live dashboard, so it follows the explanation.
//
// Pure over a context: { payload: () => payload, push: async (cmd) => result }.
// `push` sends a UI command to `codesight serve` (see src/mcp/index.mjs).

import { rankByWords } from '../assemble/search.mjs';
import { importersOf, impactOf } from '../assemble/imports.mjs';

const SECTION_KINDS = ['stage', 'tool', 'domain', 'concern', 'store', 'infra'];
const SHOW_KINDS = [...SECTION_KINDS, 'area', 'file', 'overview'];
const DIAGRAM_KINDS = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'];
const MERMAID_START = /^\s*(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|journey|gantt|mindmap|timeline)\b/;
const MAX_MERMAID = 20_000;
const SEARCH_LIMIT = 12;
const HIGHLIGHT_LIMIT = 40;

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

export const TOOLS = [
  {
    name: 'get_overview',
    description: 'Start here. The whole codebase on one page: purpose, rules, the request flow (stages, in order), tools, domains, concerns, data stores. Use the ids with get_section and show.',
    inputSchema: obj({}),
  },
  {
    name: 'search_map',
    description: 'Find files, functions, classes, tools, stages or domains by name or topic. Faster than grep for "where is X" / "what handles Y".',
    inputSchema: obj({ query: str('Words to look for, e.g. "entitlements" or "price history"'), limit: { type: 'number', description: `Max results (default ${SEARCH_LIMIT})` } }, ['query']),
  },
  {
    name: 'get_section',
    description: 'One part of the map in detail: summary, files, rules, inputs, flows, and its mermaid sequence diagram.',
    inputSchema: obj({ kind: str('Section kind', { enum: SECTION_KINDS }), id: str('Section id from get_overview') }, ['kind', 'id']),
  },
  {
    name: 'get_file',
    description: 'One file: summary, logic notes, functions and classes with line ranges, what it imports, and what imports it.',
    inputSchema: obj({ path: str('Repo-relative path, as in the map') }, ['path']),
  },
  {
    name: 'callers',
    description: 'Change impact: which files import this file — directly (level 1) and through other files (level 2+). Use for "what breaks if I change X".',
    inputSchema: obj({ path: str('Repo-relative path'), depth: { type: 'number', description: 'Levels to follow (default 2, max 5)' } }, ['path']),
  },
  {
    name: 'show',
    description: "Open a part of the map on the user's dashboard. Call it as you start explaining that part.",
    inputSchema: obj({ kind: str('What to open', { enum: SHOW_KINDS }), id: str('Section id, area dir, or file path (not needed for overview)') }, ['kind']),
  },
  {
    name: 'highlight',
    description: "Mark the files your answer is about on the user's dashboard. Call it with the files you cite.",
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative file paths' }, note: str('One short line: why these files') }, ['paths']),
  },
  {
    name: 'show_code',
    description: "Show exact lines of a file on the user's dashboard, with the range highlighted. Call it when you point at specific code.",
    inputSchema: obj({ path: str('Repo-relative path'), start: { type: 'number', description: 'First line (1-based)' }, end: { type: 'number', description: 'Last line' }, note: str('One short line: what to look at') }, ['path', 'start']),
  },
  {
    name: 'show_diagram',
    description: "Draw a diagram on the user's dashboard. Use when a picture helps, or the user asks for one: architecture, user journey (workflow), request sequence, data flow, or state lifecycle. Send mermaid; keep labels short.",
    inputSchema: obj({
      kind: str('Diagram kind', { enum: DIAGRAM_KINDS }),
      title: str('Short title, e.g. "Price request — user journey"'),
      mermaid: str('Mermaid source: flowchart, sequenceDiagram, stateDiagram-v2, journey, …'),
    }, ['kind', 'title', 'mermaid']),
  },
];

const ok = (data) => ({ text: typeof data === 'string' ? data : JSON.stringify(data) });
const fail = (text) => ({ text, isError: true });
const pickFields = (x, keys) => Object.fromEntries(keys.filter((k) => x[k] !== undefined && x[k] !== '').map((k) => [k, x[k]]));

function sectionList(p, kind) {
  return { stage: p.hasArch ? p.spine : [], tool: p.tools, domain: p.domains, concern: p.concerns, store: p.stores, infra: p.infra }[kind] || [];
}
const sectionName = (x) => x.name || x.title || x.label || x.id;
const idHint = (p, kind) => `Known ${kind} ids: ${sectionList(p, kind).map((x) => x.id).join(', ') || '(none)'}`;

function overview(p) {
  const o = p.overview;
  return {
    project: o.name,
    purpose: o.description,
    rules: o.invariants,
    stats: Object.fromEntries(o.stats.map((s) => [s.label, s.value])),
    languages: o.languages,
    ...(p.hasArch
      ? {
          stages: p.spine.map((s) => ({ id: s.id, n: s.n, title: s.title, blurb: s.blurb })),
          tools: p.tools.map((t) => pickFields(t, ['id', 'name', 'summary'])),
          domains: p.domains.map((d) => pickFields(d, ['id', 'name', 'summary'])),
          concerns: p.concerns.map((c) => pickFields(c, ['id', 'label', 'detail'])),
          stores: p.stores.map((s) => pickFields(s, ['id', 'label', 'kind'])),
          infra: p.infra.map((x) => pickFields(x, ['id', 'label'])),
        }
      : { areas: o.areas.map((a) => ({ id: a.dir, files: a.n })), note: 'No architecture layer yet (structure only) — use search_map and get_file.' }),
  };
}

function search(p, query, limit) {
  const items = [];
  for (const kind of SECTION_KINDS) for (const x of sectionList(p, kind)) {
    items.push({ label: sectionName(x), text: x.summary || x.blurb || x.detail || '', hit: { kind, id: x.id, name: sectionName(x) } });
  }
  for (const f of p.files) {
    const name = f.path.split('/').pop().replace(/\.[^.]+$/, '');
    items.push({ label: name, text: `${f.path} ${f.summary}`, hit: { kind: 'file', path: f.path, summary: f.summary } });
    for (const d of [...f.functions, ...f.classes]) items.push({ label: d.name, text: f.path, hit: { kind: 'symbol', name: d.name, path: f.path, lines: [d.start, d.end] } });
  }
  return rankByWords(items, query).slice(0, limit).map((r) => r.item.hit);
}

function fileInfo(p, path) {
  const f = p.files.find((x) => x.path === path);
  if (!f) return null;
  const rev = importersOf(p.files);
  return {
    path: f.path,
    language: f.language,
    lines: f.lines,
    summary: f.summary,
    notes: f.notes,
    functions: f.functions.map((d) => ({ name: d.name, lines: [d.start, d.end] })),
    classes: f.classes.map((d) => ({ name: d.name, lines: [d.start, d.end] })),
    imports: f.imports,
    importedBy: rev.get(f.path) || [],
  };
}

async function pushed(ctx, cmd, what) {
  const r = await ctx.push(cmd);
  if (r.ok) return ok(r.clients ? `${what} on the dashboard.` : `${what} — but no dashboard tab is open. The user can open it from \`codesight serve\`.`);
  return ok('Dashboard is not running (start it with `codesight serve`). Nothing else needed — carry on answering.');
}

export async function callTool(name, args = {}, ctx) {
  const p = ctx.payload();
  if (!p) return fail(ctx.missing || 'No codesight map found. Run `codesight` in the repo first.');
  const hasFile = (path) => p.files.some((f) => f.path === path);

  switch (name) {
    case 'get_overview':
      return ok(overview(p));

    case 'search_map': {
      if (!args.query) return fail('query is required');
      const limit = Math.max(1, Math.min(50, Number(args.limit) || SEARCH_LIMIT));
      const hits = search(p, args.query, limit);
      return ok(hits.length ? hits : `No matches for "${args.query}".`);
    }

    case 'get_section': {
      const x = sectionList(p, args.kind).find((s) => s.id === args.id);
      return x ? ok({ kind: args.kind, ...x }) : fail(`No ${args.kind} "${args.id}". ${idHint(p, args.kind)}`);
    }

    case 'get_file': {
      const info = fileInfo(p, args.path);
      return info ? ok(info) : fail(`"${args.path}" is not in the map. Try search_map.`);
    }

    case 'callers': {
      if (!hasFile(args.path)) return fail(`"${args.path}" is not in the map. Try search_map.`);
      const depth = Math.max(1, Math.min(5, Number(args.depth) || 2));
      const levels = impactOf(importersOf(p.files), args.path, depth);
      return ok(levels.length ? { path: args.path, levels } : `Nothing imports ${args.path}.`);
    }

    case 'show': {
      const kind = args.kind;
      if (!SHOW_KINDS.includes(kind)) return fail(`kind must be one of: ${SHOW_KINDS.join(', ')}`);
      if (kind === 'overview') return pushed(ctx, { type: 'open', target: { t: 'overview' } }, 'Opened the overview');
      if (kind === 'file' && !hasFile(args.id)) return fail(`"${args.id}" is not in the map. Try search_map.`);
      if (kind === 'area' && !p.overview.areas.some((a) => a.dir === args.id)) return fail(`No area "${args.id}". Known areas: ${p.overview.areas.map((a) => a.dir).join(', ')}`);
      if (SECTION_KINDS.includes(kind) && !sectionList(p, kind).some((s) => s.id === args.id)) return fail(`No ${kind} "${args.id}". ${idHint(p, kind)}`);
      return pushed(ctx, { type: 'open', target: { t: kind, id: args.id } }, `Opened ${kind} ${args.id}`);
    }

    case 'highlight': {
      const paths = [...new Set((args.paths || []).filter(hasFile))].slice(0, HIGHLIGHT_LIMIT);
      if (!paths.length) return fail('None of those paths are in the map. Use repo-relative paths from search_map / get_file.');
      return pushed(ctx, { type: 'highlight', paths, note: String(args.note || '').slice(0, 200) }, `Highlighted ${paths.length} file(s)`);
    }

    case 'show_code': {
      if (!hasFile(args.path)) return fail(`"${args.path}" is not in the map. Try search_map.`);
      const start = Math.max(1, Math.floor(Number(args.start) || 1));
      const end = Math.max(start, Math.floor(Number(args.end) || start));
      return pushed(ctx, { type: 'code', path: args.path, start, end, note: String(args.note || '').slice(0, 200) }, `Showing ${args.path}:${start}-${end}`);
    }

    case 'show_diagram': {
      const mermaid = String(args.mermaid || '');
      if (!DIAGRAM_KINDS.includes(args.kind)) return fail(`kind must be one of: ${DIAGRAM_KINDS.join(', ')}`);
      if (!MERMAID_START.test(mermaid)) return fail('mermaid must start with a diagram type, e.g. "flowchart TD", "sequenceDiagram", "stateDiagram-v2" or "journey".');
      if (mermaid.length > MAX_MERMAID) return fail(`mermaid is too long (max ${MAX_MERMAID} chars) — simplify the diagram.`);
      return pushed(ctx, { type: 'diagram', kind: args.kind, title: String(args.title || args.kind).slice(0, 120), mermaid }, `Drew "${args.title}"`);
    }

    default:
      return fail(`Unknown tool "${name}".`);
  }
}
