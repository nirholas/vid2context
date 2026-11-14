/**
 * A small typed client for the vid2context HTTP API with plain fetch: read
 * the outline of a long video, fetch one section, then stream a cited
 * answer from POST /chat (server-sent events) as it is written.
 *
 *   npm run start:server                     # in another terminal
 *   npx tsx examples/http/client.ts [base-url]
 *
 * Live, no keys needed. Default base URL: http://127.0.0.1:8787. Set
 * VID2CONTEXT_API_KEY when the server requires API keys.
 */
export {}; // No imports are needed, so mark the file as a module for top-level await.

const base = `${process.argv[2] ?? process.env.VID2CONTEXT_URL ?? 'http://127.0.0.1:8787'}/api/v1`;
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (process.env.VID2CONTEXT_API_KEY) headers.Authorization = `Bearer ${process.env.VID2CONTEXT_API_KEY}`;

interface ApiError {
  error: { code: string; message: string; hint?: string };
}
interface Outline {
  metadata: { title: string; durationSec?: number };
  chapters: { title: string; startSec: number; tokens: number }[];
  totalTokens: number;
}
interface Citation {
  n: number;
  title: string;
  startSec: number;
  url?: string;
}

/** Every error body has a stable code and a hint; surface both. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json()) as ApiError;
    throw new Error(`${res.status} ${body.error.code}: ${body.error.message} (${body.error.hint ?? 'no hint'})`);
  }
  return res;
}

const url = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const out = (s: string) => process.stdout.write(s);

// 1. The outline costs a few hundred tokens and says where everything is.
const outline = (await (await call(`/outline?${q({ url })}`)).json()) as Outline;
out(`${outline.metadata.title}: ${outline.totalTokens} tokens in ${outline.chapters.length} sections\n`);
const biggest = outline.chapters.reduce((a, b) => (b.tokens > a.tokens ? b : a));
out(`Largest section: "${biggest.title}" (${biggest.tokens} tokens)\n\n`);

// 2. Read only that section, by its title.
const section = await (await call(`/section?${q({ url, chapter: biggest.title, timestamps: '1' })}`)).text();
out(`${section.split('\n').slice(0, 5).join('\n')}\n...\n\n`);

// 3. Stream an answer. Events: meta, reasoning*, delta+, then done or error.
const res = await call('/chat', {
  method: 'POST',
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'Which model years do they recommend, and why?' }],
    context: { inputs: [url] },
    maxTokens: 600,
  }),
});
if (!res.body) throw new Error('The server sent no stream.');

let buffer = '';
const decoder = new TextDecoder();
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let end = buffer.indexOf('\n\n');
  while (end !== -1) {
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    end = buffer.indexOf('\n\n');
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (!event || !data) continue; // keep-alive comments
    const payload = JSON.parse(data);
    if (event === 'meta') out(`[${payload.sources.length} excerpts, answering with ${payload.rung}]\n`);
    if (event === 'delta') out(payload.text);
    if (event === 'done') {
      out('\n\nCitations:\n');
      for (const c of payload.citations as Citation[])
        out(`  [${c.n}] ${c.title.slice(0, 40)} @ ${Math.floor(c.startSec)}s ${c.url ?? ''}\n`);
    }
    if (event === 'error') throw new Error(`${payload.code}: ${payload.message} (${payload.hint ?? 'no hint'})`);
  }
}
