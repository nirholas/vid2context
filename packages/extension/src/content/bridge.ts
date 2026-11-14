/** Ask the main-world page script (src/page/index.ts) a question and wait for its answer. */
import { PAGE_CHANNEL, type PageRequest, type PageResponse } from '../lib/messages.ts';

let nextId = 1;

type Op = { op: 'player'; videoId: string } | { op: 'pot'; videoId: string; languageCode: string };

export function askPage(op: Op, timeoutMs: number): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve) => {
    const done = (value: unknown) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const res = event.data as PageResponse | undefined;
      if (res?.channel === PAGE_CHANNEL && res.dir === 'res' && res.id === id) done(res.value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    window.addEventListener('message', onMessage);
    const req = { channel: PAGE_CHANNEL, dir: 'req', id, ...op } as PageRequest;
    window.postMessage(req, location.origin);
  });
}
