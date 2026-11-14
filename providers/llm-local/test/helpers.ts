import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordedResponse } from '@vid2context/core/testing';

const dir = join(import.meta.dirname, 'fixtures');

export const fixture = (name: string): string => readFileSync(join(dir, name), 'utf8');

/** Headers that describe the original connection, not the body; Response sets its own. */
const HOP = new Set(['content-length', 'connection', 'keep-alive', 'transfer-encoding', 'date']);

/** A raw `curl -i` recording (status line, headers, blank line, body) as a replayable response. */
export function httpFixture(name: string): RecordedResponse {
  const raw = fixture(name);
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split).split('\r\n');
  const status = Number(head[0]?.split(' ')[1]);
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const at = line.indexOf(':');
    const key = line.slice(0, at).trim().toLowerCase();
    if (!HOP.has(key)) headers[key] = line.slice(at + 1).trim();
  }
  return { status, headers, body: raw.slice(split + 4) };
}

/** A curl recording saved with `-w '\n%{http_code}'`: body, newline, status. */
export function bodyWithStatus(name: string): RecordedResponse {
  const raw = fixture(name).trimEnd();
  const nl = raw.lastIndexOf('\n');
  return { status: Number(raw.slice(nl + 1)), body: raw.slice(0, nl) };
}

export function jsonBody(call: { body: unknown }): Record<string, unknown> {
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
