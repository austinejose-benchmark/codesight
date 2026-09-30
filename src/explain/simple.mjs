// The simple pass: one eli5-style card per section (tool, stage, concern,
// domain) for beginners — an everyday comparison plus 3–4 picture steps.
//
// Runs after the architect. One cheap call (Haiku) for every section that is new
// or changed; the rest come from .codesight/simple.json, cached per section by a
// hash of what the card is made from. Opening a card later costs 0 tokens.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadProvider } from '../enrich/provider.mjs';

// Bump when SYSTEM changes — it is folded into every card's hash.
const PROMPT_VERSION = '1';
const DEFAULT_MODEL = 'haiku';
const MAX_STEPS = 4;

const SYSTEM = `You explain parts of a software system to a complete beginner — like to a five-year-old: big pictures, few words.
You get a list of items. Each has a key, a kind (tool, stage, concern, domain), a name and a technical description.
Return ONLY a JSON array, one object per item, in the SAME order:
[{"key":"<exact key>","analogy":"<one everyday comparison, at most 20 words, starting with 'Like'>","steps":[{"icon":"<one emoji>","text":"<at most 10 plain words>"}]}]
Rules: 3 or 4 steps, in the order things happen. Plain words a child knows — no jargon, no acronyms, no code names except the item's own name. Each icon is a single emoji that pictures its step. No prose outside the JSON array.`;

export const cardKey = (kind, id) => `${kind}:${id}`;

// The sections a card is made for, and the text each card is made from.
export function simpleItems(arch) {
  const items = [];
  const add = (kind, x, name, parts) => {
    if (!x || !x.id || !name) return;
    const about = parts.filter(Boolean).join(' ').slice(0, 900);
    items.push({ key: cardKey(kind, x.id), kind, name, about });
  };
  for (const t of arch.tools || []) add('tool', t, t.name, [t.summary, t.howItWorks, (t.rules || []).join('; ')]);
  for (const s of arch.spine || []) add('stage', s, s.title, [s.blurb]);
  for (const c of arch.concerns || []) add('concern', c, c.label, [c.detail]);
  for (const d of arch.domains || []) add('domain', d, d.name, [d.summary, (d.rules || []).join('; ')]);
  return items;
}

const hashOf = (item) => createHash('sha256').update(`${PROMPT_VERSION}\n${item.kind}\n${item.name}\n${item.about}`).digest('hex').slice(0, 16);

function parseCards(text, items) {
  let arr = [];
  const m = String(text).match(/\[[\s\S]*\]/);
  try { arr = JSON.parse(m ? m[0] : text); } catch { /* leave empty */ }
  const byKey = new Map((Array.isArray(arr) ? arr : []).map((r) => [r && r.key, r]));
  const out = new Map();
  for (const it of items) {
    const r = byKey.get(it.key);
    if (!r || typeof r.analogy !== 'string' || !Array.isArray(r.steps)) continue;
    const steps = r.steps
      .filter((s) => s && typeof s.text === 'string' && s.text.trim())
      .slice(0, MAX_STEPS)
      .map((s) => ({ icon: String(s.icon || '•').trim().slice(0, 8), text: s.text.trim().slice(0, 120) }));
    if (steps.length >= 2) out.set(it.key, { analogy: r.analogy.trim().slice(0, 200), steps });
  }
  return out;
}

export function readSimple(outDir) {
  const p = join(outDir, 'simple.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

// Make the missing / changed cards. `opts.complete` injects a model call (tests);
// otherwise the enrich provider is used (the user's Claude Code by default).
export async function explainSimple(outDir, opts = {}) {
  const archPath = join(outDir, 'architecture.json');
  if (!existsSync(archPath)) return { made: 0, reused: 0 };
  const items = simpleItems(JSON.parse(readFileSync(archPath, 'utf8')));
  const cache = readSimple(outDir);

  const next = {};
  const todo = [];
  for (const it of items) {
    const h = hashOf(it);
    if (!opts.force && cache[it.key]?.hash === h) next[it.key] = cache[it.key];
    else todo.push({ ...it, hash: h });
  }

  if (todo.length) {
    const complete = opts.complete || (await loadProvider({ ...opts, model: opts.model || DEFAULT_MODEL })).provider.complete;
    const user = `ITEMS (${todo.length}):\n${todo.map((it) => JSON.stringify({ key: it.key, kind: it.kind, name: it.name, about: it.about })).join('\n')}\n\nReturn the JSON array now.`;
    const cards = parseCards(await complete({ system: SYSTEM, user, maxTokens: 6000 }), todo);
    for (const it of todo) {
      const card = cards.get(it.key);
      if (card) next[it.key] = { ...card, hash: it.hash };
      else if (cache[it.key]) next[it.key] = cache[it.key]; // model skipped it — keep the old card
    }
  }

  // Sections that no longer exist drop out of `next` by construction.
  writeFileSync(join(outDir, 'simple.json'), JSON.stringify(next, null, 1));
  return { made: todo.filter((it) => next[it.key]?.hash === it.hash).length, reused: items.length - todo.length };
}
