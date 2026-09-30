// Reverse import index — "who imports this file?". Used for change impact by
// `codesight update` and by the MCP `callers` tool.

export function importersOf(files) {
  const rev = new Map();
  for (const f of files) for (const imp of (f.imports || [])) {
    if (imp === f.path) continue;
    if (!rev.has(imp)) rev.set(imp, []);
    rev.get(imp).push(f.path);
  }
  return rev;
}

// Files affected by a change to `path`, level by level: level 1 imports it
// directly, level 2 imports a level-1 file, and so on. Each file is listed once,
// at the nearest level.
export function impactOf(rev, path, depth = 2) {
  const seen = new Set([path]);
  const levels = [];
  let frontier = [path];
  for (let level = 1; level <= depth && frontier.length; level++) {
    const next = [];
    for (const p of frontier) for (const q of (rev.get(p) || [])) {
      if (!seen.has(q)) { seen.add(q); next.push(q); }
    }
    if (next.length) levels.push({ level, paths: next.sort() });
    frontier = next;
  }
  return levels;
}
