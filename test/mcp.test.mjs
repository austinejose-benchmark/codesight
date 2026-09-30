import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/assemble/index.mjs';
import { impactOf, importersOf } from '../src/assemble/imports.mjs';
import { TOOLS, callTool } from '../src/mcp/tools.mjs';
import { createHandler } from '../src/mcp/index.mjs';
import { makeFixture, STRUCTURE } from './helpers.mjs';

const { root, outDir } = makeFixture();
const payload = assemble(STRUCTURE, outDir);
const pushed = [];
const ctx = { payload: () => payload, push: async (cmd) => { pushed.push(cmd); return { ok: true, clients: 1 }; } };
const call = async (name, args) => {
  const r = await callTool(name, args, ctx);
  return { ...r, data: r.isError ? null : (() => { try { return JSON.parse(r.text); } catch { return r.text; } })() };
};

test('impactOf: direct importers at level 1, their importers at level 2', () => {
  const levels = impactOf(importersOf(payload.files), 'src/db/client.ts', 3);
  assert.deepEqual(levels, [
    { level: 1, paths: ['src/auth/entitlements.ts', 'src/tools/get-prices.ts'] },
    { level: 2, paths: ['src/server.ts'] },
  ]);
});

test('get_overview: purpose, stages in order, tools, concerns', async () => {
  const { data } = await call('get_overview');
  assert.equal(data.purpose, 'Serves commodity prices to AI agents over MCP.');
  assert.deepEqual(data.stages.map((s) => s.id), ['bootstrap', 'auth', 'query']);
  assert.deepEqual(data.tools.map((t) => t.name), ['get_prices', 'get_supply']);
  assert.equal(data.concerns[0].id, 'entitlements');
});

test('search_map: finds sections, files and symbols by topic', async () => {
  const { data } = await call('search_map', { query: 'entitlement' });
  assert.ok(data.some((h) => h.kind === 'concern' && h.id === 'entitlements'));
  assert.ok(data.some((h) => h.kind === 'file' && h.path === 'src/auth/entitlements.ts'));
  assert.ok(data.some((h) => h.kind === 'symbol' && h.name === 'checkEntitlement'));
});

test('get_file: lines, imports and who imports it', async () => {
  const { data } = await call('get_file', { path: 'src/auth/entitlements.ts' });
  assert.deepEqual(data.functions, [{ name: 'checkEntitlement', lines: [1, 6] }]);
  assert.deepEqual(data.imports, ['src/db/client.ts']);
  assert.deepEqual(data.importedBy.sort(), ['src/server.ts', 'src/tools/get-prices.ts']);
});

test('get_section / callers: unknown ids fail with a hint', async () => {
  const r = await call('get_section', { kind: 'tool', id: 'nope' });
  assert.equal(r.isError, true);
  assert.match(r.text, /get-prices/);
  assert.equal((await call('callers', { path: 'src/missing.ts' })).isError, true);
});

test('show tools push UI commands — only for things that exist in the map', async () => {
  pushed.length = 0;
  await call('show', { kind: 'tool', id: 'get-prices' });
  await call('highlight', { paths: ['src/db/client.ts', 'not/real.ts'], note: 'the query path' });
  await call('show_code', { path: 'src/tools/get-prices.ts', start: 2, end: 9 });
  await call('show_diagram', { kind: 'workflow', title: 'Price request', mermaid: 'journey\n  title Price request\n  section Ask\n    Call get_prices: 5: User' });
  assert.deepEqual(pushed, [
    { type: 'open', target: { t: 'tool', id: 'get-prices' } },
    { type: 'highlight', paths: ['src/db/client.ts'], note: 'the query path' },
    { type: 'code', path: 'src/tools/get-prices.ts', ranges: [[2, 9]], note: '' },
    { type: 'diagram', kind: 'workflow', title: 'Price request', mermaid: 'journey\n  title Price request\n  section Ask\n    Call get_prices: 5: User' },
  ]);
  assert.equal((await call('show', { kind: 'tool', id: 'nope' })).isError, true);
  assert.equal((await call('show_code', { path: '../etc/passwd', start: 1 })).isError, true);
  assert.equal((await call('show_diagram', { kind: 'workflow', title: 'x', mermaid: 'not mermaid' })).isError, true);
  assert.equal(pushed.length, 4);
});

test('show_simple: pushes a beginner card, needs 2+ steps', async () => {
  pushed.length = 0;
  const steps = [{ icon: '🎫', text: 'Show your card' }, { icon: '🚪', text: 'The door checks your plan' }];
  await call('show_simple', { title: 'Entitlements', analogy: 'Like a gym card', steps });
  assert.deepEqual(pushed, [{ type: 'simple', title: 'Entitlements', analogy: 'Like a gym card', steps }]);
  assert.equal((await call('show_simple', { title: 'x', analogy: 'Like y', steps: steps.slice(0, 1) })).isError, true);
});

test('get_overview: includes the learner style and tips when the dashboard has one', async () => {
  const r = await callTool('get_overview', {}, { ...ctx, learner: () => ({ style: 'visual', level: 'beginner' }) });
  const data = JSON.parse(r.text);
  assert.equal(data.learner.style, 'visual');
  assert.match(data.learner.tips, /show_diagram/);
  assert.equal(JSON.parse((await callTool('get_overview', {}, ctx)).text).learner, undefined);
});

test('show_code: several ranges in one file; highlight can carry exact lines', async () => {
  pushed.length = 0;
  await call('show_code', { path: 'src/db/client.ts', ranges: [{ start: 1, end: 3 }, { start: 8 }, { start: 0 }] });
  await call('highlight', { lines: [{ path: 'src/auth/entitlements.ts', start: 2, end: 4 }, { path: 'nope.ts', start: 1 }], note: 'the check' });
  assert.deepEqual(pushed, [
    { type: 'code', path: 'src/db/client.ts', ranges: [[1, 3], [8, 8]], note: '' },
    { type: 'highlight', paths: ['src/auth/entitlements.ts'], note: 'the check', lines: [{ path: 'src/auth/entitlements.ts', start: 2, end: 4 }] },
  ]);
  assert.equal((await call('show_code', { path: 'src/db/client.ts' })).isError, true);
});

test('show tools: no dashboard running is not an error', async () => {
  const r = await callTool('show', { kind: 'overview' }, { payload: () => payload, push: async () => ({ ok: false }) });
  assert.ok(!r.isError);
  assert.match(r.text, /codesight serve/);
});

test('handler: initialize, tools/list, notifications and unknown methods', async () => {
  const handle = createHandler(ctx);
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.equal((await handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
});

test('stdio: `codesight mcp` answers over stdin/stdout', async () => {
  const bin = fileURLToPath(new URL('../bin/codesight.mjs', import.meta.url));
  const cp = spawn(process.execPath, [bin, 'mcp', '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  const got = new Promise((ok) => cp.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    if (lines.length >= 2) ok();
  }));
  cp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  cp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_overview', arguments: {} } })}\n`);
  await got;
  cp.stdin.end();
  assert.equal(lines[0].result.serverInfo.name, 'codesight');
  assert.equal(JSON.parse(lines[1].result.content[0].text).project, 'mini');
});
