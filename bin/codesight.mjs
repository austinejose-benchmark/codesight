#!/usr/bin/env node
// codesight CLI entry. Routes to the scan / enrich / build stages.

import { resolve, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const COMMANDS = {
  serve: 'live dashboard — your agent CLI (Claude Code, Codex) drives it as you ask',
  mcp: 'MCP server for agent CLIs — reads the map, drives the dashboard',
  update: 'incremental — only re-do the changed files + show their impact',
  hook: 'install a commit/PR hook that keeps the map fresh (--github for CI)',
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
  process.stdout.write('  --no-simple           skip the beginner cards (eli5-style, one cheap Haiku call)\n');
  process.stdout.write('  --no-quiz             skip the learning-path quiz (one call for new / changed stages)\n');
  process.stdout.write('  --model <name>        summary model (default sonnet)\n');
  process.stdout.write('  --concurrency <n>     parallel summary batches (default 4)\n');
  process.stdout.write('  --paths a,b           only these files\n');
  process.stdout.write('  --out <dir>           data dir (default <repo>/.codesight)\n');
  process.stdout.write('  --port <n>            serve: port (default 4747)\n\n');
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
  let archOk = false;
  if (enriched && !args['no-arch']) {
    try {
      process.stderr.write('  inferring architecture…\n');
      await architect(projectRoot, outDir, enrichOpts(args));
      archOk = true;
    } catch (err) {
      process.stderr.write(`  (no architecture layer: ${String(err?.message || err).split('\n')[0]})\n`);
    }
  }

  // 2c — beginner cards: one eli5-style card per section. Needs the architecture.
  if (archOk && !args['no-simple']) await makeSimpleCards(outDir, args);
  // 2d — learning-path quiz: key code + questions per stage. Needs the architecture.
  if (archOk && !args['no-quiz']) await makeQuizzes(outDir, args);

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

// Cards cost one small call and only for new / changed sections; never fatal.
async function makeSimpleCards(outDir, args) {
  const { explainSimple } = await import('../src/explain/simple.mjs');
  try {
    process.stderr.write('  making beginner cards…\n');
    // Cards use their own small default model (Haiku); --model is for summaries.
    const r = await explainSimple(outDir, { provider: typeof args.provider === 'string' ? args.provider : undefined, force: !!args.force });
    if (r.made) process.stderr.write(`  ${r.made} card(s) made, ${r.reused} cached\n`);
  } catch (err) {
    process.stderr.write(`  (no beginner cards: ${String(err?.message || err).split('\n')[0]})\n`);
  }
}

async function makeQuizzes(outDir, args) {
  const { makeQuiz } = await import('../src/explain/quiz.mjs');
  try {
    process.stderr.write('  writing the learning-path quiz…\n');
    const r = await makeQuiz(outDir, { provider: typeof args.provider === 'string' ? args.provider : undefined, force: !!args.force });
    if (r.made) process.stderr.write(`  ${r.made} stage quiz(zes) made, ${r.reused} cached\n`);
  } catch (err) {
    process.stderr.write(`  (no quiz: ${String(err?.message || err).split('\n')[0]})\n`);
  }
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

// ---- incremental update (diff-driven) ----
function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
}
function changedFiles(root, args) {
  let out = '';
  if (typeof args.base === 'string') out = git(root, ['diff', '--name-only', `${args.base}...HEAD`]);
  else if (args.staged) out = git(root, ['diff', '--cached', '--name-only']);
  else out = `${git(root, ['diff', '--name-only', 'HEAD'])}\n${git(root, ['ls-files', '--others', '--exclude-standard'])}`;
  return [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))];
}

// codesight update — only touch the changed files: re-summarise them, refresh the
// links, and report the impact on other files. The architect (flow/domains) is
// NOT re-run unless you pass --arch — a per-file edit rarely changes the shape.
async function cmdUpdate(args) {
  const { scan } = await import('../src/scan/index.mjs');
  const { enrich } = await import('../src/enrich/index.mjs');
  const { architect } = await import('../src/architect/index.mjs');
  const { build } = await import('../src/assemble/build.mjs');
  const projectRoot = resolve(args._[0] || process.cwd());
  const outDir = resolve(args.out || join(projectRoot, '.codesight'));

  const changed = changedFiles(projectRoot, args);
  if (!changed.length) { process.stdout.write('\n  codesight update: no changed files.\n\n'); return 0; }
  process.stderr.write(`codesight update — ${changed.length} changed file(s)\n  rescanning structure…\n`);

  await scan(projectRoot, outDir); // fast + free; picks up new/deleted files and fresh links
  const structure = JSON.parse(readFileSync(join(outDir, 'structure.json'), 'utf8'));
  const codePaths = new Set(structure.files.map((f) => f.path));
  const codeChanged = changed.filter((p) => codePaths.has(p));

  if (codeChanged.length && !args['no-enrich']) {
    try {
      await enrich(projectRoot, outDir, { ...enrichOpts(args), paths: codeChanged });
      process.stderr.write('\n');
    } catch (err) {
      process.stderr.write(`\n  (no summaries: ${String(err?.message || err).split('\n')[0]})\n`);
    }
  }
  if (args.arch) {
    try {
      process.stderr.write('  re-inferring architecture…\n');
      await architect(projectRoot, outDir, enrichOpts(args));
      if (!args['no-simple']) await makeSimpleCards(outDir, args);
      if (!args['no-quiz']) await makeQuizzes(outDir, args);
    } catch { /* keep cached */ }
  }

  const htmlOut = resolve(args.o || join(outDir, 'codesight.html'));
  const { payload } = build(join(outDir, 'structure.json'), outDir, htmlOut);

  // Impact: which files import the ones that changed.
  const { importersOf } = await import('../src/assemble/imports.mjs');
  const rev = importersOf(structure.files);
  process.stdout.write(`\n  ${codeChanged.length} file summar${codeChanged.length === 1 ? 'y' : 'ies'} refreshed · ${payload.files.length} files · map updated${args.arch ? ' (+architecture)' : ' (architecture reused)'}\n  → ${htmlOut}\n`);
  process.stdout.write('\n  change effect — files that import the changed ones:\n');
  let any = false;
  for (const p of codeChanged) {
    const deps = rev.get(p) || [];
    if (deps.length) { any = true; process.stdout.write(`    ${p}\n      ← ${deps.length} dependent(s): ${deps.slice(0, 6).map((d) => d.split('/').pop()).join(', ')}${deps.length > 6 ? '…' : ''}\n`); }
  }
  if (!any) process.stdout.write('    (none — the changed files are not imported elsewhere)\n');
  process.stdout.write('\n');
  return 0;
}

const GH_ACTION = `name: codesight
on:
  pull_request:
jobs:
  map:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Refresh the codesight map for changed files
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: npx codesight update --base origin/\${{ github.base_ref }}
      - name: Commit the updated map
        run: |
          git config user.name  "codesight"
          git config user.email "codesight@users.noreply.github.com"
          git add .codesight && git commit -m "codesight: refresh map" || echo "no changes"
          git push || true
`;

const PRE_COMMIT = `#!/bin/sh
# codesight — refresh the map for staged changes, then re-stage it.
codesight update --staged --no-enrich >/dev/null 2>&1 || true
git add .codesight >/dev/null 2>&1 || true
`;

async function cmdHook(args) {
  const projectRoot = resolve(args._[0] || process.cwd());
  if (args.github) {
    const dir = join(projectRoot, '.github', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codesight.yml'), GH_ACTION);
    process.stdout.write(`\n  wrote .github/workflows/codesight.yml\n  → runs 'codesight update' on every PR and commits the refreshed map\n  (add an ANTHROPIC_API_KEY repo secret — CI has no Claude Code login)\n\n`);
    return 0;
  }
  const hooksDir = git(projectRoot, ['rev-parse', '--git-path', 'hooks']).trim();
  if (!hooksDir) { process.stderr.write('codesight hook: not a git repo\n'); return 1; }
  const abs = resolve(projectRoot, hooksDir);
  mkdirSync(abs, { recursive: true });
  const hookPath = join(abs, 'pre-commit');
  writeFileSync(hookPath, PRE_COMMIT);
  chmodSync(hookPath, 0o755);
  process.stdout.write(`\n  installed pre-commit hook → ${hookPath}\n  refreshes the structure map for staged files on each commit (fast, no tokens).\n  For AI summaries on PRs use the cloud hook: codesight hook --github\n\n`);
  return 0;
}

// codesight serve — the live dashboard. Runs until Ctrl+C.
async function cmdServe(args) {
  const { startServer, DEFAULT_PORT } = await import('../src/serve/index.mjs');
  const projectRoot = resolve(args._[0] || process.cwd());
  const outDir = resolve(args.out || join(projectRoot, '.codesight'));
  if (!existsSync(join(outDir, 'structure.json'))) {
    process.stderr.write(`codesight serve: no map in ${outDir} yet — run \`codesight ${args._[0] || '.'}\` first\n`);
    return 1;
  }
  const log = (line) => process.stderr.write(`  ${line}\n`);
  const s = await startServer({ projectRoot, outDir, port: args.port ? Number(args.port) : DEFAULT_PORT, log });
  process.stdout.write(
    `\n  codesight live → ${s.url}\n` +
    `  router: ${s.router === 'jev' ? 'jev (TYPESAFE_API_KEY set)' : 'local match (set TYPESAFE_API_KEY to use jev)'}\n` +
    '  Ask in Claude Code / Codex — the dashboard follows. Ctrl+C to stop.\n\n',
  );
  if (args.open) openInBrowser(s.url);
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise(() => {}); // keep serving
}

// codesight mcp — stdio MCP server. The map is found from --root, or by walking
// up from the agent's project dir / cwd.
async function cmdMcp(args) {
  const { runStdio } = await import('../src/mcp/index.mjs');
  const root = resolve(typeof args.root === 'string' ? args.root : process.env.CODESIGHT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  await runStdio(root);
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
    if (command === 'serve') return cmdServe(args);
    if (command === 'mcp') return cmdMcp(args);
    if (command === 'update') return cmdUpdate(args);
    if (command === 'hook') return cmdHook(args);
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
