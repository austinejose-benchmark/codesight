// codesight serve — makes the map live. The dashboard listens on /events (SSE —
// a one-way live stream from server to browser). The agent's MCP tools and the
// prompt hook POST commands here, and every open dashboard follows along.
//
// Binds to 127.0.0.1 only, and writes its port to <outDir>/tmp/serve.json (tmp/
// is git-ignored) so the hook and the MCP server can find it.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { payloadLoader } from '../assemble/load.mjs';
import { renderHtml } from '../assemble/build.mjs';
import { route, decide, SUGGEST_AT } from './route.mjs';

export const statePathOf = (outDir) => join(outDir, 'tmp', 'serve.json');

export const DEFAULT_PORT = 4747;
const PORT_TRIES = 10;
const MAX_BODY = 256 * 1024;
const MAX_CODE_LINES = 400;
const HEARTBEAT_MS = 25_000;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
// UI commands the dashboard understands (see the "live" section of viewer/template.html).
export const COMMANDS = new Set(['open', 'highlight', 'code', 'diagram', 'suggest']);

const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { rej(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { res(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { rej(new Error('invalid JSON')); }
    });
    req.on('error', rej);
  });
}

// Lines `start..end` (1-based, inclusive) of a file that is part of the map.
export function readCode(projectRoot, payload, path, start, end) {
  if (!payload.files.some((f) => f.path === path)) return null;
  const abs = resolve(projectRoot, path);
  if (!abs.startsWith(resolve(projectRoot) + sep)) return null;
  const all = readFileSync(abs, 'utf8').split('\n');
  const s = Math.max(1, Math.min(all.length, Number(start) || 1));
  const e = Math.max(s, Math.min(all.length, Number(end) || s + MAX_CODE_LINES - 1, s + MAX_CODE_LINES - 1));
  return { path, start: s, end: e, total: all.length, lines: all.slice(s - 1, e) };
}

export async function startServer({ projectRoot, outDir, port = DEFAULT_PORT, apiKey = process.env.TYPESAFE_API_KEY, log = () => {} }) {
  const load = payloadLoader(outDir);
  const clients = new Set();

  const broadcast = (cmd) => {
    const frame = `data: ${JSON.stringify(cmd)}\n\n`;
    for (const res of clients) res.write(frame);
    return clients.size;
  };

  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, HEARTBEAT_MS);
  heartbeat.unref();

  async function handle(req, res) {
    // Only answer requests addressed to this machine by name. This blocks DNS
    // rebinding (a web page pointing its own domain at 127.0.0.1 to read code).
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(host)) return sendJson(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(renderHtml(load(), { live: true }));
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(res, 200, { project: load().project.name, clients: clients.size, router: apiKey ? 'jev' : 'local' });
    }
    if (req.method === 'GET' && url.pathname === '/api/code') {
      const code = readCode(projectRoot, load(), url.searchParams.get('path') || '', url.searchParams.get('start'), url.searchParams.get('end'));
      return code ? sendJson(res, 200, code) : sendJson(res, 404, { error: 'not a file in the map' });
    }

    if (req.method !== 'POST') return sendJson(res, 404, { error: 'not found' });
    // JSON only: a cross-site form cannot send this content type without a CORS
    // preflight, which this server never approves.
    if (!String(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { error: 'send application/json' });
    let body;
    try { body = await readBody(req); } catch (err) { return sendJson(res, 400, { error: err.message }); }

    if (url.pathname === '/api/show') {
      if (!COMMANDS.has(body.type)) return sendJson(res, 400, { error: `type must be one of: ${[...COMMANDS].join(', ')}` });
      return sendJson(res, 200, { ok: true, clients: broadcast(body) });
    }
    if (url.pathname === '/api/route') {
      // Accepts { q } or a Claude Code hook payload ({ prompt, ... }) as-is.
      const q = String(body.q ?? body.prompt ?? '').trim();
      const started = Date.now();
      const r = await route(q, load(), { apiKey, onFallback: (err) => log(`router: jev failed (${err.message}), used local match`) });
      const action = decide(r);
      if (action === 'open') broadcast({ type: 'open', target: r.target, label: r.label, reason: q });
      if (action === 'suggest') broadcast({ type: 'suggest', question: q, options: r.alternatives.filter((a) => a.confidence >= SUGGEST_AT) });
      const ms = Date.now() - started;
      log(`route ${ms}ms ${r.by} → ${action}${r.target ? ` ${r.target.t}:${r.target.id} (${r.confidence.toFixed(2)})` : ''}`);
      return sendJson(res, 200, { ...r, action, ms });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => { log(`error: ${err.message}`); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); });
  });

  const listen = (p) => new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(p, '127.0.0.1', () => { server.off('error', fail); ok(server.address().port); });
  });
  let bound = null;
  for (let i = 0; i < PORT_TRIES && bound === null; i++) {
    try { bound = await listen(port === 0 ? 0 : port + i); } catch (err) { if (err.code !== 'EADDRINUSE' || port === 0) throw err; }
  }
  if (bound === null) throw new Error(`ports ${port}–${port + PORT_TRIES - 1} are all in use (pass --port)`);

  const url = `http://127.0.0.1:${bound}`;
  const statePath = statePathOf(outDir);
  mkdirSync(join(outDir, 'tmp'), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ port: bound, url, pid: process.pid, startedAt: new Date().toISOString() }, null, 1));

  const close = () => new Promise((ok) => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    try {
      if (existsSync(statePath) && JSON.parse(readFileSync(statePath, 'utf8')).pid === process.pid) rmSync(statePath);
    } catch { /* already gone */ }
    server.close(() => ok());
  });

  return { url, port: bound, router: apiKey ? 'jev' : 'local', broadcast, close };
}
