import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redirectMatches, redirectUriProblem } from '../src/clients.ts';
import { readConfig } from '../src/config.ts';
import { base64url, sha256, verifyPkceS256 } from '../src/crypto.ts';
import { escapeHtml } from '../src/page.ts';
import { hashPassword, parsePasswordHash, scrypt, verifyPassword } from '../src/scrypt.ts';
import { prefersJson } from '../src/transport.ts';
import { sameResource } from '../src/urls.ts';

describe('scrypt', () => {
  it('matches node:crypto byte for byte', async () => {
    const salt = new TextEncoder().encode('vid2context-salt');
    for (const [logN, r, p] of [
      [4, 1, 1],
      [10, 8, 1],
      [8, 2, 3],
    ] as const) {
      const ours = await scrypt(new TextEncoder().encode('pässwörd'), salt, { logN, r, p }, 32);
      const node = scryptSync('pässwörd', salt, 32, { N: 2 ** logN, r, p });
      expect(Buffer.from(ours).toString('hex')).toBe(node.toString('hex'));
    }
  });

  it('verifies a hash made by node:crypto in the documented format', async () => {
    const salt = Buffer.from('0123456789abcdef');
    const hash = scryptSync('owner pass phrase', salt, 32, { N: 2 ** 14, r: 8, p: 1 });
    const stored = `scrypt:14:8:1:${base64url(salt)}:${base64url(hash)}`;
    expect(await verifyPassword('owner pass phrase', stored)).toBe(true);
    expect(await verifyPassword('owner pass phrasE', stored)).toBe(false);
  });

  it('round-trips hashPassword and rejects malformed hashes', async () => {
    const h = await hashPassword('pw-for-test', { logN: 6, r: 8, p: 1 });
    expect(parsePasswordHash(h)).toMatchObject({ logN: 6, r: 8, p: 1 });
    expect(await verifyPassword('pw-for-test', h)).toBe(true);
    expect(parsePasswordHash('$scrypt$ln=14')).toBeNull();
    expect(await verifyPassword('x', 'plain-text')).toBe(false);
  });
});

describe('PKCE S256', () => {
  it('accepts the RFC 7636 appendix B example and refuses a short verifier', async () => {
    expect(
      await verifyPkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'),
    ).toBe(true);
    expect(await verifyPkceS256('short', base64url(await sha256('short')))).toBe(false);
  });
});

describe('redirect URIs', () => {
  it('allows https and loopback http only', async () => {
    const cfg = await readConfig({});
    expect(redirectUriProblem('https://claude.ai/api/mcp/auth_callback', cfg)).toBeNull();
    expect(redirectUriProblem('http://127.0.0.1:8080/cb', cfg)).toBeNull();
    expect(redirectUriProblem('http://example.com/cb', cfg)).toMatch(/https/);
    expect(redirectUriProblem('myapp://cb', cfg)).toMatch(/https/);
    expect(redirectUriProblem('https://user:pw@x.example/cb', cfg)).toMatch(/credentials/);
  });

  it('applies VID2CONTEXT_OAUTH_ALLOWED_REDIRECTS as prefixes', async () => {
    const cfg = await readConfig({ VID2CONTEXT_OAUTH_ALLOWED_REDIRECTS: 'https://claude.ai/api/mcp/, https://chatgpt.com/' });
    expect(redirectUriProblem('https://claude.ai/api/mcp/auth_callback', cfg)).toBeNull();
    expect(redirectUriProblem('https://evil.example/cb', cfg)).toMatch(/ALLOWED_REDIRECTS/);
  });

  it('matches exactly, except for the port of a loopback redirect', () => {
    const reg = ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback'];
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback', reg)).toBe(true);
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback/', reg)).toBe(false);
    expect(redirectMatches('http://localhost:49152/callback', reg)).toBe(true);
    expect(redirectMatches('http://localhost:49152/other', reg)).toBe(false);
    expect(redirectMatches('http://127.0.0.1:49152/callback', reg)).toBe(false);
  });
});

describe('helpers', () => {
  it('compares resources without a trailing slash or case differences in the host', () => {
    expect(sameResource('https://MCP.vid2context.com/mcp/', 'https://mcp.vid2context.com/mcp')).toBe(true);
    expect(sameResource('https://mcp.vid2context.com/mcp', 'https://mcp.vid2context.com/other')).toBe(false);
    expect(sameResource('http://mcp.vid2context.com/mcp', 'https://mcp.vid2context.com/mcp')).toBe(false);
  });

  it('picks JSON or SSE from the Accept order', () => {
    const req = (accept: string) => new Request('http://x/mcp', { headers: { accept } });
    expect(prefersJson(req('application/json, text/event-stream'))).toBe(true);
    expect(prefersJson(req('text/event-stream, application/json'))).toBe(false);
  });

  it('escapes HTML in client-supplied names', () => {
    expect(escapeHtml('<img src=x onerror="a">')).toBe('&#60;img src=x onerror=&#34;a&#34;&#62;');
  });

  it('reads config defaults and clamps numbers', async () => {
    const cfg = await readConfig({
      VID2CONTEXT_MCP_RATE_LIMIT: '-5',
      VID2CONTEXT_MCP_PUBLIC_URL: 'https://vid2context.com/ignored/path',
    });
    expect(cfg.rateLimitPerMin).toBe(0);
    expect(cfg.publicOrigin).toBe('https://vid2context.com');
    expect(cfg.accessTtlSec).toBe(3600);
    expect((await readConfig({ VID2CONTEXT_OWNER_PASSWORD_HASH: 'nope' })).ownerPasswordHashInvalid).toBe(true);
  });
});
