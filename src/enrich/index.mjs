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
import { loadProvider } from './provider.mjs';

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
    const loaded = await loadProvider(opts);
    usedProvider = loaded.name;
    const provider = loaded.provider;
    const batchSize = opts.batchSize || 8;
    const concurrency = Math.max(1, opts.concurrency || 4);
    const batches = [];
    for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));

    let next = 0;
    let done = 0;
    const writeBatch = (batch, results) => {
      const byPath = new Map(results.map((r) => [r.path, r]));
      for (const t of batch) {
        const r = byPath.get(t.path) || { summary: '', notes: [] };
        // Cache each file individually — so even a crashed run keeps the tokens
        // it already spent (a re-run rebuilds summaries.json from the cache).
        writeFileSync(join(cacheDir, `${t.hash}.json`), JSON.stringify({ summary: r.summary || '', notes: r.notes || [] }));
        summaries[t.path] = { hash: t.hash, summary: r.summary || '', notes: r.notes || [] };
      }
      done += batch.length;
      if (opts.onProgress) opts.onProgress(done, todo.length);
    };
    // Fan the batch calls out concurrently to cut wall-clock time.
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        writeBatch(batch, await provider.summarize(batch));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  }

  writeFileSync(summariesPath, JSON.stringify(summaries, null, 1));
  return { targeted: targets.length, reused, summarized: todo.length, provider: usedProvider };
}

let usedProvider = null;
