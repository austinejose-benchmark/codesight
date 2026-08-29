#!/usr/bin/env node
// codesight CLI entry. Routes to the scan / enrich / build stages.
// Stages are wired in as the vendoring lands; unimplemented ones say so clearly.

const COMMANDS = {
  scan: 'extract deterministic structure (tree-sitter) → .codesight/structure.json',
  enrich: 'generate lean file summaries (LLM), batched + cached by content hash',
  build: 'assemble + emit the standalone HTML viewer',
};

function printHelp() {
  process.stdout.write('codesight — explorable architecture maps\n\n');
  process.stdout.write('Usage: codesight <command> [options]\n\n');
  for (const [name, desc] of Object.entries(COMMANDS)) {
    process.stdout.write(`  ${name.padEnd(9)}${desc}\n`);
  }
  process.stdout.write('\n');
}

async function main() {
  const [command] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }
  if (!(command in COMMANDS)) {
    process.stderr.write(`codesight: unknown command '${command}'\n`);
    printHelp();
    return 1;
  }
  // Stages are added during scaffolding (see README build order).
  process.stderr.write(`codesight ${command}: not wired up yet — scaffolding in progress.\n`);
  return 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`codesight: ${err?.stack || err}\n`);
  process.exit(1);
});
