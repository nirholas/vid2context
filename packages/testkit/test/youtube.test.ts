/**
 * Self-tests: the source and captions suites against the YouTube provider and
 * the player and timedtext responses it recorded.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordedCall, Route } from '@vid2context/core/testing';
import { youtubeCaptions, youtubeSource } from '@vid2context/provider-youtube';
import { describeCaptions, describeSource, repoRoot } from '../src/index.ts';

const yt = (name: string) => readFileSync(join(repoRoot, 'providers/youtube/test/fixtures', name), 'utf8');

// Player responses recorded by the youtube provider, answered by video id whatever innertube client asks.
const PLAYERS: Record<string, string> = {
  jNQXAC9IVRw: 'player-jNQXAC9IVRw.json',
  cCPsdFdlshc: 'player-cCPsdFdlshc.json',
  '6SJNVb0GnPI': 'player-removed-6SJNVb0GnPI.json',
};

function youtubeRoutes(): Route[] {
  return [
    {
      method: 'POST',
      url: (u) => u.hostname === 'www.youtube.com' && u.pathname === '/youtubei/v1/player',
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        return { body: yt(PLAYERS[videoId] ?? 'player-unavailable.json'), headers: { 'content-type': 'application/json' } };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/, response: { body: yt('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=de.*fmt=srv3/, response: { body: yt('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
    { url: /timedtext\?v=cCPsdFdlshc.*lang=en.*fmt=srv3/, response: { body: yt('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
  ];
}

describeSource(youtubeSource, {
  matches: [
    { input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', id: 'youtube:jNQXAC9IVRw', kind: 'video' },
    'https://youtu.be/jNQXAC9IVRw?si=abc',
    'jNQXAC9IVRw',
    { input: 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b', kind: 'playlist' },
    { input: 'https://www.youtube.com/@jawed', kind: 'channel' },
  ],
  rejects: ['https://vimeo.com/76979871', 'https://www.youtube.com/feed/subscriptions', '/home/user/talk.mp3'],
  metadataCases: [
    { input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', routes: youtubeRoutes(), title: 'Me at the zoo', chapters: 3 },
    { input: 'https://www.youtube.com/watch?v=cCPsdFdlshc', routes: youtubeRoutes(), chapters: 0 },
  ],
  metadataErrors: [
    { input: 'https://www.youtube.com/watch?v=6SJNVb0GnPI', routes: youtubeRoutes(), code: ['not-found', 'unavailable'] },
  ],
});

describeCaptions(youtubeCaptions, {
  source: youtubeSource,
  cases: [
    {
      input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      routes: youtubeRoutes(),
      expect: 'transcript',
      origin: 'creator-captions',
      language: 'en',
      segments: 6,
    },
    {
      input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      routes: youtubeRoutes(),
      options: { language: 'de' },
      expect: 'transcript',
      language: 'de',
    },
    {
      input: 'https://www.youtube.com/watch?v=cCPsdFdlshc',
      routes: youtubeRoutes(),
      expect: 'transcript',
      origin: 'auto-captions',
    },
    {
      input: 'https://www.youtube.com/watch?v=cCPsdFdlshc',
      routes: youtubeRoutes(),
      options: { allowAuto: false, allowTranslated: false },
      expect: 'none',
    },
  ],
  unsupported: ['https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b'],
});
