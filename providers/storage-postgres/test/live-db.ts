/**
 * Live database for LIVE=1 tests: DATABASE_URL (or VID2CONTEXT_DATABASE_URL)
 * when set, otherwise a throwaway pgvector/pgvector container started here,
 * plus Neon's open-source proxy (ghcr.io/timowilhelm/local-neon-http-proxy,
 * which runs the real neon-proxy binary) in front of it so the Neon HTTP
 * driver is exercised end to end. Containers get random names and ports in
 * 20000-29999 and are removed by stop().
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isNeonUrl } from '../src/config.ts';

export interface LiveDb {
  source: 'DATABASE_URL' | 'docker';
  url: string;
  /** Neon HTTP access: a real Neon URL, or the local proxy with its endpoint. */
  neon?: { url: string; endpoint?: string };
  stop(): Promise<void>;
}

function docker(args: string[], timeout = 120_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function dockerAvailable(): boolean {
  try {
    docker(['info', '--format', '{{.ServerVersion}}'], 15_000);
    return true;
  } catch {
    return false;
  }
}

const port = () => 20000 + Math.floor(Math.random() * 10000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean> | boolean, what: string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await check()) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startLiveDb(): Promise<LiveDb | null> {
  const envUrl = process.env.VID2CONTEXT_DATABASE_URL || process.env.DATABASE_URL;
  if (envUrl) {
    return { source: 'DATABASE_URL', url: envUrl, neon: isNeonUrl(envUrl) ? { url: envUrl } : undefined, stop: async () => {} };
  }
  if (!dockerAvailable()) return null;

  const id = randomBytes(4).toString('hex');
  const password = randomBytes(12).toString('hex');
  const net = `v2c-storage-pg-${id}`;
  const pgName = `v2c-storage-pg-${id}`;
  const proxyName = `v2c-storage-neon-${id}`;
  const pgPort = port();
  const proxyPort = port();
  const started: string[] = [];
  const stop = async () => {
    for (const name of started.reverse()) {
      try {
        docker(['rm', '-f', name]);
      } catch {
        // already gone
      }
    }
    try {
      docker(['network', 'rm', net]);
    } catch {
      // already gone
    }
  };
  try {
    docker(['network', 'create', net]);
    docker([
      'run',
      '-d',
      '--name',
      pgName,
      '--network',
      net,
      '--network-alias',
      'postgres',
      '-p',
      `127.0.0.1:${pgPort}:5432`,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=main',
      'pgvector/pgvector:pg17',
    ]);
    started.push(pgName);
    await waitFor(() => {
      docker(['exec', pgName, 'pg_isready', '-U', 'postgres', '-d', 'main', '-h', '127.0.0.1'], 10_000);
      return true;
    }, 'postgres');
    // pg_isready can pass during the init restart; give it a beat and re-check.
    await sleep(1500);
    await waitFor(() => {
      docker(['exec', pgName, 'psql', '-U', 'postgres', '-d', 'main', '-h', '127.0.0.1', '-c', 'select 1'], 10_000);
      return true;
    }, 'postgres after init');

    let neon: LiveDb['neon'];
    try {
      docker([
        'run',
        '-d',
        '--name',
        proxyName,
        '--network',
        net,
        '-p',
        `127.0.0.1:${proxyPort}:4444`,
        '-e',
        `PG_CONNECTION_STRING=postgres://postgres:${password}@postgres:5432/main`,
        'ghcr.io/timowilhelm/local-neon-http-proxy:main',
      ]);
      started.push(proxyName);
      const endpoint = `http://127.0.0.1:${proxyPort}/sql`;
      const url = `postgres://postgres:${password}@db.localtest.me:5432/main`;
      await waitFor(async () => {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Neon-Connection-String': url, 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'select 1', params: [] }),
        });
        return res.ok;
      }, 'neon proxy');
      neon = { url, endpoint };
    } catch (err) {
      console.error(`[storage-postgres live] Neon proxy unavailable, skipping Neon HTTP tests: ${(err as Error).message}`);
    }
    return { source: 'docker', url: `postgres://postgres:${password}@127.0.0.1:${pgPort}/main`, neon, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
