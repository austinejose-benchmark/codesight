// Assemble structure.json (+ any enriched summaries) into the viewer payload and
// emit a single self-contained HTML file.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '../../viewer/template.html');

// The viewer HTML for a payload. `live` turns on the dashboard features that need
// `codesight serve` (agent-driven navigation, code view); a static file keeps them off.
export function renderHtml(payload, { live = false } = {}) {
  // Embed the JSON in a <script type="application/json"> block. Neutralise any
  // "</" so a string value can never close the script tag early ( \/ is valid
  // JSON and parses back to "/" ). Replacer functions, not strings: a summary
  // containing "$&" or "$'" must not be read as a replace pattern.
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
  const title = `codesight — ${payload.project.name}`;
  return readFileSync(TEMPLATE, 'utf8')
    .replace('__CS_TITLE__', () => title)
    .replace('__CS_LIVE__', () => String(live))
    .replace('__CODESIGHT_DATA__', () => json);
}

export function build(structurePath, outDir, htmlOut) {
  const structure = JSON.parse(readFileSync(structurePath, 'utf8'));
  const payload = assemble(structure, outDir);
  writeFileSync(htmlOut, renderHtml(payload));
  writeFileSync(join(outDir, 'codesight.json'), JSON.stringify(payload, null, 1));
  return { payload, htmlOut };
}
