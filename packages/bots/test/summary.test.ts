import { createContext, Registry, type VideoContext } from '@vid2context/core';
import { replayFetch } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import { describe, expect, it } from 'vitest';
import { discordEmbed, escapeTelegramHtml, slackMessage, telegramMessage } from '../src/format.ts';
import { replyFromContext, transcriptFilename } from '../src/reply.ts';
import {
  buildSummaryRequest,
  fitBlocks,
  parseSummary,
  parseTimestamp,
  SUMMARY_SYSTEM_PROMPT,
  summarize,
  toBlocks,
  validTime,
} from '../src/summary.ts';
import { fixtureJson, type LlmRecording, readRepo } from './helpers.ts';

// Real pipeline output (tests/fixtures/contexts) and the real completion recorded for its summary request.
const context = JSON.parse(readRepo('tests/fixtures/contexts/youtube-cCPsdFdlshc.json')) as VideoContext;
const recording = fixtureJson<LlmRecording>('llm-summary-cCPsdFdlshc.json');
const answer = (recording.response as { choices: { message: { content: string } }[] }).choices[0]?.message.content ?? '';
const segments = context.transcript.segments;

describe('summary request', () => {
  it('is exactly the request the fixture was recorded with', () => {
    const req = buildSummaryRequest(context);
    expect(req.messages).toEqual(recording.request.messages);
    expect(req.messages[0]?.content).toBe(SUMMARY_SYSTEM_PROMPT);
  });

  it('cites blocks by their start time and keeps every word of a transcript that fits', () => {
    const blocks = toBlocks(segments);
    expect(blocks[0]?.startSec).toBe(segments[0]?.startSec);
    expect(blocks.length).toBeLessThan(segments.length);
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    expect(blocks.reduce((n, b) => n + words(b.text), 0)).toBe(segments.reduce((n, s) => n + words(s.text), 0));
    const user = buildSummaryRequest(context).messages[1]?.content ?? '';
    expect(user).toContain(`Title: ${context.metadata.title}`);
    expect(user).toContain('Transcript (each line starts with its time):\n[0:00] ');
  });

  it('samples evenly across the whole video when the transcript is over budget', () => {
    const blocks = toBlocks(segments);
    const { blocks: kept, sampled } = fitBlocks(blocks, 4000);
    expect(sampled).toBe(true);
    expect(kept[0]).toBe(blocks[0]);
    expect(kept.at(-1)).toBe(blocks.at(-1));
    expect(kept.reduce((n, b) => n + b.text.length + 10, 0)).toBeLessThanOrEqual(4000 + 500);
    expect(buildSummaryRequest(context, 4000).messages[1]?.content).toContain('Transcript excerpts, evenly spaced');
  });
});

describe('parsing the answer', () => {
  it('reads every bullet of the recorded answer with a valid timestamp', () => {
    const bullets = parseSummary(answer, segments);
    expect(bullets).toHaveLength(answer.split('\n').filter((l) => l.startsWith('- ')).length);
    expect(bullets.length).toBeGreaterThanOrEqual(5);
    expect(bullets[0]?.times).toEqual([0]);
    for (const b of bullets) {
      expect(b.text).not.toMatch(/\[\d/);
      for (const t of b.times) expect(validTime(segments, t)).toBe(true);
    }
  });

  it('drops a timestamp past the end of the video, and the bullet left without one', () => {
    const lines = answer.split('\n');
    const lastSec = Math.ceil(segments.at(-1)?.endSec ?? 0);
    expect(parseTimestamp('59:59')).toBeGreaterThan(lastSec);
    const changed = [lines[0]?.replace(/\[\d+:\d{2}\]/, '[59:59]'), ...lines.slice(1)].join('\n');
    const bullets = parseSummary(changed, segments);
    expect(bullets).toHaveLength(parseSummary(answer, segments).length - 1);
    expect(bullets[0]?.text).toBe(parseSummary(answer, segments)[1]?.text);
  });

  it('parses m:ss and h:mm:ss and rejects malformed times', () => {
    expect(parseTimestamp('3:25')).toBe(205);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('3:75')).toBeNull();
  });
});

describe('reply rendering', () => {
  it('builds a reply from the recorded completion and renders it for every platform', async () => {
    const fetch = replayFetch([{ method: 'POST', url: recording.url, response: { body: JSON.stringify(recording.response) } }]);
    const ctx = createContext({ runtime: 'node', env: {}, fetch });
    const registry = new Registry([llm], 'node');
    expect((await summarize(registry, context, ctx)).rung).toBe(recording.rung);
    const reply = await replyFromContext(registry, context, ctx);
    expect(reply.bullets[1]?.citations).toEqual([
      { sec: 60, label: '1:00', url: 'https://www.youtube.com/watch?v=cCPsdFdlshc&t=60s' },
    ]);
    expect(reply.transcript.filename).toBe(transcriptFilename(context.metadata.title, context.metadata.ref));
    expect(reply.transcript.text.startsWith(`${context.metadata.title}\nhttps://www.youtube.com/watch?v=cCPsdFdlshc\n`)).toBe(
      true,
    );

    const tg = telegramMessage(reply);
    expect(tg).toContain(escapeTelegramHtml(context.metadata.title));
    expect(tg).not.toMatch(/<(?!\/?(b|i|a)[ >])/);
    expect(slackMessage(reply)).toContain('<https://www.youtube.com/watch?v=cCPsdFdlshc&t=60s|[1:00]>');
    expect(discordEmbed(reply).description).toContain('[[1:00]](<https://www.youtube.com/watch?v=cCPsdFdlshc&t=60s>)');
  });

  it('names transcript files safely', () => {
    expect(transcriptFilename('Best & Worst G-Wagon Years', context.metadata.ref)).toBe(
      'Best-Worst-G-Wagon-Years-transcript.txt',
    );
    expect(transcriptFilename('../../etc/passwd', context.metadata.ref)).toBe('etcpasswd-transcript.txt');
    expect(transcriptFilename('日本語', context.metadata.ref)).toBe('cCPsdFdlshc-transcript.txt');
  });
});

describe.skipIf(!process.env.LIVE)('live summary (LIVE=1, keyless chain)', () => {
  it('gets cited bullets from a real keyless rung', async () => {
    const ctx = createContext({ runtime: 'node', env: {} });
    const summary = await summarize(new Registry([llm], 'node'), context, ctx);
    expect(summary.bullets.length).toBeGreaterThanOrEqual(3);
    for (const b of summary.bullets) for (const t of b.times) expect(validTime(segments, t)).toBe(true);
  }, 240_000);
});
