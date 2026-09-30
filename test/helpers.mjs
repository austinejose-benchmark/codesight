// A tiny mapped repo, written to a temp dir: source files + a .codesight/ map
// (structure, summaries, architecture) shaped like real codesight output.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const FILES = {
  'src/server.ts': { fns: [['main', 1, 10]], imports: ['src/tools/get-prices.ts', 'src/auth/entitlements.ts'], summary: 'MCP server entry point; registers the tools.' },
  'src/tools/get-prices.ts': { fns: [['getPrices', 2, 9]], imports: ['src/auth/entitlements.ts', 'src/db/client.ts'], summary: 'The get_prices tool: validates input, checks entitlements, queries prices.' },
  'src/auth/entitlements.ts': { fns: [['checkEntitlement', 1, 6]], imports: ['src/db/client.ts'], summary: 'Checks the caller is entitled to a market before data is returned.' },
  'src/db/client.ts': { classes: [['DbClient', 1, 5]], imports: [], summary: 'Postgres client wrapper; summary with $& and $\' patterns.' },
};

export const STRUCTURE = {
  version: 1,
  generatedAt: '2026-09-30T00:00:00.000Z',
  git: { base: 'https://github.com/example/mini', commit: 'abc1234', branch: 'main' },
  project: { name: 'mini', languages: ['typescript'], description: '' },
  stats: { files: 4, functions: 3, classes: 1 },
  files: Object.entries(FILES).map(([path, f]) => ({
    path,
    language: 'typescript',
    lines: 12,
    functions: (f.fns || []).map(([name, start, end]) => ({ name, start, end })),
    classes: (f.classes || []).map(([name, start, end]) => ({ name, start, end })),
    calls: [],
    imports: f.imports,
  })),
};

export const ARCHITECTURE = {
  purpose: 'Serves commodity prices to AI agents over MCP.',
  invariants: ['Every tool call is entitlement-checked'],
  spine: [
    { id: 'bootstrap', title: 'Server bootstrap', blurb: 'Starts the MCP server and registers tools.', files: ['src/server.ts'], diagram: 'sequenceDiagram\n  A->>B: start' },
    { id: 'auth', title: 'Authorization', blurb: 'Verifies the caller token.', files: ['src/auth/entitlements.ts'] },
    { id: 'query', title: 'Database query', blurb: 'Reads rows from Postgres.', files: ['src/db/client.ts'] },
  ],
  domains: [{ id: 'pricing', name: 'Pricing', summary: 'Price series for battery metals.', files: ['src/tools/get-prices.ts'], flows: [] }],
  tools: [
    { id: 'get-prices', name: 'get_prices', summary: 'Latest and historical prices for a market.', files: ['src/tools/get-prices.ts'], diagram: 'sequenceDiagram\n  U->>S: get_prices' },
    { id: 'get-supply', name: 'get_supply', summary: 'Mine supply by country.', files: [] },
  ],
  concerns: [{ id: 'entitlements', label: 'Entitlements', detail: 'Only markets on the client plan are returned.' }],
  stores: [{ id: 'postgres', label: 'Postgres', kind: 'database', detail: 'The warehouse.' }],
  infra: [],
  diagram: 'sequenceDiagram\n  U->>S: call',
};

export function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'codesight-test-'));
  for (const path of Object.keys(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), Array.from({ length: 12 }, (_, i) => `// ${path} line ${i + 1}`).join('\n'));
  }
  writeFileSync(join(root, 'secret.txt'), 'not in the map');
  const outDir = join(root, '.codesight');
  mkdirSync(outDir);
  writeFileSync(join(outDir, 'structure.json'), JSON.stringify(STRUCTURE));
  writeFileSync(join(outDir, 'architecture.json'), JSON.stringify(ARCHITECTURE));
  writeFileSync(join(outDir, 'summaries.json'), JSON.stringify(Object.fromEntries(Object.entries(FILES).map(([p, f]) => [p, { summary: f.summary, notes: [] }]))));
  return { root, outDir };
}

// Read Server-Sent Events from a URL; resolves each `data:` payload as parsed JSON.
export async function sseClient(url) {
  const ctl = new AbortController();
  const res = await fetch(url, { signal: ctl.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const queue = [];
  const waiters = [];
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          const msg = JSON.parse(data);
          if (waiters.length) waiters.shift()(msg); else queue.push(msg);
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    next: (ms = 2000) => (queue.length ? Promise.resolve(queue.shift()) : new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('no SSE message')), ms);
      waiters.push((m) => { clearTimeout(t); ok(m); });
    })),
    close: () => ctl.abort(),
  };
}
