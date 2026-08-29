// The DEFAULT provider: use the user's own Claude Code (the `claude` CLI in
// headless `-p` mode). It runs under whatever auth Claude Code is already logged
// in with — no ANTHROPIC_API_KEY, no separate billing setup. This is the right
// path when codesight runs inside someone's Claude Code session.

import { spawn, spawnSync } from 'node:child_process';
import { SYSTEM, buildUserContent, parseResults, resolveModel } from './prompt.mjs';

export function isAvailable() {
  try {
    return spawnSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch { return false; }
}

function runClaude(prompt, model) {
  return new Promise((res, rej) => {
    const args = ['-p', '--output-format', 'json'];
    if (model) args.push('--model', model);
    const cp = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', rej);
    cp.on('close', (code) => (code === 0
      ? res(out)
      : rej(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`))));
    cp.stdin.write(prompt);
    cp.stdin.end();
  });
}

export function createProvider({ model } = {}) {
  const modelId = resolveModel(model);
  const complete = async ({ system, user }) => {
    const raw = await runClaude(`${system}\n\n${user}`, modelId);
    // --output-format json wraps the reply: { type:"result", result:"<text>", ... }
    try { const j = JSON.parse(raw); return j.result ?? j.text ?? raw; } catch { return raw; }
  };
  return {
    complete,
    async summarize(batch) {
      return parseResults(await complete({ system: SYSTEM, user: buildUserContent(batch) }), batch);
    },
  };
}
