// Provider selection, shared by enrich and architect. Default: the user's own
// Claude Code (`claude` CLI) — no API key. Fallback: the Anthropic API.

export async function loadProvider(opts = {}) {
  let name = opts.provider;
  if (!name) {
    const cli = await import('./claude-cli.mjs');
    if (cli.isAvailable()) name = 'claude-cli';
    else {
      const api = await import('./anthropic.mjs');
      if (api.isAvailable()) name = 'anthropic';
      else throw new Error('no Claude available — run inside Claude Code (the `claude` CLI), or set ANTHROPIC_API_KEY');
    }
  }
  const mod = await import(`./${name}.mjs`);
  return { name, provider: mod.createProvider({ model: opts.model }) };
}
