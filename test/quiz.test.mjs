import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble } from '../src/assemble/index.mjs';
import { makeQuiz, readQuiz, grade, quizItems } from '../src/explain/quiz.mjs';
import { makeFixture, STRUCTURE, ARCHITECTURE } from './helpers.mjs';

// A fake model: a quiz for every stage it is given. The right answer is always
// written first — the pass must shuffle it and keep the index right.
function quizModel({ badFunction = false } = {}) {
  const m = async ({ user }) => {
    m.calls++;
    const stages = user.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    m.lastKeys = stages.map((s) => s.key);
    return JSON.stringify(stages.map((s) => ({
      key: s.key,
      keyCode: { path: s.files[0]?.path, function: badFunction ? 'madeUpFn' : s.files[0]?.functions[0], why: 'This is where it happens.' },
      questions: [0, 1].map((n) => ({
        q: `What does ${s.title} do? (${n})`,
        options: ['The right thing', 'A wrong thing', 'Another wrong thing', 'Nothing'],
        answer: 0,
        why: ['Yes, that is it.', 'No.', 'No.', 'No.'],
        cite: s.files[0]?.path,
      })),
      open: { q: `Explain ${s.title} in your words.`, points: ['point one', 'point two', 'point three'] },
    })));
  };
  m.calls = 0;
  return m;
}

test('quizItems: one per stage, with files, summaries and function names', () => {
  const items = quizItems(ARCHITECTURE, STRUCTURE, { 'src/server.ts': { summary: 'entry' } });
  assert.deepEqual(items.map((i) => i.key), ['stage:bootstrap', 'stage:auth', 'stage:query']);
  assert.deepEqual(items[0].files, [{ path: 'src/server.ts', summary: 'entry', functions: ['main'] }]);
});

test('makeQuiz: key code lines come from the scan; answers stay right after the shuffle', async () => {
  const { outDir } = makeFixture();
  const r = await makeQuiz(outDir, { complete: quizModel() });
  assert.deepEqual(r, { made: 3, reused: 0 });
  const q = readQuiz(outDir)['stage:auth'];
  assert.deepEqual(q.keyCode, { path: 'src/auth/entitlements.ts', name: 'checkEntitlement', start: 1, end: 6, why: 'This is where it happens.' });
  for (const x of q.questions) assert.equal(x.options[x.answer], 'The right thing');
  assert.equal(q.questions[0].why[q.questions[0].answer], 'Yes, that is it.');
  assert.equal(q.open.points.length, 3);
});

test('makeQuiz: a made-up function gives no key code, not wrong lines', async () => {
  const { outDir } = makeFixture();
  await makeQuiz(outDir, { complete: quizModel({ badFunction: true }) });
  assert.equal(readQuiz(outDir)['stage:auth'].keyCode, null);
});

test('makeQuiz: cached per stage — only a changed stage is redone', async () => {
  const { outDir } = makeFixture();
  const complete = quizModel();
  await makeQuiz(outDir, { complete });
  assert.deepEqual(await makeQuiz(outDir, { complete }), { made: 0, reused: 3 });
  const arch = JSON.parse(readFileSync(join(outDir, 'architecture.json'), 'utf8'));
  arch.spine[2].blurb = 'Reads rows from Postgres, now with retries.';
  writeFileSync(join(outDir, 'architecture.json'), JSON.stringify(arch));
  assert.deepEqual(await makeQuiz(outDir, { complete }), { made: 1, reused: 2 });
  assert.deepEqual(complete.lastKeys, ['stage:query']);
});

test('grade: scores from the key points the model says were covered', async () => {
  const { outDir } = makeFixture();
  await makeQuiz(outDir, { complete: quizModel() });
  const payload = assemble(STRUCTURE, outDir);
  let prompt = '';
  const complete = async ({ user }) => { prompt = user; return 'Sure: {"got":[0,2,2,9],"feedback":"Good on the flow."}'; };
  const g = await grade(payload, 'auth', 'It checks the token and then the plan.', { complete, level: 'beginner' });
  assert.deepEqual(g, { score: 2, of: 3, got: ['point one', 'point three'], missed: ['point two'], feedback: 'Good on the flow.' });
  assert.match(prompt, /very simple words/);
});

test('grade: refuses empty answers and unknown stages; a bad reply is an error', async () => {
  const { outDir } = makeFixture();
  await makeQuiz(outDir, { complete: quizModel() });
  const payload = assemble(STRUCTURE, outDir);
  const complete = async () => 'no json';
  await assert.rejects(grade(payload, 'auth', '  ', { complete }), (e) => e.status === 400);
  await assert.rejects(grade(payload, 'nope', 'x', { complete }), (e) => e.status === 400);
  await assert.rejects(grade(payload, 'auth', 'an answer', { complete }), /could not grade/);
});
