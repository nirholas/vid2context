import { describe, expect, it } from 'vitest';
import {
  eventData,
  parsePortRequest,
  parseWebMessage,
  pongMessage,
  progressMessage,
  resultMessage,
} from '../src/lib/bridge-protocol.ts';

const ZOO = 'jNQXAC9IVRw';
const self = { window: {}, origin: 'https://vid2context.com' };

describe('eventData: only this window and origin', () => {
  const data = { source: 'vid2context-web', type: 'ping', id: '1' };

  it('passes a message from the same window and origin', () => {
    expect(eventData({ source: self.window, origin: self.origin, data }, self)).toBe(data);
  });

  it('drops a message from another frame or window', () => {
    expect(eventData({ source: {}, origin: self.origin, data }, self)).toBeNull();
    expect(eventData({ source: null, origin: self.origin, data }, self)).toBeNull();
  });

  it('drops a message from another origin, even through the same window object', () => {
    expect(eventData({ source: self.window, origin: 'https://evil.example', data }, self)).toBeNull();
    expect(eventData({ source: self.window, origin: 'http://vid2context.com', data }, self)).toBeNull();
  });
});

describe('parseWebMessage', () => {
  it('reads a ping', () => {
    expect(parseWebMessage({ source: 'vid2context-web', type: 'ping', id: 'p1' })).toEqual({ kind: 'ping', id: 'p1' });
  });

  it('reads a transcript request, with and without a language', () => {
    expect(parseWebMessage({ source: 'vid2context-web', type: 'youtube-transcript', id: 'r1', videoId: ZOO })).toEqual({
      kind: 'transcript',
      id: 'r1',
      request: { videoId: ZOO },
    });
    expect(
      parseWebMessage({ source: 'vid2context-web', type: 'youtube-transcript', id: 'r2', videoId: ZOO, language: 'pt-BR' }),
    ).toEqual({ kind: 'transcript', id: 'r2', request: { videoId: ZOO, language: 'pt-BR' } });
  });

  it('ignores anything that is not a web app message', () => {
    for (const data of [
      null,
      undefined,
      'ping',
      42,
      [],
      { type: 'ping', id: '1' },
      { source: 'vid2context-extension', type: 'pong', id: '1', version: '0.1.0', capabilities: [] },
      { source: 'vid2context-web', type: 'unknown', id: '1' },
      { source: 'vid2context-web', type: 'ping' },
      { source: 'vid2context-web', type: 'ping', id: '' },
      { source: 'vid2context-web', type: 'ping', id: 7 },
      { source: 'vid2context-web', type: 'ping', id: 'x'.repeat(201) },
      { source: 'vid2context-web', type: 'youtube-transcript', videoId: ZOO },
      new (class {
        source = 'vid2context-web';
        type = 'ping';
        id = '1';
      })(),
    ]) {
      expect(parseWebMessage(data), JSON.stringify(data)).toBeNull();
    }
  });

  it('answers a bad video id or language with bad-request, keeping the id', () => {
    for (const videoId of [
      'jNQXAC9IVR',
      'jNQXAC9IVRwx',
      'jNQXAC9IV/w',
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      12345678901,
    ]) {
      const msg = parseWebMessage({ source: 'vid2context-web', type: 'youtube-transcript', id: 'r', videoId });
      expect(msg).toMatchObject({ kind: 'invalid', id: 'r', error: { code: 'bad-request' } });
    }
    for (const language of ['', 'english please', 'e', 7, 'en_US']) {
      const msg = parseWebMessage({ source: 'vid2context-web', type: 'youtube-transcript', id: 'r', videoId: ZOO, language });
      expect(msg).toMatchObject({ kind: 'invalid', id: 'r', error: { code: 'bad-request' } });
    }
  });
});

describe('extension messages', () => {
  it('builds pong with and without an id', () => {
    expect(pongMessage('0.1.0', 'p1')).toEqual({
      source: 'vid2context-extension',
      type: 'pong',
      id: 'p1',
      version: '0.1.0',
      capabilities: ['youtube-transcript'],
    });
    expect(pongMessage('0.1.0')).toEqual({
      source: 'vid2context-extension',
      type: 'pong',
      version: '0.1.0',
      capabilities: ['youtube-transcript'],
    });
  });

  it('builds progress and result envelopes', () => {
    expect(progressMessage('r1', 'tab', 'Opening')).toEqual({
      source: 'vid2context-extension',
      type: 'progress',
      id: 'r1',
      stage: 'tab',
      message: 'Opening',
    });
    expect(resultMessage('r1', { ok: false, error: { code: 'timeout', message: 'late' } })).toEqual({
      source: 'vid2context-extension',
      type: 'youtube-transcript:result',
      id: 'r1',
      ok: false,
      error: { code: 'timeout', message: 'late' },
    });
  });
});

describe('parsePortRequest (the background re-checks what bridge.js forwards)', () => {
  it('accepts a valid request and rejects the rest with bad-request', () => {
    expect(parsePortRequest({ type: 'youtube-transcript', videoId: ZOO, language: 'de' })).toEqual({
      videoId: ZOO,
      language: 'de',
    });
    expect(parsePortRequest({ type: 'youtube-transcript', videoId: 'nope' })).toMatchObject({ code: 'bad-request' });
    expect(parsePortRequest({ type: 'ping' })).toMatchObject({ code: 'bad-request' });
    expect(parsePortRequest('youtube-transcript')).toMatchObject({ code: 'bad-request' });
  });
});
