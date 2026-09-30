// Word-by-word fuzzy ranking over map items ({ label, text }). Shared by the
// local router and the MCP `search_map` tool.
//
// Each query word is fuzzy-matched on its own (fuse.js), so a full question like
// "how does get_prices check entitlements" still finds `get_prices`. A hit in the
// label counts 3× a hit in the text, and a word that matches many items counts
// for less — "get" hits every get_* tool, so it barely moves the ranking.

import Fuse from 'fuse.js';

export const LABEL_WEIGHT = 3;
const FUSE_OPTS = { includeScore: true, threshold: 0.3, ignoreLocation: true };
const STOP = new Set(('the and for are but not you all any can had her was one our out has him his how its may new now see two way who did get got let put say she too use does what when where which why with this that from have will your into about work works show tell explain there their them then than some such only also just like make made more most much very over here code file files please could would should want need know').split(' '));

export const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

// Returns every matching item, best first: [{ item, score }].
export function rankByWords(items, query) {
  const byLabel = new Fuse(items, { ...FUSE_OPTS, keys: ['label'] });
  const byText = new Fuse(items, { ...FUSE_OPTS, keys: ['text'] });
  const score = new Map();
  for (const w of new Set(words(query))) {
    for (const [fuse, weight] of [[byLabel, LABEL_WEIGHT], [byText, 1]]) {
      const hits = fuse.search(w);
      for (const h of hits) score.set(h.refIndex, (score.get(h.refIndex) || 0) + (weight * (1 - h.score)) / hits.length);
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([i, s]) => ({ item: items[i], score: s }));
}
