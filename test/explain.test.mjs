import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble } from '../src/assemble/index.mjs';
import { explainSimple, simpleItems, readSimple } from '../src/explain/simple.mjs';
import { draw, cleanMermaid, readDrawn } from '../src/explain/draw.mjs';
import { makeFixture, STRUCTURE, ARCHITECTURE } from './helpers.mjs';

// A fake model: answers every item it is given with a card, and counts calls.
function cardModel() {
  const m = async ({ user }) => {
    m.calls++;
    const keys = [...user.matchAll(/"key":"([^"]+)"/g)].map((x) => x[1]);
    m.lastKeys = keys;
    return JSON.stringify(keys.map((key) => ({ key, analogy: `Like a gym card for ${key}`, steps: [{ icon: '🎫', text: 'Show your card' }, { icon: '🚪', text: 'The door checks it' }, { icon: '✅', text: 'You get in' }] })));
  };
  m.calls = 0;
  return m;
}

test('simpleItems: one card per tool, stage, concern and domain', () => {
  const keys = simpleItems(ARCHITECTURE).map((i) => i.key);
  assert.deepEqual(keys, ['tool:get-prices', 'tool:get-supply', 'stage:bootstrap', 'stage:auth', 'stage:query', 'concern:entitlements', 'domain:pricing']);
});

test('explainSimple: makes all cards once, then reuses them', async () => {
  const { outDir } = makeFixture();
  const complete = cardModel();
  const first = await explainSimple(outDir, { complete });
  assert.deepEqual(first, { made: 7, reused: 0 });
  assert.equal(readSimple(outDir)['concern:entitlements'].steps.length, 3);
  const again = await explainSimple(outDir, { complete });
  assert.deepEqual(again, { made: 0, reused: 7 });
  assert.equal(complete.calls, 1);
});

test('explainSimple: a changed section is the only one redone', async () => {
  const { outDir } = makeFixture();
  const complete = cardModel();
  await explainSimple(outDir, { complete });
  const arch = JSON.parse(readFileSync(join(outDir, 'architecture.json'), 'utf8'));
  arch.concerns[0].detail = 'Now checks the plan and the region.';
  writeFileSync(join(outDir, 'architecture.json'), JSON.stringify(arch));
  const r = await explainSimple(outDir, { complete });
  assert.deepEqual(r, { made: 1, reused: 6 });
  assert.deepEqual(complete.lastKeys, ['concern:entitlements']);
});

test('explainSimple: a bad model reply keeps the old card', async () => {
  const { outDir } = makeFixture();
  await explainSimple(outDir, { complete: cardModel() });
  const before = readSimple(outDir)['tool:get-prices'];
  await explainSimple(outDir, { complete: async () => 'sorry, no JSON today', force: true });
  assert.deepEqual(readSimple(outDir)['tool:get-prices'], before);
});

test('payload carries the cards and drawn diagrams for the viewer', async () => {
  const { outDir } = makeFixture();
  await explainSimple(outDir, { complete: cardModel() });
  const p = assemble(STRUCTURE, outDir);
  assert.equal(p.simple['tool:get-prices'].analogy, 'Like a gym card for tool:get-prices');
  assert.equal(p.simple['tool:get-prices'].hash, undefined);
  assert.deepEqual(p.drawn, {});
});

test('cleanMermaid: strips fences and rejects non-diagrams', () => {
  assert.equal(cleanMermaid('Here you go:\n```mermaid\nflowchart LR\n  a --> b\n```\nHope it helps'), 'flowchart LR\n  a --> b');
  assert.equal(cleanMermaid('stateDiagram-v2\n  [*] --> Open'), 'stateDiagram-v2\n  [*] --> Open');
  assert.equal(cleanMermaid('I cannot draw that.'), null);
});

test('draw: asks once, caches, and a forced redraw asks again', async () => {
  const { outDir } = makeFixture();
  const payload = assemble(STRUCTURE, outDir);
  let calls = 0;
  let prompt = '';
  const complete = async ({ user }) => { calls++; prompt = user; return '```mermaid\nflowchart TD\n  ask["Ask for prices"] --> check{"Entitled?"}\n```'; };
  const target = { t: 'tool', id: 'get-prices' };
  const a = await draw(outDir, payload, target, 'workflow', { complete });
  assert.equal(a.cached, false);
  assert.equal(a.title, 'get_prices — User journey');
  assert.match(a.mermaid, /^flowchart TD/);
  assert.match(prompt, /src\/tools\/get-prices\.ts — The get_prices tool/); // files + summaries are the evidence
  const b = await draw(outDir, payload, target, 'workflow', { complete });
  assert.equal(b.cached, true);
  assert.equal(calls, 1);
  assert.ok(readDrawn(outDir)['tool:get-prices:workflow']);
  await draw(outDir, payload, target, 'workflow', { complete, force: true });
  assert.equal(calls, 2);
});

test('draw: two tabs asking at once share one model call', async () => {
  const { outDir } = makeFixture();
  const payload = assemble(STRUCTURE, outDir);
  let calls = 0;
  const complete = async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return 'sequenceDiagram\n  U->>S: get_prices'; };
  const target = { t: 'concern', id: 'entitlements' };
  await Promise.all([draw(outDir, payload, target, 'sequence', { complete }), draw(outDir, payload, target, 'sequence', { complete })]);
  assert.equal(calls, 1);
});

test('draw: refuses unknown sections and kinds, and replies that are not diagrams', async () => {
  const { outDir } = makeFixture();
  const payload = assemble(STRUCTURE, outDir);
  const complete = async () => 'no diagram';
  await assert.rejects(draw(outDir, payload, { t: 'tool', id: 'nope' }, 'workflow', { complete }), (e) => e.status === 400);
  await assert.rejects(draw(outDir, payload, { t: 'tool', id: 'get-prices' }, 'pie', { complete }), (e) => e.status === 400);
  await assert.rejects(draw(outDir, payload, { t: 'tool', id: 'get-prices' }, 'workflow', { complete }), /did not return a diagram/);
});
