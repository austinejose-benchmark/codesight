import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { startServer, statePathOf } from '../src/serve/index.mjs';
import { renderHtml } from '../src/assemble/build.mjs';
import { assemble } from '../src/assemble/index.mjs';
import { makeFixture, sseClient, STRUCTURE } from './helpers.mjs';

const { root, outDir } = makeFixture();
let s;
let drawCalls = 0;
// One fake model for the server: draws, and grades "explain it back" answers.
const complete = async ({ system }) => {
  if (/grade/.test(system)) return '{"got":[1],"feedback":"Nice start."}';
  drawCalls++;
  return 'flowchart LR\n  api --> db';
};
before(async () => { s = await startServer({ projectRoot: root, outDir, port: 0, apiKey: '', complete }); });
after(async () => { await s.close(); });

const post = (path, body, headers = { 'content-type': 'application/json' }) =>
  fetch(s.url + path, { method: 'POST', headers, body: JSON.stringify(body) });

// Compile the viewer's inline script: catches template syntax errors without a browser.
const mainScript = (html) => html.split('<script>').pop().split('</script>')[0];

test('static build: live off, and "$&" in a summary survives embedding', () => {
  const html = renderHtml(assemble(STRUCTURE, outDir));
  assert.match(html, /const LIVE=false;/);
  assert.ok(html.includes("with $& and $' patterns"));
  assert.doesNotThrow(() => new Script(mainScript(html)));
});

test('GET / serves the live viewer', async () => {
  const html = await (await fetch(s.url)).text();
  assert.match(html, /const LIVE=true;/);
  assert.match(html, /"name":"mini"/);
  assert.doesNotThrow(() => new Script(mainScript(html)));
});

test('writes serve.json so the hook and MCP server can find it', () => {
  assert.ok(existsSync(statePathOf(outDir)));
});

test('POST /api/show reaches every open dashboard', async () => {
  const sse = await sseClient(`${s.url}/events`);
  const r = await (await post('/api/show', { type: 'highlight', paths: ['src/db/client.ts'] })).json();
  assert.deepEqual(r, { ok: true, clients: 1 });
  assert.deepEqual(await sse.next(), { type: 'highlight', paths: ['src/db/client.ts'] });
  assert.equal((await post('/api/show', { type: 'rm -rf' })).status, 400);
  sse.close();
});

test('POST /api/route: a clear question moves the dashboard', async () => {
  const sse = await sseClient(`${s.url}/events`);
  const r = await (await post('/api/route', { prompt: 'how does get_prices work' })).json();
  assert.equal(r.action, 'open');
  assert.equal(r.by, 'local');
  assert.deepEqual(await sse.next(), { type: 'open', target: { t: 'tool', id: 'get-prices' }, label: 'get_prices', reason: 'how does get_prices work' });
  sse.close();
});

test('GET /api/code: only files in the map, clamped to the file', async () => {
  const c = await (await fetch(`${s.url}/api/code?path=src/db/client.ts&start=10&end=99`)).json();
  assert.deepEqual([c.start, c.end, c.total], [10, 12, 12]);
  assert.equal(c.lines[0], '// src/db/client.ts line 10');
  assert.equal((await fetch(`${s.url}/api/code?path=secret.txt`)).status, 404);
  assert.equal((await fetch(`${s.url}/api/code?path=../../etc/passwd`)).status, 404);
});

test('refuses non-JSON posts and foreign Host headers', async () => {
  assert.equal((await post('/api/show', { type: 'open' }, { 'content-type': 'text/plain' })).status, 415);
  const status = await new Promise((ok) => {
    const req = request({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { host: 'evil.example:80' } }, (res) => { res.resume(); ok(res.statusCode); });
    req.end();
  });
  assert.equal(status, 403);
});

test('prompt hook: forwards the prompt, prints nothing, exits 0', async () => {
  const sse = await sseClient(`${s.url}/events`);
  const hook = fileURLToPath(new URL('../scripts/codesight-route.mjs', import.meta.url));
  const cp = spawn(process.execPath, [hook], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  cp.stdout.on('data', (d) => { out += d; });
  cp.stdin.end(JSON.stringify({ prompt: 'how are entitlements checked', cwd: `${root}/src/auth`, hook_event_name: 'UserPromptSubmit' }));
  const code = await new Promise((ok) => cp.on('close', ok));
  assert.equal(code, 0);
  assert.equal(out, '');
  const msg = await sse.next();
  assert.deepEqual(msg.target, { t: 'concern', id: 'entitlements' });
  sse.close();
});

test('POST /api/learner: stores the style for the agent, rejects junk', async () => {
  assert.equal((await post('/api/learner', { style: 'loud', level: 'beginner' })).status, 400);
  const r = await (await post('/api/learner', { style: 'visual', level: 'beginner' })).json();
  assert.equal(r.learner.style, 'visual');
  assert.match(r.learner.tips, /show_diagram/);
  assert.match(r.learner.tips, /show_simple/);
  assert.equal((await (await fetch(`${s.url}/api/state`)).json()).learner.level, 'beginner');
});

test('prompt hook: prints the learner line once a style is picked', async () => {
  await post('/api/learner', { style: 'text', level: 'developer' });
  const hook = fileURLToPath(new URL('../scripts/codesight-route.mjs', import.meta.url));
  const cp = spawn(process.execPath, [hook], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  cp.stdout.on('data', (d) => { out += d; });
  cp.stdin.end(JSON.stringify({ prompt: 'what is this repo', cwd: root }));
  assert.equal(await new Promise((ok) => cp.on('close', ok)), 0);
  assert.match(out, /^codesight: the user's live dashboard is open/);
  assert.match(out, /Text learner/);
  assert.match(out, /Developer/);
});

test('POST /api/draw: draws once, then serves it from the cache', async () => {
  const body = { target: { t: 'stage', id: 'query' }, kind: 'dataflow' };
  const a = await (await post('/api/draw', body)).json();
  assert.equal(a.cached, false);
  assert.equal(a.mermaid, 'flowchart LR\n  api --> db');
  const b = await (await post('/api/draw', body)).json();
  assert.equal(b.cached, true);
  assert.equal(drawCalls, 1);
  assert.equal((await post('/api/draw', { target: { t: 'stage', id: 'nope' }, kind: 'dataflow' })).status, 400);
  // the next page load has it too, so the viewer shows it instantly
  assert.match(await (await fetch(s.url)).text(), /"stage:query:dataflow"/);
});

test('POST /api/grade: grades against the stage quiz', async () => {
  const { makeQuiz } = await import('../src/explain/quiz.mjs');
  await makeQuiz(outDir, { complete: async ({ user }) => JSON.stringify(user.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((st) => ({
    key: st.key, questions: [{ q: 'Why?', options: ['a', 'b', 'c'], answer: 1, why: ['', '', ''] }], open: { q: 'Explain it.', points: ['one', 'two'] },
  }))) });
  const g = await (await post('/api/grade', { stage: 'auth', answer: 'It checks the token.' })).json();
  assert.deepEqual([g.score, g.of, g.feedback], [1, 2, 'Nice start.']);
  assert.equal((await post('/api/grade', { stage: 'auth', answer: '' })).status, 400);
  assert.match(await (await fetch(s.url)).text(), /"stage:auth":\{"keyCode"/); // the page carries the quiz
});

test('prompt hook: no server for this repo → exits 0 quietly', async () => {
  const hook = fileURLToPath(new URL('../scripts/codesight-route.mjs', import.meta.url));
  const cp = spawn(process.execPath, [hook], { stdio: ['pipe', 'pipe', 'pipe'] });
  cp.stdin.end(JSON.stringify({ prompt: 'hello', cwd: '/' }));
  assert.equal(await new Promise((ok) => cp.on('close', ok)), 0);
});
