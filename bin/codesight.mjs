#!/usr/bin/env node
// codesight CLI entry. Routes to the scan / enrich / build stages.

import { resolve, join } from 'node:path';

const COMMANDS = {
  scan: 'extract deterministic structure (tree-sitter) → .codesight/structure.json',
  enrich: 'generate lean file summaries (LLM), batched + cached by content hash',
  build: 'assemble + emit the standalone HTML viewer',
};

function printHelp() {
  process.stdout.write('codesight — explorable architecture maps\n\n');
  process.stdout.write('Usage: codesight <command> [path] [options]\n\n');
  for (const [name, desc] of Object.entries(COMMANDS)) {
    process.stdout.write(`  ${name.padEnd(9)}${desc}\n`);
  }
  process.stdout.write('\n');
}

// tiny flag parser: returns { _: positionals[], <flag>: value|true }
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

async function cmdScan(args) {
  const { scan } = await import('../src/scan/index.mjs');
  const projectRoot = resolve(args._[0] || process.cwd());
  const outDir = resolve(args.out || join(projectRoot, '.codesight'));
  const started = Date.now();
  process.stderr.write(`codesight scan ${projectRoot}\n`);
  const s = await scan(projectRoot, outDir);
  const ms = Date.now() - started;
  process.stdout.write(
    `\n  ${s.stats.files} files · ${s.stats.functions} functions · ${s.stats.classes} classes` +
    `  (${ms} ms, 0 tokens)\n` +
    `  → ${join(outDir, 'structure.json')}\n\n`,
  );
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }
  if (!(command in COMMANDS)) {
    process.stderr.write(`codesight: unknown command '${command}'\n`);
    printHelp();
    return 1;
  }
  const args = parseArgs(rest);
  if (command === 'scan') return cmdScan(args);
  process.stderr.write(`codesight ${command}: not wired up yet — scaffolding in progress.\n`);
  return 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`codesight: ${err?.stack || err}\n`);
  process.exit(1);
});
