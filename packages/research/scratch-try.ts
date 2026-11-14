import { readFileSync } from 'node:fs';
import { MemoryStorage, Registry, type VideoContext } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import youtube from '@vid2context/provider-youtube';
import { research, renderResearch } from './src/index.ts';
const load = (f: string) => JSON.parse(readFileSync(`tests/fixtures/contexts/${f}`, 'utf8')) as VideoContext;
const storage = new MemoryStorage();
await storage.putContext(load('youtube-cCPsdFdlshc.json'));
await storage.putContext(load('youtube-jNQXAC9IVRw.json'));
const registry = new Registry([...youtube], 'node');
const deps = { registry, ctx: testContext(), storage };
for (const q of [process.argv[2] ?? 'engine']) {
  const r = await research(['https://www.youtube.com/watch?v=cCPsdFdlshc', 'https://youtu.be/jNQXAC9IVRw'], q, {}, deps);
  console.log(renderResearch(r));
  console.log(JSON.stringify(r.results.map(v=>v.excerpts.map(e=>[e.startSec,e.endSec,e.score,e.context.fromSec,e.context.toSec]))), r.tokens, r.notes);
}
