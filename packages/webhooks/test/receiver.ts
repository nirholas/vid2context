/**
 * A real HTTP receiver for delivery tests: node:http on a random port between
 * 20000 and 29999. Each test decides how it answers; every request is kept
 * with its raw body and headers so signatures can be verified exactly as a
 * real consumer would.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface Received {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export type Answer = (req: Received, res: ServerResponse, index: number) => void;

export interface Receiver {
  url: string;
  port: number;
  received: Received[];
  /** Resolves when `n` requests have arrived. */
  waitFor(n: number, timeoutMs?: number): Promise<Received[]>;
  close(): Promise<void>;
}

function flatHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (left: number) => {
      const port = 20000 + Math.floor(Math.random() * 10000);
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(left - 1);
        else reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(port);
      });
    };
    tryPort(20);
  });
}

export async function startReceiver(answer: Answer): Promise<Receiver> {
  const received: Received[] = [];
  const waiters: { n: number; resolve: (r: Received[]) => void }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Received = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: flatHeaders(req),
        body: Buffer.concat(chunks),
      };
      received.push(entry);
      for (const w of waiters.filter((w) => received.length >= w.n)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(received.slice());
      }
      answer(entry, res, received.length - 1);
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/hook`,
    port,
    received,
    waitFor(n, timeoutMs = 5000) {
      if (received.length >= n) return Promise.resolve(received.slice());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`receiver got ${received.length} of ${n} requests`)), timeoutMs);
        waiters.push({
          n,
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
        });
      });
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
