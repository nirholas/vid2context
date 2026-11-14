/**
 * Record real Supadata responses into test/fixtures/, for replay tests with
 * replayFetch. Needs a real key; it spends about 4 credits of the free plan's
 * 100 a month.
 *
 *   SUPADATA_API_KEY=... npx tsx providers/supadata/scripts/record-fixtures.ts
 *
 * (or put the key in .env). Each case runs the real provider with a fetch that
 * keeps a copy of every response, so job polling is recorded too:
 *
 *   transcript-jNQXAC9IVRw-en   "Me at the zoo", lang=en: a native transcript (200, or 202 then polls)
 *   transcript-brXcsLhw84o      a one-minute piano video without captions: 206 transcript-unavailable
 *   transcript-xxxxxxxxxxx      an id that does not exist: the not-found shape
 *   transcript-bad-key          a deliberately invalid key: 401 unauthorized
 *
 * Scrubbing, so nothing personal lands in this public repo: the key (real and
 * invalid) is replaced with [redacted] wherever it appears (the unauthorized
 * body echoes the key it got), only content-type, x-billable-requests and
 * retry-after headers are kept, and emails and IPv4 addresses in bodies are
 * replaced. Review every file, grep it for your public IP, and document it in
 * test/fixtures/README.md before committing.
 */
import { writeFileSync } from 'node:fs';
import { createContext, type Env, type VideoRef } from '@vid2context/core';
import { loadEnvFiles } from '@vid2context/registry/node';
import supadata from '../src/index.ts';

const fixtures = new URL('../test/fixtures/', import.meta.url);
const KEEP_HEADERS = ['content-type', 'x-billable-requests', 'retry-after'];
const BAD_KEY = 'sd_invalid_key_for_vid2context_fixture';

interface Recorded {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email redacted]');
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '0.0.0.0');
  return out;
}

function teeFetch(log: Recorded[], secrets: string[]): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    const body = await res.text();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const k of KEEP_HEADERS) {
      const v = res.headers.get(k);
      if (v) headers[k] = v;
    }
    log.push({
      method: init?.method ?? 'GET',
      url: scrub(url, secrets),
      status: res.status,
      headers,
      body: scrub(body, secrets),
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

const ref = (id: string): VideoRef => ({
  input: id,
  platform: 'youtube',
  kind: 'video',
  id: `youtube:${id}`,
  nativeId: id,
  url: `https://www.youtube.com/watch?v=${id}`,
});

async function record(name: string, id: string, language: string | undefined, env: Env, secrets: string[]): Promise<void> {
  const responses: Recorded[] = [];
  const ctx = createContext({ runtime: 'node', env, fetch: teeFetch(responses, secrets) });
  let outcome: string;
  try {
    const t = await supadata.getCaptions(ref(id), language ? { language } : {}, ctx);
    outcome = t ? `transcript: ${t.language}, ${t.segments.length} segments` : 'null';
  } catch (err) {
    outcome = `error: ${scrub(err instanceof Error ? `${(err as { code?: string }).code ?? ''} ${err.message}` : String(err), secrets)}`;
  }
  const out = { recordedAt: new Date().toISOString(), case: name, videoId: id, language, outcome, responses };
  writeFileSync(new URL(`${name}.json`, fixtures), `${JSON.stringify(out, null, 2)}\n`);
  console.error(`${name}: ${responses.map((r) => r.status).join(', ')} -> ${outcome}`);
}

loadEnvFiles();
const key = process.env.SUPADATA_API_KEY?.trim();
if (!key) {
  console.error('SUPADATA_API_KEY is not set. Get a free key at https://dash.supadata.ai and retry.');
  process.exit(1);
}
const env = process.env as Env;
const secrets = [key, BAD_KEY];
await record('transcript-jNQXAC9IVRw-en', 'jNQXAC9IVRw', 'en', env, secrets);
await record('transcript-brXcsLhw84o', 'brXcsLhw84o', undefined, env, secrets);
await record('transcript-xxxxxxxxxxx', 'xxxxxxxxxxx', undefined, env, secrets);
await record('transcript-bad-key', 'jNQXAC9IVRw', undefined, { ...env, SUPADATA_API_KEY: BAD_KEY }, secrets);
console.error('Review the files, grep them for your public IP, then document them in test/fixtures/README.md.');
