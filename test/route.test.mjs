import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from '../src/assemble/index.mjs';
import { candidates, routeLocal, routeJev, route, decide } from '../src/serve/route.mjs';
import { makeFixture, STRUCTURE } from './helpers.mjs';

const { outDir } = makeFixture();
const payload = assemble(STRUCTURE, outDir);
const cands = candidates(payload);

test('candidates: every named part of the map, with unique snake_case keys', () => {
  const keys = cands.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((k) => /^[a-zA-Z0-9_]+$/.test(k)));
  assert.deepEqual(cands.find((c) => c.key === 'tool_get_prices').target, { t: 'tool', id: 'get-prices' });
  assert.ok(cands.some((c) => c.target.t === 'stage'));
  assert.ok(cands.some((c) => c.target.t === 'concern'));
});

test('local: a question naming a tool opens that tool', () => {
  const r = routeLocal('how does get_prices work?', cands);
  assert.deepEqual(r.target, { t: 'tool', id: 'get-prices' });
  assert.equal(decide(r), 'open');
});

test('local: a topic word finds the concern', () => {
  const r = routeLocal('how are entitlements checked', cands);
  assert.deepEqual(r.target, { t: 'concern', id: 'entitlements' });
  assert.equal(decide(r), 'open');
});

test('local: a prompt about something else does not move the dashboard', () => {
  assert.equal(decide(routeLocal('commit my changes and push', cands)), 'none');
});

const jevReply = (choice, probabilities) => async (url, init) => {
  jevReply.last = { url, init, body: JSON.parse(init.body) };
  return { ok: true, json: async () => ({ answers: { target: { type: 'choice', choice, confidence: 0.9, probabilities } } }) };
};

test('jev: sends one choice question and maps the answer back to a target', async () => {
  const fetchImpl = jevReply('concern_entitlements', { concern_entitlements: 0.85, tool_get_prices: 0.1, none: 0.05 });
  const r = await routeJev('who can see lithium prices?', cands, { apiKey: 'k', project: 'mini', fetchImpl });
  assert.equal(r.by, 'jev');
  assert.deepEqual(r.target, { t: 'concern', id: 'entitlements' });
  assert.equal(r.confidence, 0.85);
  assert.equal(decide(r), 'open');
  const { url, init, body } = jevReply.last;
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(init.headers.authorization, 'Bearer k');
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.questions.target.type, 'choice');
  assert.ok(body.questions.target.criteria.none);
  assert.ok(body.questions.target.criteria.tool_get_prices.startsWith('get_prices'));
});

test('jev: "none" wins → no jump, strong runners-up become suggestions', async () => {
  const fetchImpl = jevReply('none', { none: 0.6, tool_get_prices: 0.3, tool_get_supply: 0.1 });
  const r = await routeJev('what does this function return', cands, { apiKey: 'k', fetchImpl });
  assert.equal(r.target, null);
  assert.deepEqual(r.alternatives.map((a) => a.target.id), ['get-prices']);
  assert.equal(decide(r), 'suggest');
});

test('route: falls back to the local match when jev fails', async () => {
  let fellBack = null;
  const r = await route('how does get_prices work', payload, {
    apiKey: 'k',
    fetchImpl: async () => ({ ok: false, status: 529 }),
    onFallback: (err) => { fellBack = err.message; },
  });
  assert.equal(r.by, 'local');
  assert.match(fellBack, /529/);
  assert.deepEqual(r.target, { t: 'tool', id: 'get-prices' });
});

test('route: falls back when jev is too slow', async () => {
  const hang = (url, init) => new Promise((_, fail) => init.signal.addEventListener('abort', () => fail(new Error('aborted'))));
  const started = Date.now();
  const r = await route('how are entitlements checked', payload, { apiKey: 'k', fetchImpl: hang, timeoutMs: 50 });
  assert.equal(r.by, 'local');
  assert.ok(Date.now() - started < 1000);
});

test('route: an empty question routes nowhere', async () => {
  const r = await route('   ', payload, { apiKey: '' });
  assert.equal(r.target, null);
  assert.equal(decide(r), 'none');
});
