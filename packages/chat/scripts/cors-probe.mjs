/**
 * Which hosted chat APIs can a web page call directly? Client-only mode only
 * offers those. This opens a real Chromium page on a local origin and sends
 * each endpoint the request the client-only engine would send (POST, JSON
 * body, a Bearer header for keyed services; the key is deliberately invalid,
 * so nothing is billed). A readable response, even 401, means CORS allows the
 * call; "Failed to fetch" means the browser blocked it.
 *
 *   node packages/chat/scripts/cors-probe.mjs > packages/chat/test/fixtures/cors-probe.json
 *
 * The endpoint list mirrors LANES in providers/llm-openai-compatible/src/index.ts.
 * Update both together, then update src/lib/cors.ts and docs/guides/chat.md.
 */
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const targets = [
  ['groq', 'https://api.groq.com/openai/v1/chat/completions', true, 'openai/gpt-oss-120b'],
  ['cerebras', 'https://api.cerebras.ai/v1/chat/completions', true, 'gpt-oss-120b'],
  ['mistral', 'https://api.mistral.ai/v1/chat/completions', true, 'mistral-small-latest'],
  ['github', 'https://models.github.ai/inference/chat/completions', true, 'meta/Llama-3.3-70B-Instruct'],
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', true, 'gemini-2.5-flash-lite'],
  ['ovh', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions', false, 'gpt-oss-120b'],
  ['pollinations', 'https://text.pollinations.ai/openai', false, 'openai-fast'],
  ['openai', 'https://api.openai.com/v1/chat/completions', true, 'gpt-5.4-nano'],
];

const port = 20000 + Math.floor(Math.random() * 9999);
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>cors probe</title>');
}).listen(port, '127.0.0.1');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const results = await page.evaluate(async (list) => {
    const out = [];
    for (const [service, url, keyed, model] of list) {
      const headers = { 'content-type': 'application/json' };
      if (keyed) headers.authorization = 'Bearer invalid-key-for-cors-probe';
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 400, stream: true }),
        });
        await r.body?.cancel();
        out.push({ service, cors: 'allowed', status: r.status });
      } catch (e) {
        out.push({ service, cors: 'blocked', error: String(e) });
      }
    }
    return out;
  }, targets);
  process.stdout.write(
    `${JSON.stringify({ recordedAt: new Date().toISOString(), browser: `Chromium ${browser.version()}`, origin: `http://127.0.0.1:${port}`, results }, null, 2)}\n`,
  );
} finally {
  await browser.close();
  server.close();
}
