// The Anthropic provider for `codesight enrich`. Uses the official SDK, which
// resolves credentials from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
// or an `ant auth login` profile). Default model: claude-sonnet-5.

import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You write terse, factual one-line summaries of source files for a code map.
For each file you are given its path, language, its function names, and its (possibly truncated) content.
Return ONLY a JSON array — one object per file, in the SAME order as given:
[{"path":"<exact path>","summary":"<one present-tense sentence: what this file is/does>","notes":["<0-2 short notes>"]}]
Rules: summary is ONE sentence, no filler ("This file…"), name what it actually does.
notes are optional (0-2), each a short phrase about a non-obvious behaviour, invariant, or gotcha —
never a restatement of the summary. Output no prose outside the JSON array.`;

const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
};

export function createProvider({ model } = {}) {
  const client = new Anthropic();
  const modelId = MODEL_ALIASES[model] || model || 'claude-sonnet-5';
  return {
    async summarize(batch) {
      const user = batch
        .map((f, i) => `### FILE ${i + 1}: ${f.path}  (${f.language})\nfunctions: ${f.functions.join(', ') || '—'}\n\n${f.content}`)
        .join('\n\n');
      const res = await client.messages.create({
        model: modelId,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content: `${user}\n\nReturn the JSON array now.` }],
      });
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return parseResults(text, batch);
    },
  };
}

function parseResults(text, batch) {
  let arr = [];
  const m = text.match(/\[[\s\S]*\]/);
  try { arr = JSON.parse(m ? m[0] : text); } catch { /* fall through to empties */ }
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
