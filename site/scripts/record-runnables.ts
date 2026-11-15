/**
 * Record the response of every runnable example from a real vid2context
 * server, so docs pages show real output before anyone presses Run.
 *
 *   npm run start:server                                  # in another terminal
 *   npm --prefix site run record                        # every example
 *   npm --prefix site run record -- transcript ask      # only these
 *   npm --prefix site run record -- --base https://vid2context.com
 *
 * Writes site/test/fixtures/runnables/<id>.json. A response that contains an
 * email address or a stream URL with an IP in it is refused, never written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnables } from '../src/data/runnables.ts';
import { privacyProblem } from '../src/lib/fixture-privacy.ts';
import { buildRequest, defaults, type Recording, requestUrl, SHOWN_HEADERS } from '../src/lib/runnable.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'site/test/fixtures/runnables');
const log = (msg: string) => console.error(`[record] ${msg}`);

const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const base = (baseAt >= 0 ? args[baseAt + 1] : undefined) ?? 'http://127.0.0.1:8787';
const only = new Set(args.filter((a, n) => !a.startsWith('--') && args[n - 1] !== '--base'));
const key = process.env.VID2CONTEXT_API_KEY;
const authHeaders: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};

function at(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

async function main(): Promise<void> {
  const healthRes = await fetch(`${base}/api/v1/health`, { headers: authHeaders, signal: AbortSignal.timeout(15_000) });
  if (!healthRes.ok) throw new Error(`${base}/api/v1/health answered ${healthRes.status}. Is the server running?`);
  const health = (await healthRes.json()) as { name: string; version: string; runtime: string };
  log(`recording from ${health.name} ${health.version} (${health.runtime}) at ${base}`);

  const provided: Record<string, string> = {};
  let failed = 0;
  for (const spec of runnables) {
    const selected = only.size === 0 || only.has(spec.id);
    // Providers run even when not selected, so a later example gets its chained value.
    if (
      !selected &&
      !(spec.provides && runnables.some((r) => only.has(r.id) && r.fields.some((f) => f.from === spec.provides?.name)))
    )
      continue;
    const values = defaults(spec);
    for (const f of spec.fields) if (f.from && provided[f.from]) values[f.name] = provided[f.from] as string;
    const req = buildRequest(spec, values);
    const init: RequestInit = { method: req.method, headers: { ...authHeaders }, signal: AbortSignal.timeout(600_000) };
    if (req.file && spec.sample) {
      const form = new FormData();
      form.append(req.file.field, new Blob([readFileSync(join(root, spec.sample.repoPath))]), req.file.name);
      init.body = form;
    } else if (req.json) {
      init.headers = { ...authHeaders, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(req.json);
    }
    const started = performance.now();
    const res = await fetch(requestUrl(base, req), init);
    const headers: Record<string, string> = {};
    for (const h of SHOWN_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null && h !== 'x-request-id') headers[h] = v;
    }
    const rec: Recording = {
      id: spec.id,
      recordedAt: new Date().toISOString().slice(0, 10),
      server: { name: health.name, version: health.version, runtime: health.runtime },
      request: {
        method: req.method,
        path: req.path,
        query: req.query,
        ...(req.json ? { json: req.json } : {}),
        ...(req.file ? { file: req.file } : {}),
      },
      status: res.status,
      ms: 0,
      headers,
    };
    if (spec.response === 'zip' && res.ok) rec.bodyBase64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    else rec.body = await res.text();

    if (spec.job && res.status === 202 && rec.body) {
      let job = JSON.parse(rec.body) as { id: string; status: string };
      let polls = 0;
      while (job.status === 'queued' || job.status === 'running') {
        await new Promise((r) => setTimeout(r, 1500));
        polls++;
        job = (await (
          await fetch(`${base}/api/v1/jobs/${encodeURIComponent(job.id)}`, { headers: authHeaders })
        ).json()) as typeof job;
      }
      rec.job = { polls, final: job };
    }
    rec.ms = Math.round(performance.now() - started);

    if (spec.provides && res.ok && rec.body) {
      const v = at(JSON.parse(rec.body), spec.provides.path);
      if (typeof v === 'string') provided[spec.provides.name] = v;
    }
    if (!selected) continue;
    const problem = privacyProblem(JSON.stringify(rec));
    if (problem) {
      failed++;
      log(`${spec.id}: NOT written, the response contains ${problem}`);
      continue;
    }
    writeFileSync(join(outDir, `${spec.id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
    const jobNote = rec.job ? `, job ${(rec.job.final as { status: string }).status} after ${rec.job.polls} polls` : '';
    log(`${spec.id}: ${res.status} in ${(rec.ms / 1000).toFixed(1)} s${jobNote}`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
