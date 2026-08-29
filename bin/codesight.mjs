#!/usr/bin/env node
// codesight CLI entry. Routes to the scan / enrich / build stages.

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const COMMANDS = {
  scan: 'structure only — tree-sitter, 0 tokens (advanced / CI)',
  enrich: 'summaries only — for an already-scanned repo (advanced)',
  build: 'scan + enrich + build the map (same as the default)',
};

function printHelp() {
  process.stdout.write('codesight — explorable architecture maps\n\n');
  process.stdout.write('Usage: codesight [path] [options]        one run → scan + AI summaries + map\n\n');
  process.stdout.write('Options:\n');
  process.stdout.write('  --open                open the map in your browser\n');
  process.stdout.write('  --no-enrich           structure only, skip the AI summaries\n');
  process.stdout.write('  --no-rescan           reuse an existing scan (skip re-parsing)\n');
  process.stdout.write('  --model <name>        summary model (default sonnet)\n');
  process.stdout.write('  --concurrency <n>     parallel summary batches (default 4)\n');
  process.stdout.write('  --paths a,b           only these files\n');
  process.stdout.write('  --out <dir>           data dir (default <repo>/.codesight)\n\n');
  process.stdout.write('Sub-commands (advanced):\n');
  for (const [name, desc] of Object.entries(COMMANDS)) {
    process.stdout.write(`  ${name.padEnd(9)}${desc}\n`);
  }
  process.stdout.write('\nAI summaries use your Claude Code login by default (the `claude` CLI) — no key needed.\nSet ANTHROPIC_API_KEY only for standalone/CI use without Claude Code.\n\n');
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

function openInBrowser(file) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [file], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

function enrichOpts(args) {
  return {
    model: typeof args.model === 'string' ? args.model : undefined,
    provider: typeof args.provider === 'string' ? args.provider : undefined,
    concurrency: args.concurrency ? Number(args.concurrency) : undefined,
    paths: typeof args.paths === 'string' ? args.paths.split(',').map((s) => s.trim()).filter(Boolean) : null,
    force: !!args.force,
    onProgress: (d, t) => process.stderr.write(`\r  summarising ${d}/${t}…   `),
  };
}

// The default, one-shot pipeline: scan → enrich → build → (open). This is what
// you get from `codesight <path>` — a full, AI-annotated map in one run.
async function cmdBuild(args) {
  const { scan } = await import('../src/scan/index.mjs');
  const { enrich } = await import('../src/enrich/index.mjs');
  const { architect } = await import('../src/architect/index.mjs');
  const { build } = await import('../src/assemble/build.mjs');
  const projectRoot = resolve(args._[0] || process.cwd());
  const outDir = resolve(args.out || join(projectRoot, '.codesight'));
  const structurePath = join(outDir, 'structure.json');
  const started = Date.now();

  // 1 — structure (free, ~1s). Always fresh unless a cached scan is reused with --no-rescan.
  if (!existsSync(structurePath) || !args['no-rescan']) {
    process.stderr.write('  scanning (tree-sitter)…\n');
    await scan(projectRoot, outDir);
  }

  // 2 — summaries (the AI context). Skippable, and non-fatal if there is no key.
  let enriched = null;
  if (!args['no-enrich']) {
    try {
      enriched = await enrich(projectRoot, outDir, enrichOpts(args));
      process.stderr.write('\n');
    } catch (err) {
      const msg = String(err?.message || err).split('\n')[0];
      process.stderr.write(`\n  (no summaries: ${msg})\n  run inside Claude Code (the \`claude\` CLI), or pass --no-enrich for a structure-only map\n`);
    }
  }

  // 2b — architecture (rich layer): the flow spine, domains, stores, infra,
  // request diagram. Needs summaries; skippable with --no-arch.
  if (enriched && !args['no-arch']) {
    try {
      process.stderr.write('  inferring architecture…\n');
      await architect(projectRoot, outDir, enrichOpts(args));
    } catch (err) {
      process.stderr.write(`  (no architecture layer: ${String(err?.message || err).split('\n')[0]})\n`);
    }
  }

  // 3 — assemble the viewer.
  const htmlOut = resolve(args.o || join(outDir, 'codesight.html'));
  const { payload } = build(structurePath, outDir, htmlOut);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const summ = enriched ? `${enriched.summarized} summarised, ${enriched.reused} cached · ` : 'structure-only · ';
  const shape = payload.hasArch ? `${payload.spine.length} stages · ${payload.domains.length} domains` : `${payload.spine.length} areas`;
  process.stdout.write(
    `\n  ${payload.overview.name} · ${shape} · ${payload.files.length} files · ${summ}${secs}s\n` +
    `  → ${htmlOut}\n\n`,
  );
  if (args.open) openInBrowser(htmlOut);
  return 0;
}

async function cmdEnrich(args) {
  const { enrich } = await import('../src/enrich/index.mjs');
  const projectRoot = resolve(args._[0] || process.cwd());
  const outDir = resolve(args.out || join(projectRoot, '.codesight'));
  process.stderr.write(`codesight enrich ${projectRoot}\n`);
  const r = await enrich(projectRoot, outDir, enrichOpts(args));
  process.stdout.write(
    `\n\n  ${r.summarized} summarised · ${r.reused} from cache · ${r.targeted} files targeted\n` +
    `  → ${join(outDir, 'summaries.json')}\n  run 'codesight build' to see them in the map\n\n`,
  );
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }
  if (command in COMMANDS) {
    const args = parseArgs(rest);
    if (command === 'scan') return cmdScan(args);
    if (command === 'enrich') return cmdEnrich(args);
    if (command === 'build') return cmdBuild(args);
  }
  // No sub-command: treat a bare path or flags as the default one-shot map.
  const looksLikePathOrFlag =
    command.startsWith('--') || command.startsWith('.') || command.startsWith('/') ||
    command.startsWith('~') || existsSync(command);
  if (looksLikePathOrFlag) return cmdBuild(parseArgs([command, ...rest]));

  process.stderr.write(`codesight: unknown command '${command}'\n`);
  printHelp();
  return 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`codesight: ${err?.stack || err}\n`);
  process.exit(1);
});
