// The learning path's quiz: per request-flow stage, the key function to read,
// 2 multiple-choice questions (checked in the browser — instant, 0 tokens), and
// one "explain it back" question that the model grades on request.
//
// Made after the architect, cached per stage in .codesight/quiz.json by a hash
// of what the stage's quiz is made from — only new / changed stages are redone.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadProvider } from '../enrich/provider.mjs';

// Bump when SYSTEM changes — it is folded into every stage's hash.
const PROMPT_VERSION = '2';
const QUESTIONS_PER_STAGE = 2;
const MAX_FILES = 10;
const MAX_FNS = 12;
const GRADE_MODEL = 'haiku';
const MAX_ANSWER = 2000;
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

const SYSTEM = `You write a short learning quiz for each stage of a codebase's request flow, for someone new to the code.
For each stage you get its key, title, what happens there, and its files (each with a summary and its function names).
Return ONLY a JSON array, one object per stage, in the SAME order:
[{"key":"<exact key>",
  "keyCode":{"path":"<one of the stage's file paths, verbatim>","function":"<one function name from that file, verbatim>","why":"<one sentence: why this function is the heart of the stage>"},
  "questions":[{"q":"<question>","options":["<4 short options>"],"answer":<index of the correct option>,"why":["<one short line per option: why it is right or wrong>"],"cite":"<the file path the answer comes from>"}],
  "open":{"q":"<one 'explain it back in your own words' question>","points":["<2-4 key points a good answer covers>"]}}]
Rules: exactly ${QUESTIONS_PER_STAGE} questions per stage. Test understanding of behaviour and reasons — never trivia like file names or line numbers. Exactly one correct option; wrong options must be believable, and all options about the same length and detail — the right one must not stand out. Plain, short words. Use only the evidence given. No prose outside the JSON array.`;

const GRADE_SYSTEM = `You grade a learner's answer to an "explain it back" question about a codebase. Be kind and brief.
Return ONLY JSON: {"got":[<0-based indexes of the key points the answer covers>],"feedback":"<1-2 short sentences: what was good, then the most important thing they missed>"}
A point counts when its idea is there in any words. Ignore spelling and grammar. No prose outside the JSON.`;

export const quizKey = (stageId) => `stage:${stageId}`;

// Per stage: what its quiz is made from.
export function quizItems(arch, structure, summaries) {
  const byPath = new Map(structure.files.map((f) => [f.path, f]));
  return (arch.spine || []).filter((s) => s && s.id).map((s) => ({
    key: quizKey(s.id),
    title: s.title,
    about: s.blurb || '',
    files: (s.files || []).filter((p) => byPath.has(p)).slice(0, MAX_FILES).map((p) => ({
      path: p,
      summary: summaries[p]?.summary || '',
      functions: [...byPath.get(p).functions, ...byPath.get(p).classes].map((d) => d.name).slice(0, MAX_FNS),
    })),
  }));
}

const hashOf = (it) => createHash('sha256').update(`${PROMPT_VERSION}\n${JSON.stringify(it)}`).digest('hex').slice(0, 16);

// A stable shuffle (seeded by the question) — models tend to put the right
// answer first; this spreads it out, and the same question keeps its order.
function seededOrder(n, seed) {
  let h = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  const idx = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    const j = h % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

const str = (x, max) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : '');

function cleanQuestion(q, paths) {
  const options = (Array.isArray(q?.options) ? q.options : []).map((o) => str(o, 200)).filter(Boolean).slice(0, 4);
  const answer = Number(q?.answer);
  if (!str(q?.q, 300) || options.length < 3 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) return null;
  const why = options.map((_, i) => str(Array.isArray(q.why) ? q.why[i] : '', 240));
  const order = seededOrder(options.length, q.q);
  return {
    q: str(q.q, 300),
    options: order.map((i) => options[i]),
    why: order.map((i) => why[i]),
    answer: order.indexOf(answer),
    cite: paths.has(q.cite) ? q.cite : null,
  };
}

function parseQuiz(text, items, structure) {
  let arr = [];
  const m = String(text).match(/\[[\s\S]*\]/);
  try { arr = JSON.parse(m ? m[0] : text); } catch { /* leave empty */ }
  const byKey = new Map((Array.isArray(arr) ? arr : []).map((r) => [r && r.key, r]));
  const fileByPath = new Map(structure.files.map((f) => [f.path, f]));
  const out = new Map();
  for (const it of items) {
    const r = byKey.get(it.key);
    if (!r) continue;
    const stagePaths = new Set(it.files.map((f) => f.path));
    const questions = (Array.isArray(r.questions) ? r.questions : []).map((q) => cleanQuestion(q, stagePaths)).filter(Boolean).slice(0, QUESTIONS_PER_STAGE);
    if (!questions.length) continue;
    // The model names a function; its lines come from the scan, so they are real.
    let keyCode = null;
    const kc = r.keyCode;
    const def = kc && stagePaths.has(kc.path) && [...fileByPath.get(kc.path).functions, ...fileByPath.get(kc.path).classes].find((d) => d.name === kc.function);
    if (def) keyCode = { path: kc.path, name: def.name, start: def.start, end: def.end, why: str(kc.why, 240) };
    const points = (Array.isArray(r.open?.points) ? r.open.points : []).map((p) => str(p, 200)).filter(Boolean).slice(0, 4);
    const open = str(r.open?.q, 300) && points.length >= 2 ? { q: str(r.open.q, 300), points } : null;
    out.set(it.key, { keyCode, questions, open });
  }
  return out;
}

const readJSON = (p, fallback) => { if (!existsSync(p)) return fallback; try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
export const readQuiz = (outDir) => readJSON(join(outDir, 'quiz.json'), {});

// Make the missing / changed stage quizzes. `opts.complete` injects the model
// call (tests); otherwise the enrich provider is used (the user's Claude Code).
export async function makeQuiz(outDir, opts = {}) {
  const arch = readJSON(join(outDir, 'architecture.json'), null);
  if (!arch) return { made: 0, reused: 0 };
  const structure = JSON.parse(readFileSync(join(outDir, 'structure.json'), 'utf8'));
  const items = quizItems(arch, structure, readJSON(join(outDir, 'summaries.json'), {}));
  const cache = readQuiz(outDir);

  const next = {};
  const todo = [];
  for (const it of items) {
    const h = hashOf(it);
    if (!opts.force && cache[it.key]?.hash === h) next[it.key] = cache[it.key];
    else todo.push({ ...it, hash: h });
  }
  if (todo.length) {
    const complete = opts.complete || (await loadProvider(opts)).provider.complete;
    const user = `STAGES (${todo.length}):\n${todo.map(({ hash, ...it }) => JSON.stringify(it)).join('\n')}\n\nReturn the JSON array now.`;
    const quizzes = parseQuiz(await complete({ system: SYSTEM, user, maxTokens: 10000 }), todo, structure);
    for (const it of todo) {
      const q = quizzes.get(it.key);
      if (q) next[it.key] = { ...q, hash: it.hash };
      else if (cache[it.key]) next[it.key] = cache[it.key]; // model skipped it — keep the old quiz
    }
  }
  writeFileSync(join(outDir, 'quiz.json'), JSON.stringify(next, null, 1));
  return { made: todo.filter((it) => next[it.key]?.hash === it.hash).length, reused: items.length - todo.length };
}

// Grade an "explain it back" answer against the stage's key points.
export async function grade(payload, stageId, answer, opts = {}) {
  const quiz = payload.quiz?.[quizKey(stageId)];
  if (!quiz?.open) throw badRequest('no explain-it-back question for this stage');
  const text = String(answer || '').trim().slice(0, MAX_ANSWER);
  if (!text) throw badRequest('write an answer first');
  const { points } = quiz.open;
  const plain = opts.level === 'beginner' ? '\nThe learner is a beginner: use very simple words in the feedback.' : '';
  const user = `QUESTION: ${quiz.open.q}\nKEY POINTS:\n${points.map((p, i) => `${i}. ${p}`).join('\n')}\n\nLEARNER'S ANSWER:\n${text}${plain}\n\nReturn the JSON now.`;
  const complete = opts.complete || (await loadProvider({ ...opts, model: opts.model || GRADE_MODEL })).provider.complete;
  const reply = String(await complete({ system: GRADE_SYSTEM, user, maxTokens: 800 }));
  let r = null;
  try { r = JSON.parse((reply.match(/\{[\s\S]*\}/) || [reply])[0]); } catch { /* handled below */ }
  if (!r || !Array.isArray(r.got)) throw new Error('could not grade that answer — try again');
  const got = [...new Set(r.got.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < points.length))].sort((a, b) => a - b);
  return {
    score: got.length,
    of: points.length,
    got: got.map((i) => points[i]),
    missed: points.filter((_, i) => !got.includes(i)),
    feedback: str(r.feedback, 400),
  };
}
