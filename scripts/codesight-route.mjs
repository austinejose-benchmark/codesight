#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: forward the prompt to a running
// `codesight serve` so the dashboard can jump before Claude answers.
//
// Must never slow the prompt or change it: no dependencies, prints nothing
// (a UserPromptSubmit hook's stdout is added to Claude's context), always exits
// 0, and exits as soon as the request is sent — it does not wait for the answer.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { request } from 'node:http';

const GIVE_UP_MS = 1000;
setTimeout(() => process.exit(0), GIVE_UP_MS).unref();

function findServeState(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const p = join(dir, '.codesight', 'tmp', 'serve.json');
    if (existsSync(p)) return p;
    if (dirname(dir) === dir) return null;
  }
}

try {
  const input = readFileSync(0, 'utf8');
  const { prompt, cwd } = JSON.parse(input || '{}');
  const statePath = prompt && findServeState(cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!statePath) process.exit(0);
  const { port } = JSON.parse(readFileSync(statePath, 'utf8'));
  const body = JSON.stringify({ q: prompt });
  const req = request({ host: '127.0.0.1', port, path: '/api/route', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
  req.on('error', () => process.exit(0)); // server not running — nothing to do
  req.end(body, () => process.exit(0));   // sent; the server routes it on its own
} catch {
  process.exit(0);
}
