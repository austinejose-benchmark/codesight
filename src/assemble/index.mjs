// Assemble the viewer payload (codesight.json) from the free structure.json,
// merging any lean summaries produced by `codesight enrich`, and inferring a
// default "spine" (the left-rail areas) from the directory layout.
//
// Everything here is deterministic — no LLM. Summaries, if present, come from
// .codesight/summaries.json (written by enrich).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_SEG = /^(tests?|__tests__|spec|e2e)$/i;
const INFRA_SEG = /^(infra|infrastructure|deploy|ops|\.github|k8s|terraform)$/i;
const kindOf = (seg) => (TEST_SEG.test(seg) ? 'test' : INFRA_SEG.test(seg) ? 'infra' : 'code');

const segs = (p) => p.split('/');
const humanize = (dir) =>
  dir.replace(/\/$/, '').split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Group files into left-rail "areas". Strategy: group by the first path
 * segment; if one segment dominates (a source root like `src/`), expand it one
 * level deeper so `src/access`, `src/core`, … become their own areas.
 */
function inferAreas(files) {
  const paths = files.map((f) => f.path);
  // Group by first segment; decide which first-segments to expand one level:
  // a big directory (>12 files) with clear structure (>=3 distinct subdirs).
  const byFirst = new Map();
  for (const p of paths) {
    const s = segs(p)[0];
    if (!byFirst.has(s)) byFirst.set(s, []);
    byFirst.get(s).push(p);
  }
  const expand = new Set();
  for (const [s, group] of byFirst) {
    const subs = new Set(group.filter((q) => segs(q).length > 2).map((q) => segs(q)[1]));
    if (group.length > 12 && subs.size >= 3) expand.add(s);
  }
  const keyOf = (p) => {
    const parts = segs(p);
    if (parts.length < 2) return '(root)';
    if (expand.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
    return parts[0];
  };
  const groups = new Map();
  for (const p of paths) groups.set(keyOf(p), (groups.get(keyOf(p)) || 0) + 1);
  const areas = [...groups.entries()]
    .map(([dir, n]) => ({ dir, n, kind: kindOf(segs(dir).pop()) }))
    .sort((a, b) => {
      const order = { code: 0, infra: 1, test: 2 };
      return (order[a.kind] - order[b.kind]) || b.n - a.n || a.dir.localeCompare(b.dir);
    });
  return { areas, keyOf };
}

function readJSON(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function assemble(structure, outDir) {
  const summaries = readJSON(join(outDir, 'summaries.json')) || {};
  const arch = readJSON(join(outDir, 'architecture.json')); // rich layer, may be null

  const { areas, keyOf } = inferAreas(structure.files);
  const files = structure.files.map((f) => {
    const s = summaries[f.path];
    return { ...f, summary: s?.summary || '', notes: s?.notes || [], area: keyOf(f.path) };
  });
  const enrichedCount = files.filter((f) => f.summary).length;
  const hasArch = Boolean(arch && Array.isArray(arch.spine) && arch.spine.length);

  // Spine: the architect's request flow if present, else directory areas.
  const spine = hasArch
    ? arch.spine.map((s, i) => ({ id: s.id || `stage-${i}`, n: i + 1, title: s.title, blurb: s.blurb || '', files: s.files || [], diagram: s.diagram || '', kind: 'stage' }))
    : areas.map((a) => ({ id: `area:${a.dir}`, title: a.dir === '(root)' ? 'root' : a.dir, dir: a.dir, kind: a.kind, n: a.n }));

  const overview = {
    name: structure.project.name,
    description: (arch && arch.purpose) || structure.project.description || '',
    invariants: (arch && arch.invariants) || [],
    badges: [
      `${structure.stats.files} files`,
      `${structure.stats.functions} functions`,
      ...(hasArch ? [`${(arch.domains || []).length} domains`] : []),
      ...(enrichedCount ? [`${enrichedCount} summarised`] : ['structure-only']),
    ],
    stats: [
      { label: 'Files', value: String(structure.stats.files) },
      { label: 'Functions', value: String(structure.stats.functions) },
      { label: 'Classes', value: String(structure.stats.classes) },
      ...(hasArch ? [{ label: 'Domains', value: String((arch.domains || []).length) }] : []),
      { label: 'Languages', value: String(structure.project.languages.length) },
      { label: 'Areas', value: String(areas.length) },
    ],
    areas: areas.map((a) => ({ ...a, blurb: `${a.n} files` })),
    languages: structure.project.languages,
  };

  return {
    version: 1,
    generatedAt: structure.generatedAt,
    git: structure.git,
    project: structure.project,
    overview,
    hasArch,
    spine,
    domains: (arch && arch.domains) || [],
    tools: (arch && arch.tools) || [],
    concerns: (arch && arch.concerns) || [],
    stores: (arch && arch.stores) || [],
    infra: (arch && arch.infra) || [],
    diagram: (arch && arch.diagram) || '',
    files,
  };
}
