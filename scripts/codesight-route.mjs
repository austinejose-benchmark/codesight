#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: forward the prompt to a running
// `codesight serve` so the dashboard can jump before Claude answers.
//
// Must never slow the prompt: no dependencies, always exits 0, and exits as soon
// as the request is sent — it does not wait for the answer. Its only output is
// one line with the learner's style (a UserPromptSubmit hook's stdout is added to
// Claude's context), and only while the dashboard runs and a style is picked.

import { readFileSync, existsSync, writeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { request } from 'node:http';

const GIVE_UP_MS = 1000;
setTimeout(() => process.exit(0), GIVE_UP_MS).unref();

function findTmpDir(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const tmp = join(dir, '.codesight', 'tmp');
    if (existsSync(join(tmp, 'serve.json'))) return tmp;
    if (dirname(dir) === dir) return null;
  }
}

// codesight's own background model calls (summaries, cards, "Draw this") are
// not the user asking — never route or annotate them.
if (process.env.CODESIGHT_INTERNAL) process.exit(0);

try {
  const input = readFileSync(0, 'utf8');
  const { prompt, cwd } = JSON.parse(input || '{}');
  const tmp = prompt && findTmpDir(cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!tmp) process.exit(0);
  try {
    const { tips } = JSON.parse(readFileSync(join(tmp, 'learner.json'), 'utf8'));
    if (tips) writeSync(1, `codesight: the user's live dashboard is open — use the codesight show tools as you explain. ${tips}\n`); // sync: exit must not cut it off
  } catch { /* no style picked yet */ }
  const { port } = JSON.parse(readFileSync(join(tmp, 'serve.json'), 'utf8'));
  const body = JSON.stringify({ q: prompt });
  const req = request({ host: '127.0.0.1', port, path: '/api/route', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
  req.on('error', () => process.exit(0)); // server not running — nothing to do
  req.end(body, () => process.exit(0));   // sent; the server routes it on its own
} catch {
  process.exit(0);
}
