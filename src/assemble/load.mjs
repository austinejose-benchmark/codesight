// Load the viewer payload for long-running processes (`serve`, `mcp`). The map
// files can change underneath them (`codesight update`), so the payload is
// re-assembled whenever one of them changes on disk — and reused otherwise.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assemble } from './index.mjs';

const MAP_FILES = ['structure.json', 'summaries.json', 'architecture.json', 'simple.json', 'diagrams.json', 'quiz.json'];

export function payloadLoader(outDir) {
  const paths = MAP_FILES.map((f) => join(outDir, f));
  let stamp = '';
  let payload = null;
  return () => {
    const now = paths.map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0)).join(':');
    if (now !== stamp || !payload) {
      payload = assemble(JSON.parse(readFileSync(paths[0], 'utf8')), outDir);
      stamp = now;
    }
    return payload;
  };
}

// Walk up from `start` to the nearest repo that has a codesight map.
export function findMapDir(start) {
  let dir = start;
  for (;;) {
    const outDir = join(dir, '.codesight');
    if (existsSync(join(outDir, 'structure.json'))) return { projectRoot: dir, outDir };
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
