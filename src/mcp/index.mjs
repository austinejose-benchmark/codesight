// codesight mcp — a stdio MCP server (MCP = Model Context Protocol, the standard
// way an agent CLI calls outside tools). Any MCP client — Claude Code, Codex,
// Gemini CLI — can read the map and drive the live dashboard through it.
//
// Hand-rolled JSON-RPC over newline-delimited stdio: the part of the protocol we
// need (initialize, tools/list, tools/call, ping) is small, so no SDK dependency.
// stdout carries protocol messages only; anything else goes to stderr.

import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { payloadLoader, findMapDir } from '../assemble/load.mjs';
import { statePathOf } from '../serve/index.mjs';
import { TOOLS, callTool } from './tools.mjs';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PUSH_TIMEOUT_MS = 1500;
const VERSION = '0.1.0';

const INSTRUCTIONS = `codesight is a map of this codebase plus a live dashboard the user may have open in their browser.
- Start with get_overview. Use search_map, get_section and get_file before reading source files — they are faster and cheaper.
- As you explain, drive the dashboard: show(...) the part you are talking about, highlight(...) the files you cite, show_code(...) the exact lines.
- When a picture helps, or the user asks for one (architecture, user journey, request flow), call show_diagram with mermaid.`;

// POST one UI command to the running `codesight serve`, if there is one.
export function makePush(outDir) {
  return async (cmd) => {
    const statePath = statePathOf(outDir);
    if (!existsSync(statePath)) return { ok: false };
    try {
      const { port } = JSON.parse(readFileSync(statePath, 'utf8'));
      const res = await fetch(`http://127.0.0.1:${port}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cmd),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      return res.ok ? { ok: true, ...(await res.json()) } : { ok: false };
    } catch {
      return { ok: false }; // stale serve.json or server stopped
    }
  };
}

export function createHandler(ctx) {
  return async function handle(msg) {
    const { id, method, params = {} } = msg || {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined || id === null) return null; // notification — never answered

    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'codesight', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        try {
          const r = await callTool(params.name, params.arguments || {}, ctx);
          return reply({ content: [{ type: 'text', text: r.text }], isError: Boolean(r.isError) });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: `codesight error: ${err.message}` }], isError: true });
        }
      }
      default:
        return error(-32601, `Method not found: ${method}`);
    }
  };
}

// Find the map from `root` (or walk up from it) and serve MCP on stdin/stdout.
// Resolves when stdin closes (the client went away).
export function runStdio(root) {
  const found = findMapDir(root);
  const ctx = found
    ? { payload: payloadLoader(found.outDir), push: makePush(found.outDir) }
    : { payload: () => null, push: async () => ({ ok: false }), missing: `No codesight map found in ${root} or above. Run \`codesight\` in the repo first.` };
  if (!found) process.stderr.write(`codesight mcp: no map found from ${root}\n`);

  const handle = createHandler(ctx);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const out = await handle(msg);
    if (out) write(out);
  });
  return new Promise((done) => rl.on('close', done));
}
