// Assemble structure.json (+ any enriched summaries) into the viewer payload and
// emit a single self-contained HTML file.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '../../viewer/template.html');

export function build(structurePath, outDir, htmlOut) {
  const structure = JSON.parse(readFileSync(structurePath, 'utf8'));
  const payload = assemble(structure, outDir);

  // Embed the JSON in a <script type="application/json"> block. Neutralise any
  // "</" so a string value can never close the script tag early ( \/ is valid
  // JSON and parses back to "/" ).
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
  const title = `codesight — ${payload.project.name}`;
  const html = readFileSync(TEMPLATE, 'utf8')
    .replace('__CS_TITLE__', title)
    .replace('__CODESIGHT_DATA__', json);

  writeFileSync(htmlOut, html);
  writeFileSync(join(outDir, 'codesight.json'), JSON.stringify(payload, null, 1));
  return { payload, htmlOut };
}
