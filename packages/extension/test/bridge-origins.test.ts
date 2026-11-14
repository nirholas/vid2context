import { describe, expect, it } from 'vitest';
import { youtubeOriginRule } from '../src/background/youtube-origin.ts';
import {
  addOrigin,
  BRIDGE_SCRIPT_ID,
  bridgeRegistration,
  builtInCovers,
  normalizeOrigins,
  parseOriginInput,
  patternCovers,
  registrationPlan,
  removeOrigin,
} from '../src/lib/bridge-origins.ts';

describe('built-in origins', () => {
  it('covers vid2context.com, its subdomains and local servers on any port', () => {
    for (const u of [
      'https://vid2context.com/app/',
      'https://www.vid2context.com',
      'https://staging.app.vid2context.com',
      'http://localhost:5173',
      'http://127.0.0.1:8787/app/',
    ]) {
      expect(builtInCovers(new URL(u)), u).toBe(true);
    }
  });

  it('does not cover lookalikes, other schemes or other hosts', () => {
    for (const u of [
      'http://vid2context.com',
      'https://evilvid2context.com',
      'https://vid2context.com.evil.example',
      'https://localhost:3000',
      'http://127.0.0.2',
      'https://v2c.example.org',
    ]) {
      expect(builtInCovers(new URL(u)), u).toBe(false);
    }
    expect(patternCovers('not a pattern', new URL('https://vid2context.com'))).toBe(false);
  });
});

describe('parseOriginInput', () => {
  it('turns an address into an origin and a port-free match pattern', () => {
    expect(parseOriginInput(' https://v2c.example.org/app/?x=1 ')).toEqual({
      ok: true,
      origin: 'https://v2c.example.org',
      pattern: 'https://v2c.example.org/*',
    });
    expect(parseOriginInput('http://192.168.1.20:8787')).toEqual({
      ok: true,
      origin: 'http://192.168.1.20:8787',
      pattern: 'http://192.168.1.20/*',
    });
    expect(parseOriginInput('v2c.example.org')).toMatchObject({ ok: true, origin: 'https://v2c.example.org' });
  });

  it('explains what is wrong', () => {
    expect(parseOriginInput('')).toMatchObject({ ok: false });
    expect(parseOriginInput('ftp://v2c.example.org')).toMatchObject({ ok: false });
    expect(parseOriginInput('https://')).toMatchObject({ ok: false });
    const builtIn = parseOriginInput('http://localhost:3000');
    expect(builtIn.ok).toBe(false);
    expect(!builtIn.ok && builtIn.message).toContain('already connected');
  });
});

describe('the stored list', () => {
  it('keeps valid origins, one per host and scheme', () => {
    expect(
      normalizeOrigins([
        'https://v2c.example.org',
        'https://v2c.example.org:8443',
        'http://v2c.example.org',
        'https://vid2context.com',
        'javascript:alert(1)',
        42,
      ]),
    ).toEqual(['https://v2c.example.org', 'http://v2c.example.org']);
    expect(normalizeOrigins('https://v2c.example.org')).toEqual([]);
  });

  it('adds and removes by match pattern', () => {
    const one = addOrigin([], 'http://192.168.1.20:8787');
    expect(one).toEqual({ list: ['http://192.168.1.20:8787'], added: true });
    expect(addOrigin(one.list, 'http://192.168.1.20:3000')).toEqual({ list: one.list, added: false });
    expect(removeOrigin(one.list, 'http://192.168.1.20:3000')).toEqual([]);
  });
});

describe('content script registration', () => {
  it('registers bridge.js on the granted patterns, or nothing', () => {
    expect(bridgeRegistration([])).toBeNull();
    expect(bridgeRegistration(['https://b.example/*', 'https://a.example/*', 'https://b.example/*'])).toEqual({
      id: BRIDGE_SCRIPT_ID,
      matches: ['https://a.example/*', 'https://b.example/*'],
      js: ['bridge.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    });
  });

  it('plans the smallest change', () => {
    const wanted = bridgeRegistration(['https://a.example/*']);
    expect(registrationPlan(undefined, null)).toEqual({ unregister: false, register: null });
    expect(registrationPlan(undefined, wanted)).toEqual({ unregister: false, register: wanted });
    expect(registrationPlan({ id: BRIDGE_SCRIPT_ID, matches: ['https://a.example/*'], js: ['bridge.js'] }, wanted)).toEqual({
      unregister: false,
      register: null,
    });
    expect(registrationPlan({ id: BRIDGE_SCRIPT_ID, matches: ['https://old.example/*'], js: ['bridge.js'] }, wanted)).toEqual({
      unregister: true,
      register: wanted,
    });
    expect(registrationPlan({ id: BRIDGE_SCRIPT_ID, matches: ['https://a.example/*'] }, null)).toEqual({
      unregister: true,
      register: null,
    });
  });
});

describe('YouTube Origin rule', () => {
  it("sets YouTube's Origin only on the extension's own background requests to www.youtube.com", () => {
    expect(youtubeOriginRule('abcdefghijklmnopabcdefghijklmnop')).toEqual({
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'origin', operation: 'set', value: 'https://www.youtube.com' }],
      },
      condition: {
        requestDomains: ['www.youtube.com'],
        initiatorDomains: ['abcdefghijklmnopabcdefghijklmnop'],
        tabIds: [-1],
        resourceTypes: ['xmlhttprequest'],
      },
    });
  });
});
