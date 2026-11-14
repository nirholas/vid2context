/**
 * Record real responses into test/fixtures/ by running the provider's own
 * rungs through a fetch that saves what the service returned. Every scenario
 * whose credentials are missing is skipped and listed at the end.
 *
 *   npx tsx --env-file=.env providers/llm-native/scripts/record-fixtures.ts
 *
 * Always recorded (no credentials needed): the real auth errors Anthropic
 * and Google return for an invalid key. With ANTHROPIC_API_KEY,
 * GEMINI_API_KEY, or GOOGLE_CLOUD_PROJECT plus GOOGLE_ACCESS_TOKEN: chat,
 * stream, JSON Schema and the two-question cache pair.
 *
 * Scrubbing: only an allowlist of headers is kept; the Google Cloud project
 * id and number are replaced with "redacted-project"; anything shaped like an
 * email address is removed. Review the files before committing anyway.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ChatRequest, type Ctx, createContext, type Env, type StreamingLlmRung } from '@vid2context/core';
import { nativeRungs } from '../src/index.ts';

const here = import.meta.dirname;
const outDir = join(here, '..', 'test', 'fixtures');
mkdirSync(outDir, { recursive: true });

const env: Env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
const KEEP_HEADERS = /^(content-type|retry-after|anthropic-ratelimit-.*|x-should-retry)$/i;
const secrets = [env.GOOGLE_CLOUD_PROJECT, env.ANTHROPIC_API_KEY, env.GEMINI_API_KEY, env.GOOGLE_ACCESS_TOKEN].filter(
  (s): s is string => Boolean(s && s.length > 3),
);

function scrub(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('redacted-project');
  return out
    .replace(/projects\/\d{6,}/g, 'projects/redacted-project')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'redacted-email');
}

let current = '';
const written: string[] = [];

const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (KEEP_HEADERS.test(k)) headers[k] = v;
  });
  if (current) {
    // An error answer to a success scenario is saved as <name>.<status>.json, never under the success name.
    const name = res.status >= 400 && !/\.\d{3}-/.test(current) ? current.replace(/\.json$/, `.${res.status}.json`) : current;
    const file = join(outDir, name);
    writeFileSync(file, `${JSON.stringify({ status: res.status, headers, body: scrub(body) }, null, 2)}\n`);
    written.push(`${name} (HTTP ${res.status})`);
  }
  return new Response(body, { status: res.status, headers: res.headers });
};

function ctxFor(e: Env): Ctx {
  return createContext({
    runtime: 'node',
    env: e,
    fetch: recordingFetch,
    log: { debug() {}, info() {}, warn: console.error, error: console.error },
  });
}

function rungFor(e: Env, id: string): StreamingLlmRung {
  const r = nativeRungs(e).find((x) => x.id === id);
  if (!r) throw new Error(`no rung ${id}`);
  return r;
}

const transcriptCtx = JSON.parse(
  readFileSync(join(here, '..', '..', '..', 'tests', 'fixtures', 'contexts', 'youtube-cCPsdFdlshc.json'), 'utf8'),
) as {
  metadata: { title: string };
  transcript: { segments: { startSec: number; text: string }[] };
};
const transcript = transcriptCtx.transcript.segments.map((s) => `[${Math.floor(s.startSec)}s] ${s.text}`).join('\n');
const system = `You answer questions about one video transcript. Cite timestamps like [123s].\n\nVideo: ${transcriptCtx.metadata.title}\n\nTranscript:\n${transcript}`;

const apollo: ChatRequest = {
  messages: [{ role: 'user', content: 'Which year did Apollo 11 land on the moon? One sentence.' }],
  maxTokens: 2000,
};
const apolloJson: ChatRequest = {
  messages: [{ role: 'user', content: 'Which year did Apollo 11 land on the moon? Use keys year and mission.' }],
  maxTokens: 2000,
  json: {
    name: 'answer',
    schema: {
      type: 'object',
      properties: { year: { type: 'integer' }, mission: { type: 'string' } },
      required: ['year', 'mission'],
    },
  },
};
const q1: ChatRequest = {
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: 'Which model years does the video recommend avoiding?' },
  ],
  maxTokens: 4000,
};
const q2: ChatRequest = {
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: 'What does the video say about the interior?' },
  ],
  maxTokens: 4000,
};

async function run(name: string, fn: () => Promise<unknown>): Promise<void> {
  current = name;
  try {
    const out = await fn();
    console.error(`ok    ${name}`, JSON.stringify(out).slice(0, 300));
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error(`error ${name}: ${e.code ?? ''} ${e.message ?? err}`);
  } finally {
    current = '';
  }
}

async function streamAll(r: StreamingLlmRung, req: ChatRequest, ctx: Ctx) {
  const counts: Record<string, number> = {};
  let done: unknown;
  for await (const ev of r.stream(req, ctx)) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    if (ev.type === 'done') done = ev.result;
  }
  return { counts, done };
}

const skipped: string[] = [];

// Real auth errors, no credentials needed.
await run('anthropic.401-invalid-key.json', () =>
  rungFor({ ANTHROPIC_API_KEY: 'sk-ant-invalid' }, 'llm/anthropic/claude-haiku-5-5').chat(apollo, ctxFor({})),
);
await run('gemini-native.400-invalid-key.json', () =>
  rungFor({ GEMINI_API_KEY: 'invalid-key' }, 'llm/gemini-native/gemini-3.8-flash').chat(apollo, ctxFor({})),
);

if (env.ANTHROPIC_API_KEY) {
  const id = `llm/anthropic/${(env.ANTHROPIC_MODEL ?? 'claude-haiku-5-5').split(',')[0]}`;
  const r = rungFor(env, id);
  const ctx = ctxFor(env);
  await run('anthropic.chat.json', () => r.chat(apollo, ctx));
  await run('anthropic.stream.json', () => streamAll(r, apollo, ctx));
  await run('anthropic.json-schema.json', () => r.chat(apolloJson, ctx));
  await run('anthropic.cache-1.json', () => r.chat(q1, ctx));
  await run('anthropic.cache-2.json', () => r.chat(q2, ctx));
} else skipped.push('anthropic (ANTHROPIC_API_KEY unset)');

if (env.GEMINI_API_KEY) {
  const id = `llm/gemini-native/${(env.GEMINI_NATIVE_MODEL ?? 'gemini-3.8-flash').split(',')[0]}`;
  const r = rungFor(env, id);
  const ctx = ctxFor(env);
  await run('gemini-native.chat.json', () => r.chat(apollo, ctx));
  await run('gemini-native.stream.json', () => streamAll(r, q1, ctx));
  await run('gemini-native.json-schema.json', () => r.chat(apolloJson, ctx));
  await run('gemini-native.cache-1.json', () => r.chat(q1, ctx));
  await run('gemini-native.cache-2.json', () => r.chat(q2, ctx));
} else skipped.push('gemini-native (GEMINI_API_KEY unset)');

if (env.GOOGLE_CLOUD_PROJECT && (env.GOOGLE_ACCESS_TOKEN || env.VID2CONTEXT_GCE_METADATA === '1')) {
  const ctx = ctxFor(env);
  const vg = nativeRungs(env).find((x) => x.service === 'vertex-gemini');
  const va = nativeRungs(env).find((x) => x.service === 'vertex-anthropic');
  if (vg) {
    await run('vertex-gemini.chat.json', () => vg.chat(apollo, ctx));
    await run('vertex-gemini.stream.json', () => streamAll(vg, apollo, ctx));
  }
  if (va) {
    await run('vertex-anthropic.chat.json', () => va.chat(apollo, ctx));
    await run('vertex-anthropic.stream.json', () => streamAll(va, apollo, ctx));
    await run('vertex-anthropic.cache-1.json', () => va.chat(q1, ctx));
    await run('vertex-anthropic.cache-2.json', () => va.chat(q2, ctx));
  }
} else skipped.push('vertex (GOOGLE_CLOUD_PROJECT plus GOOGLE_ACCESS_TOKEN or VID2CONTEXT_GCE_METADATA=1 unset)');

console.error(`\nwrote ${written.length} file(s) to ${outDir}:\n  ${written.join('\n  ')}`);
if (skipped.length) console.error(`skipped:\n  ${skipped.join('\n  ')}`);
