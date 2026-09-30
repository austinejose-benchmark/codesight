// "Draw this": one diagram of one section (tool, stage, concern, domain), drawn
// by the model when a learner asks for it in the dashboard. Cached in
// .codesight/diagrams.json — committed like summaries, so the first draw takes
// ~15–30 s and every later one (yours or a teammate's) is instant.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadProvider } from '../enrich/provider.mjs';

// Bump when SYSTEM or a kind's brief changes — it is folded into the cache hash.
const PROMPT_VERSION = '1';
const MAX_FILES = 15;

export const MERMAID_START = /^\s*(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|journey|gantt|mindmap|timeline)\b/;

// What each kind of diagram shows. `start` is the mermaid header it must use.
export const DIAGRAM_KINDS = {
  architecture: { label: 'Architecture', start: 'flowchart LR', brief: 'the components of this part (files, services, data stores) and how they connect. Group related nodes with subgraphs when it helps.' },
  workflow: { label: 'User journey', start: 'flowchart TD', brief: "the journey from the caller's point of view: what they ask for, what the system checks, the decisions (diamond nodes) and each outcome. Business words, not code names." },
  sequence: { label: 'Sequence', start: 'sequenceDiagram', brief: 'one request from caller to response, across the files and services involved, in order.' },
  dataflow: { label: 'Data flow', start: 'flowchart LR', brief: 'where the data comes from, how it is changed on the way, and where it ends up (stores, caches, responses).' },
  lifecycle: { label: 'Lifecycle', start: 'stateDiagram-v2', brief: 'the states the main thing here moves through (a request, a record, a job) and what moves it from one state to the next.' },
};

const SYSTEM = `You draw ONE diagram of ONE part of a codebase, for someone learning it.
Output ONLY mermaid source: no code fences, no prose before or after.
Rules: at most 14 nodes or participants. Short labels (at most 5 words) in plain words. Node ids are simple words (auth, db, A1).
Put any label with spaces or symbols in double quotes. No parentheses, colons or semicolons inside labels or messages.
Use only the evidence given — never invent components that are not in it.`;

export const drawKey = (target, kind) => `${target.t}:${target.id}:${kind}`;

function sectionOf(payload, target) {
  const list = { tool: payload.tools, stage: payload.hasArch ? payload.spine : [], concern: payload.concerns, domain: payload.domains }[target.t] || [];
  return list.find((x) => x.id === target.id) || null;
}

// The evidence the model draws from: the section itself + its files' summaries.
function contextOf(payload, target, section) {
  const byPath = new Map(payload.files.map((f) => [f.path, f]));
  const files = (section.files || []).slice(0, MAX_FILES).map((p) => `- ${p}${byPath.get(p)?.summary ? ` — ${byPath.get(p).summary}` : ''}`);
  const lines = [
    `PROJECT: ${payload.project.name} — ${payload.overview.description || ''}`,
    `PART (${target.t}): ${section.name || section.title || section.label}`,
    section.summary || section.blurb || section.detail || '',
    section.howItWorks ? `How it works: ${section.howItWorks}` : '',
    (section.rules || []).length ? `Rules: ${section.rules.join('; ')}` : '',
    (section.inputs || []).length ? `Inputs: ${section.inputs.join('; ')}` : '',
    (section.entities || []).length ? `Entities: ${section.entities.join(', ')}` : '',
    files.length ? `FILES:\n${files.join('\n')}` : '',
    section.diagram ? `EXISTING SEQUENCE DIAGRAM (for reference):\n${String(section.diagram).slice(0, 2000)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function readDrawn(outDir) {
  const p = join(outDir, 'diagrams.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

// Strip fences / chatter around the mermaid source; null when there is none.
export function cleanMermaid(text) {
  let s = String(text || '').trim();
  const fenced = s.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
  if (fenced) s = fenced[1].trim();
  return MERMAID_START.test(s) ? s : null;
}

const inFlight = new Map();
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

// Draw (or return the cached) diagram. `opts.complete` injects the model call
// (tests); otherwise the enrich provider is used — the user's Claude Code login.
export function draw(outDir, payload, target, kind, opts = {}) {
  const spec = DIAGRAM_KINDS[kind];
  if (!spec) return Promise.reject(badRequest(`kind must be one of: ${Object.keys(DIAGRAM_KINDS).join(', ')}`));
  const section = target && sectionOf(payload, target);
  if (!section) return Promise.reject(badRequest('no such section in the map'));

  const key = drawKey(target, kind);
  const context = contextOf(payload, target, section);
  const hash = createHash('sha256').update(`${PROMPT_VERSION}\n${kind}\n${context}`).digest('hex').slice(0, 16);
  const hit = readDrawn(outDir)[key];
  if (hit && hit.hash === hash && !opts.force) return Promise.resolve({ ...hit, cached: true });
  if (inFlight.has(key)) return inFlight.get(key); // two tabs asked at once — draw once

  const job = (async () => {
    const complete = opts.complete || (await loadProvider(opts)).provider.complete;
    const user = `Draw the ${spec.label.toLowerCase()} diagram: ${spec.brief}\nStart with "${spec.start}".\n\n${context}`;
    const mermaid = cleanMermaid(await complete({ system: SYSTEM, user, maxTokens: 3000 }));
    if (!mermaid) throw new Error('the model did not return a diagram — try again');
    const entry = { hash, kind, title: `${section.name || section.title || section.label} — ${spec.label}`, mermaid, madeAt: new Date().toISOString() };
    // Re-read right before writing: another draw may have finished meanwhile.
    writeFileSync(join(outDir, 'diagrams.json'), JSON.stringify({ ...readDrawn(outDir), [key]: entry }, null, 1));
    return { ...entry, cached: false };
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}
