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

// Lean mode: a plain text completion under the user's login. Skips their MCP
// servers, plugins, hooks and skills, and swaps Claude Code's own ~24k-token
// system prompt for ours — about 3 s of start-up instead of about 17 s. With no
// setting sources no plugin hooks run, so codesight's own prompt hook does not
// fire on these internal calls (CODESIGHT_INTERNAL is a second guard).
const LEAN_FLAGS = ['--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--tools', '', '--settings', '{"alwaysThinkingEnabled":false}'];
// Thinking is on by default in Claude Code. For these structured-output calls it
// only adds time: 14 beginner cards took 120 s with it (16.7k thinking tokens)
// and 15 s without, with the same output.
const CHILD_ENV = { CODESIGHT_INTERNAL: '1', MAX_THINKING_TOKENS: '0' };

function runClaude({ system, user, model, lean }) {
  return new Promise((res, rej) => {
    const args = ['-p', '--output-format', 'json'];
    if (model) args.push('--model', model);
    if (lean) args.push(...LEAN_FLAGS, '--system-prompt', system);
    const cp = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...CHILD_ENV } });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', rej);
    cp.on('close', (code) => (code === 0
      ? res(out)
      : rej(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`))));
    cp.stdin.write(lean ? user : `${system}\n\n${user}`);
    cp.stdin.end();
  });
}

export function createProvider({ model } = {}) {
  const modelId = resolveModel(model);
  let lean = true; // switched off for good if this claude version rejects the flags
  const complete = async ({ system, user }) => {
    let raw;
    try {
      raw = await runClaude({ system, user, model: modelId, lean });
    } catch (err) {
      if (!lean) throw err;
      lean = false;
      raw = await runClaude({ system, user, model: modelId, lean });
    }
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
