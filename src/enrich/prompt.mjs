// Shared prompt + response parsing for the enrich providers (claude-cli, anthropic).

export const SYSTEM = `You write terse, factual one-line summaries of source files for a code map.
For each file you are given its path, language, its function names, and its (possibly truncated) content.
Return ONLY a JSON array — one object per file, in the SAME order as given:
[{"path":"<exact path>","summary":"<one present-tense sentence: what this file is/does>","notes":["<0-2 short notes>"]}]
Rules: summary is ONE sentence, no filler ("This file…"), name what it actually does.
notes are optional (0-2), each a short phrase about a non-obvious behaviour, invariant, or gotcha —
never a restatement of the summary. Output no prose outside the JSON array.`;

export function buildUserContent(batch) {
  const files = batch
    .map((f, i) => `### FILE ${i + 1}: ${f.path}  (${f.language})\nfunctions: ${f.functions.join(', ') || '—'}\n\n${f.content}`)
    .join('\n\n');
  return `${files}\n\nReturn the JSON array now.`;
}

export function parseResults(text, batch) {
  let arr = [];
  const m = text.match(/\[[\s\S]*\]/);
  try { arr = JSON.parse(m ? m[0] : text); } catch { /* leave empty */ }
  const byPath = new Map((Array.isArray(arr) ? arr : []).map((r) => [r.path, r]));
  return batch.map((f) => {
    const r = byPath.get(f.path) || {};
    return {
      path: f.path,
      summary: (r.summary || '').trim(),
      notes: Array.isArray(r.notes) ? r.notes.slice(0, 2).map((n) => String(n)) : [],
    };
  });
}

export const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
};
export const resolveModel = (m) => MODEL_ALIASES[m] || m || 'claude-sonnet-5';
