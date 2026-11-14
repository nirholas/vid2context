import { createContext, expandInput, getVideoContext } from '@vid2context/core';
import { createRegistry } from '@vid2context/registry/node';
import { describe, expect, it } from 'vitest';
import { discoverVideos } from '../src/index.ts';

// Real network. Run with LIVE=1 (npm run test:live).
describe.skipIf(!process.env.LIVE)('web-page (live)', () => {
  const ctx = () => createContext({ runtime: 'node', env: process.env });
  const ARTICLE = 'https://www.openculture.com/2012/07/ts_eliot_reads_his_modernist_masterpieces.html';
  const TED = 'https://www.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity';

  it('discovers the videos embedded in a real article', async () => {
    const videos = await discoverVideos(ARTICLE, ctx());
    expect(videos.map((v) => v.input)).toEqual(
      expect.arrayContaining(['https://www.youtube.com/watch?v=CqvhMeZ2PlY', 'https://vimeo.com/7602340']),
    );
  }, 60_000);

  it('expands page:<article> through expandInput on the node registry', async () => {
    const refs = await expandInput(createRegistry(), `page:${ARTICLE}`, ctx());
    expect(refs.map((r) => r.id)).toEqual(expect.arrayContaining(['youtube:CqvhMeZ2PlY', 'vimeo:7602340']));
  }, 60_000);

  it('reads the transcript a page publishes in JSON-LD', async () => {
    const registry = createRegistry();
    const c = ctx();
    const refs = await expandInput(registry, `page:${TED}`, c);
    expect(refs[0]?.input).toBe(`page-video:0:${TED}`);
    const result = await getVideoContext(registry, refs[0]?.input ?? '', { mode: 'captions' }, c);
    expect(result.transcript.origin).toBe('native-transcript');
    expect(result.transcript.segments[0]?.text).toMatch(/^Good morning/);
  }, 60_000);
});
