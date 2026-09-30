// The fast router: a question in → which part of the map to show. It runs the
// moment the user presses Enter, so the dashboard can jump while Claude / Codex
// is still thinking about the answer.
//
// Two providers:
//   jev   — TypeSafe's "System One" model: one `choice` question, answers in
//           ~0.1–0.5 s with a probability per option. Used when TYPESAFE_API_KEY
//           is set. Only the question + map labels/summaries are sent, never code.
//   local — word-by-word fuzzy match over the same options (no network). The
//           fallback when there is no key, or jev fails / is too slow.

import { rankByWords, LABEL_WEIGHT } from '../assemble/search.mjs';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MAX_OPTIONS = 255; // TypeSafe's limit for one choice question
const JEV_TIMEOUT_MS = 800;
const NONE = 'none';

export const JUMP_AT = 0.6;    // confident enough to move the dashboard
export const SUGGEST_AT = 0.2; // worth offering as "Did you mean…"

// The options: every named part of the map. Keys are snake_case ids, the shape
// jev's criteria examples use.
export function candidates(payload) {
  const out = [];
  const used = new Set();
  const add = (t, id, label, text) => {
    if (!id || !label) return;
    let key = `${t}_${id}`.replace(/[^a-zA-Z0-9_]/g, '_');
    while (used.has(key)) key += '_';
    used.add(key);
    out.push({ key, target: { t, id }, label, text: text || '' });
  };
  for (const x of payload.tools || []) add('tool', x.id, x.name, x.summary);
  if (payload.hasArch) for (const s of payload.spine || []) add('stage', s.id, s.title, s.blurb);
  for (const d of payload.domains || []) add('domain', d.id, d.name, d.summary);
  for (const c of payload.concerns || []) add('concern', c.id, c.label, c.detail);
  for (const s of payload.stores || []) add('store', s.id, s.label, s.detail);
  if (!payload.hasArch) for (const a of payload.overview?.areas || []) add('area', a.dir, a.dir, `${a.n} files`);
  return out;
}

const pick = (c, confidence) => ({ target: c.target, label: c.label, confidence });
function result(by, ranked) {
  const top = ranked[0];
  return { by, target: top ? top.target : null, label: top ? top.label : '', confidence: top ? top.confidence : 0, alternatives: ranked.slice(0, 3) };
}

export function routeLocal(question, cands) {
  const ranked = rankByWords(cands, question);
  if (!ranked.length) return result('local', []);
  const total = ranked.reduce((a, r) => a + r.score, 0);
  // Share of the total says "this one, not the others"; the size of the best
  // score says "a real match" — one clean label hit scores LABEL_WEIGHT.
  const strength = Math.min(1, ranked[0].score / LABEL_WEIGHT);
  return result('local', ranked.map((r) => pick(r.item, (r.score / total) * strength)));
}

export async function routeJev(question, cands, { apiKey, project = 'this', fetchImpl = fetch, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  const pool = cands.slice(0, JEV_MAX_OPTIONS - 1); // one slot is kept for "none"
  const criteria = { [NONE]: 'Not about one specific part of this codebase (git, setup, general chat, or something else)' };
  for (const c of pool) criteria[c.key] = (c.text ? `${c.label} — ${c.text}` : c.label).slice(0, 240);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(JEV_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        state: question,
        model: 'jev-latest',
        questions: {
          target: {
            type: 'choice',
            instructions: `A developer is learning the ${project} codebase. Which part of the codebase map best answers their message?`,
            criteria,
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`jev HTTP ${res.status}`);
    const answer = (await res.json())?.answers?.target;
    if (!answer || typeof answer.probabilities !== 'object') throw new Error('jev: no answer');
    const byKey = new Map(pool.map((c) => [c.key, c]));
    const ranked = Object.entries(answer.probabilities)
      .filter(([k]) => byKey.has(k))
      .sort((a, b) => b[1] - a[1])
      .map(([k, p]) => pick(byKey.get(k), p));
    // "none" won: nothing to jump to, but keep strong runners-up as suggestions.
    if (answer.choice === NONE) return { ...result('jev', []), alternatives: ranked.filter((r) => r.confidence >= SUGGEST_AT).slice(0, 3) };
    return result('jev', ranked);
  } finally {
    clearTimeout(timer);
  }
}

export async function route(question, payload, { apiKey = process.env.TYPESAFE_API_KEY, onFallback, ...jevOpts } = {}) {
  const q = String(question || '').trim().slice(0, 2000);
  const cands = candidates(payload);
  if (!q || !cands.length) return result('local', []);
  if (apiKey) {
    try {
      return await routeJev(q, cands, { apiKey, project: payload.project?.name, ...jevOpts });
    } catch (err) {
      onFallback?.(err);
    }
  }
  return routeLocal(q, cands);
}

// What the dashboard should do with a route result.
export function decide(r) {
  if (r.target && r.confidence >= JUMP_AT) return 'open';
  if (r.alternatives.some((a) => a.confidence >= SUGGEST_AT)) return 'suggest';
  return 'none';
}
