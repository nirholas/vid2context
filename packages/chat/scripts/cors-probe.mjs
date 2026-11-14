/**
 * Which hosted chat APIs can a web page call directly? Client-only mode only
 * offers those. This opens a real Chromium page on a local origin and sends
 * each endpoint the request its provider sends (POST, JSON body, and the same
 * auth and extra headers; keys are deliberately invalid, so nothing is billed). A readable response, even 401, means CORS allows the
 * call; "Failed to fetch" means the browser blocked it.
 *
 *   node packages/chat/scripts/cors-probe.mjs > packages/chat/test/fixtures/cors-probe.json
 *
 * The endpoint list mirrors the lanes of the LLM providers in providers/ that
 * declare the browser runtime. When a provider adds a service, add it here, then update src/lib/cors.ts and docs/guides/chat.md.
 */
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const body = (model) => JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 400, stream: true });
const bearer = { authorization: 'Bearer invalid-key-for-cors-probe' };
// [service, url, extra headers, body] with the headers each provider really sends.
const targets = [
  ['groq', 'https://api.groq.com/openai/v1/chat/completions', bearer, body('openai/gpt-oss-120b')],
  ['cerebras', 'https://api.cerebras.ai/v1/chat/completions', bearer, body('gpt-oss-120b')],
  ['mistral', 'https://api.mistral.ai/v1/chat/completions', bearer, body('mistral-small-latest')],
  ['github', 'https://models.github.ai/inference/chat/completions', bearer, body('meta/Llama-3.3-70B-Instruct')],
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', bearer, body('gemini-2.5-flash-lite')],
  ['ovh', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions', {}, body('gpt-oss-120b')],
  ['pollinations', 'https://text.pollinations.ai/openai', {}, body('openai-fast')],
  ['openai', 'https://api.openai.com/v1/chat/completions', bearer, body('gpt-5.4-nano')],
  // providers/llm-free-catalog
  ['kilo', 'https://api.kilo.ai/api/gateway/chat/completions', {}, body('nvidia/nemotron-3.5-lightning:free')],
  ['nvidia', 'https://integrate.api.nvidia.com/v1/chat/completions', bearer, body('nvidia/nemotron-3-super-120b-a12b')],
  ['sambanova', 'https://api.sambanova.ai/v1/chat/completions', bearer, body('Meta-Llama-3.3-70B-Instruct')],
  ['cloudflare', 'https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/ai/v1/chat/completions', bearer, body('@cf/meta/llama-3.3-70b-instruct-fp8-fast')],
  ['zhipu', 'https://api.z.ai/api/paas/v4/chat/completions', bearer, body('glm-4.7-flash')],
  ['siliconflow', 'https://api.siliconflow.com/v1/chat/completions', bearer, body('Qwen/Qwen3-8B')],
  // providers/llm-openrouter (sends attribution headers)
  ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', { ...bearer, 'HTTP-Referer': 'https://vid2context.com', 'X-Title': 'vid2context' }, body('openrouter/free')],
  // providers/llm-native
  ['gemini-native', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse', { 'x-goog-api-key': 'invalid-key-for-cors-probe' }, JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ok' }] }] })],
  ['anthropic', 'https://api.anthropic.com/v1/messages', { 'x-api-key': 'invalid-key-for-cors-probe', 'anthropic-version': '2023-06-01' }, JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'ok' }] })],
  ['vertex-gemini', 'https://aiplatform.googleapis.com/v1/projects/probe/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse', bearer, JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ok' }] }] })],
  ['vertex-anthropic', 'https://aiplatform.googleapis.com/v1/projects/probe/locations/global/publishers/anthropic/models/claude-haiku-5-5:streamRawPredict', bearer, JSON.stringify({ anthropic_version: 'vertex-2023-10-16', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'ok' }] })],
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
    for (const [service, url, extra, payload] of list) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: payload });
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
