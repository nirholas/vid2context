/**
 * whisper-server mode: the model stays loaded between calls. Either an
 * existing server (WHISPER_CPP_SERVER_URL) or a managed one this process
 * starts on demand on a random local port (WHISPER_CPP_SERVER=1) and stops
 * when the process exits.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Ctx, errorFromResponse, fetchWithTimeout, type Segment, Vid2ContextError } from '@vid2context/core';
import { parseVerboseJson } from '@vid2context/provider-stt-openai-compatible';
import { resolveBinary } from './paths.ts';

/** `<base>/inference`, accepting a URL that already ends in /inference. */
export function inferenceUrl(base: string): string {
  const b = base.trim().replace(/\/+$/, '');
  return /\/inference$/.test(b) ? b : `${b}/inference`;
}

export interface ServerRequest {
  language?: string;
  prompt?: string;
  translate?: boolean;
}

/** Build the multipart form for whisper-server's /inference. */
export function inferenceForm(wav: Uint8Array, req: ServerRequest): FormData {
  const form = new FormData();
  form.append('file', new Blob([wav.slice()], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0.0');
  form.append('language', req.language ?? 'auto');
  if (req.prompt) form.append('prompt', req.prompt);
  if (req.translate) form.append('translate', 'true');
  return form;
}

export async function inferViaServer(
  base: string,
  wavPath: string,
  req: ServerRequest,
  ctx: Ctx,
  timeoutMs: number,
): Promise<{ language: string; segments: Segment[] }> {
  const url = inferenceUrl(base);
  const form = inferenceForm(new Uint8Array(await readFile(wavPath)), req);
  let res: Response;
  try {
    res = await fetchWithTimeout(ctx, url, { method: 'POST', body: form }, timeoutMs);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    if ((err as Error).name === 'TimeoutError') {
      throw new Vid2ContextError('timeout', `whisper-server at ${url} did not answer within ${Math.round(timeoutMs / 1000)} s.`, {
        hint: 'Use a smaller model or a GPU build.',
      });
    }
    throw new Vid2ContextError('unavailable', `whisper-server at ${url} is not reachable: ${(err as Error).message}`, {
      hint: 'Start whisper-server, fix WHISPER_CPP_SERVER_URL, or unset it to run whisper-cli directly.',
      cause: err,
    });
  }
  if (!res.ok) throw await errorFromResponse(res, 'whisper-server');
  const json = (await res.json()) as Parameters<typeof parseVerboseJson>[0];
  const parsed = parseVerboseJson(json, req.language);
  return req.translate ? { ...parsed, language: 'en' } : parsed;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

interface Managed {
  url: string;
  child: ChildProcess;
}

const managed = new Map<string, Promise<Managed>>();
let exitHookInstalled = false;
const children = new Set<{ child: ChildProcess; logDir: string }>();

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const c of children) {
      c.child.kill('SIGKILL');
      rmSync(c.logDir, { recursive: true, force: true });
    }
  });
}

/** Stop every managed server this process started (also runs on exit). */
export function stopManagedServers(): void {
  for (const c of children) {
    c.child.kill('SIGKILL');
    rmSync(c.logDir, { recursive: true, force: true });
  }
  children.clear();
  managed.clear();
}

async function start(modelPath: string, threads: number, ctx: Ctx): Promise<Managed> {
  const bin = resolveBinary(ctx.env, 'whisper-server');
  if (!bin) {
    throw new Vid2ContextError(
      'unavailable',
      'whisper-server was not found (next to WHISPER_CPP_BIN, on PATH, or in the managed install).',
      {
        hint: 'Run setup with --server, or unset WHISPER_CPP_SERVER to use whisper-cli.',
      },
    );
  }
  const port = await freePort();
  const logDir = mkdtempSync(join(tmpdir(), 'vid2context-whisper-server-'));
  const logFile = join(logDir, 'server.log');
  const fd = openSync(logFile, 'w');
  const child = spawn(bin.path, ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads)], {
    stdio: ['ignore', fd, fd],
    shell: false,
    windowsHide: true,
    env: ctx.env as NodeJS.ProcessEnv,
  });
  closeSync(fd);
  child.unref();
  const entry = { child, logDir };
  children.add(entry);
  installExitHook();
  let exited = false;
  child.once('exit', () => {
    exited = true;
    children.delete(entry);
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exited || child.exitCode !== null) break;
    try {
      const res = await fetchWithTimeout(ctx, `${url}/health`, {}, 2_000);
      if (res.ok) {
        ctx.log.info(`whisper-server started on port ${port}`);
        return { url, child };
      }
      await res.body?.cancel();
    } catch {
      if (ctx.signal?.aborted) break;
    }
    await sleep(250);
  }
  let log = '';
  try {
    log = readFileSync(logFile, 'utf8').trim().split('\n').slice(-8).join('\n');
  } catch {
    log = '';
  }
  child.kill('SIGKILL');
  children.delete(entry);
  rmSync(logDir, { recursive: true, force: true });
  if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
  throw new Vid2ContextError('unavailable', `whisper-server did not start: ${log || 'no output'}`, {
    hint: 'Check the model with whisper-cli first, or unset WHISPER_CPP_SERVER to run whisper-cli directly.',
  });
}

/** The URL of a managed whisper-server for this model, starting it on first use. */
export async function managedServerUrl(modelPath: string, threads: number, ctx: Ctx): Promise<string> {
  const key = `${modelPath}\n${threads}`;
  let p = managed.get(key);
  if (p) {
    const m = await p.catch(() => null);
    if (m && m.child.exitCode === null && m.child.signalCode === null) return m.url;
    managed.delete(key);
  }
  p = start(modelPath, threads, ctx);
  managed.set(key, p);
  try {
    return (await p).url;
  } catch (err) {
    managed.delete(key);
    throw err;
  }
}
