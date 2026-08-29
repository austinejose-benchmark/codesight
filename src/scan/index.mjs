// The scan orchestrator: chains the three vendored extractors into one
// structure.json — the free, deterministic tier (no LLM, no network).
//
//   scan-project  → file inventory (path, language, lines, category)
//   import-map    → file → file import edges
//   structure     → functions, classes, exact line ranges, call graph
//
// Vendored from Understand-Anything (MIT) — see NOTICE.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

function runScript(script, args) {
  const r = spawnSync(NODE, [join(HERE, script), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`${script} failed (exit ${r.status}):\n${r.stderr || r.stdout || '(no output)'}`);
  }
  return r;
}

function gitInfo(projectRoot) {
  const g = (args) => {
    const r = spawnSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const remote = g(['remote', 'get-url', 'origin']);
  const commit = g(['rev-parse', 'HEAD']);
  const branch = g(['rev-parse', '--abbrev-ref', 'HEAD']);
  let base = '';
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/);
  if (m) base = `https://github.com/${m[1]}/${m[2]}`;
  return { base, commit, branch };
}

/**
 * Run the free structure scan over a repo.
 * @param {string} projectRoot  path to the repo to scan
 * @param {string} outDir       where to write structure.json (+ tmp/)
 * @returns {object} the structure.json object
 */
export async function scan(projectRoot, outDir) {
  projectRoot = resolve(projectRoot);
  const tmp = join(outDir, 'tmp');
  mkdirSync(tmp, { recursive: true });

  // 1 — enumerate files
  const scanOut = join(tmp, 'scan.json');
  runScript('scan-project.mjs', [projectRoot, scanOut]);
  const inv = JSON.parse(readFileSync(scanOut, 'utf8'));
  const code = inv.files.filter((f) => f.fileCategory === 'code');

  // 2 — import edges
  const impIn = join(tmp, 'imports-in.json');
  const impOut = join(tmp, 'imports-out.json');
  writeFileSync(impIn, JSON.stringify({
    projectRoot,
    files: code.map((f) => ({ path: f.path, language: f.language, fileCategory: f.fileCategory })),
  }));
  runScript('extract-import-map.mjs', [impIn, impOut]);
  const importMap = JSON.parse(readFileSync(impOut, 'utf8')).importMap || {};

  // 3 — structure (functions, classes, line ranges, call graph)
  const stIn = join(tmp, 'structure-in.json');
  const stOut = join(tmp, 'structure-out.json');
  writeFileSync(stIn, JSON.stringify({ projectRoot, batchFiles: code, batchImportData: importMap }));
  runScript('extract-structure.mjs', [stIn, stOut]);
  const st = JSON.parse(readFileSync(stOut, 'utf8'));
  const byPath = new Map(st.results.map((r) => [r.path, r]));

  // 4 — assemble the per-file records
  const files = code.map((f) => {
    const r = byPath.get(f.path) || {};
    return {
      path: f.path,
      language: f.language,
      lines: f.sizeLines,
      summary: '',   // filled by `codesight enrich`
      notes: [],     // filled by `codesight enrich`
      functions: (r.functions || []).map((x) => ({ name: x.name, start: x.startLine, end: x.endLine })),
      classes: (r.classes || []).map((x) => ({ name: x.name, start: x.startLine, end: x.endLine })),
      calls: (r.callGraph || []).map((c) => ({ caller: c.caller, callee: c.callee, line: c.lineNumber })),
      imports: importMap[f.path] || [],
    };
  });

  const structure = {
    version: 1,
    generatedAt: new Date().toISOString(),
    git: gitInfo(projectRoot),
    project: {
      name: basename(projectRoot),
      languages: Object.keys(inv.stats?.byLanguage || {}).sort(),
      description: '',
    },
    stats: {
      files: files.length,
      functions: files.reduce((n, f) => n + f.functions.length, 0),
      classes: files.reduce((n, f) => n + f.classes.length, 0),
      byLanguage: inv.stats?.byLanguage || {},
    },
    files,
  };

  writeFileSync(join(outDir, 'structure.json'), JSON.stringify(structure, null, 1));
  return structure;
}
