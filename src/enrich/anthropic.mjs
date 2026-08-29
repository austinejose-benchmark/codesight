// Fallback provider: call the Anthropic API directly with an API key. Only used
// when the `claude` CLI isn't available (e.g. standalone / CI). Resolves
// credentials from the environment (ANTHROPIC_API_KEY, etc.).

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM, buildUserContent, parseResults, resolveModel } from './prompt.mjs';

export function isAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function createProvider({ model } = {}) {
  const client = new Anthropic();
  const modelId = resolveModel(model);
  const complete = async ({ system, user, maxTokens = 4000 }) => {
    const res = await client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  };
  return {
    complete,
    async summarize(batch) {
      return parseResults(await complete({ system: SYSTEM, user: buildUserContent(batch) }), batch);
    },
  };
}
