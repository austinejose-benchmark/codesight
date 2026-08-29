// The enrich pass: generate lean, file-level summaries and cache them by content
// hash. Deterministic parts (hashing, caching, batching, merge) live here; the
// actual model call is behind a pluggable provider (anthropic | mock).
//
// Cache: .codesight/cache/<sha>.json keyed by file content hash — a re-run only
// summarises files whose content changed. Output: .codesight/summaries.json,
// keyed by path, which `codesight build` merges into the map.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CONTENT_CAP = 6000; // chars of file content sent to the model per file
const hashOf = (c) => createHash('sha256').update(c).digest('hex').slice(0, 16);

export async function enrich(projectRoot, outDir, opts = {}) {
  const structPath = join(outDir, 'structure.json');
  if (!existsSync(structPath)) throw new Error('no structure.json — run `codesight scan` first');
  const structure = JSON.parse(readFileSync(structPath, 'utf8'));

  const cacheDir = join(outDir, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const summariesPath = join(outDir, 'summaries.json');
  const summaries = existsSync(summariesPath) ? JSON.parse(readFileSync(summariesPath, 'utf8')) : {};

  let targets = structure.files;
  if (opts.paths && opts.paths.length) targets = targets.filter((f) => opts.paths.includes(f.path));

  // Split into cache-hits (reuse) and to-do (need summarising).
  const todo = [];
  let reused = 0;
  for (const f of targets) {
    let content;
    try { content = readFileSync(join(projectRoot, f.path), 'utf8'); } catch { continue; }
    const hash = hashOf(content);
    const cachePath = join(cacheDir, `${hash}.json`);
    if (existsSync(cachePath) && !opts.force) {
      const c = JSON.parse(readFileSync(cachePath, 'utf8'));
      summaries[f.path] = { hash, summary: c.summary, notes: c.notes || [] };
      reused++;
    } else {
      todo.push({
        path: f.path, hash, language: f.language,
        functions: (f.functions || []).map((x) => x.name),
        content: content.length > CONTENT_CAP ? `${content.slice(0, CONTENT_CAP)}\n…[truncated]` : content,
      });
    }
  }

  if (todo.length) {
    const provider = await loadProvider(opts);
    const batchSize = opts.batchSize || 8;
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      const results = await provider.summarize(batch);
      const byPath = new Map(results.map((r) => [r.path, r]));
      for (const t of batch) {
        const r = byPath.get(t.path) || { summary: '', notes: [] };
        writeFileSync(join(cacheDir, `${t.hash}.json`), JSON.stringify({ summary: r.summary || '', notes: r.notes || [] }));
        summaries[t.path] = { hash: t.hash, summary: r.summary || '', notes: r.notes || [] };
      }
      if (opts.onProgress) opts.onProgress(Math.min(i + batchSize, todo.length), todo.length);
    }
  }

  writeFileSync(summariesPath, JSON.stringify(summaries, null, 1));
  return { targeted: targets.length, reused, summarized: todo.length };
}

async function loadProvider(opts) {
  const name = opts.provider || 'anthropic';
  const mod = await import(`./${name}.mjs`);
  return mod.createProvider({ model: opts.model });
}
