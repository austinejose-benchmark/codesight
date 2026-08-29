// Offline provider for `codesight enrich --provider mock`. Produces deterministic
// placeholder summaries from the structure alone — no model call, no key, no cost.
// Useful for testing the enrich → cache → build pipeline without spending tokens.

export function createProvider() {
  return {
    async summarize(batch) {
      return batch.map((f) => ({
        path: f.path,
        summary: `${f.language} file defining ${f.functions.length} function(s)`
          + (f.functions.length ? `: ${f.functions.slice(0, 3).join(', ')}${f.functions.length > 3 ? '…' : ''}.` : '.'),
        notes: f.functions.length > 8 ? ['large surface — many exported functions'] : [],
      }));
    },
  };
}
