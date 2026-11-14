import { testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { checkWebhookUrl, classifyIp, parseIPv6 } from '../src/url-guard.ts';

const ctx = testContext();
const local = testContext({ env: { VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL: '1' } });
// Resolution is turned off for the offline cases: they only exercise literal and name checks.
const offline = { resolve: null };

describe('classifyIp', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.5', 'private'],
    ['100.64.0.1', 'private'],
    ['169.254.10.10', 'link-local'],
    ['169.254.169.254', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['0.0.0.0', 'reserved'],
    ['224.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['8.8.8.8', 'public'],
    ['::1', 'loopback'],
    ['::', 'reserved'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::127.0.0.1', 'loopback'],
    ['64:ff9b::a00:1', 'private'],
    ['2002:c0a8:0101::1', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1%eth0', 'link-local'],
    ['ff02::1', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['2606:4700:4700::1111', 'public'],
    ['[2606:4700:4700::1111]', 'public'],
  ])('%s is %s', (ip, cls) => {
    expect(classifyIp(ip)).toBe(cls);
  });

  it('returns null for names and malformed addresses', () => {
    expect(classifyIp('example.com')).toBeNull();
    expect(classifyIp('256.1.1.1')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7:')).toBeNull();
    expect(parseIPv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('checkWebhookUrl', () => {
  it('accepts public https URLs (IP literals and names)', async () => {
    expect((await checkWebhookUrl('https://8.8.8.8/hook', ctx, offline)).href).toBe('https://8.8.8.8/hook');
    expect((await checkWebhookUrl('https://hooks.example.com/n8n?x=1', ctx, offline)).hostname).toBe('hooks.example.com');
  });

  it.each([
    ['http://example.com/hook', /http: is not allowed/],
    ['ftp://example.com/hook', /ftp: is not allowed/],
    ['https://user:pass@example.com/hook', /credentials/],
    ['https://127.0.0.1/hook', /loopback/],
    ['https://2130706433/hook', /loopback/], // decimal
    ['https://0177.0.0.1/hook', /loopback/], // octal
    ['https://0x7f.1/hook', /loopback/], // hex, short form
    ['https://127.1/hook', /loopback/], // short form
    ['https://[::1]/hook', /loopback/],
    ['https://[::ffff:127.0.0.1]/hook', /loopback/],
    ['https://10.0.0.8/hook', /private/],
    ['https://192.168.0.1./hook', /private/], // trailing dot
    ['https://169.254.169.254/latest/meta-data/', /metadata/],
    ['https://[fd00:ec2::254]/', /metadata/],
    ['https://metadata.google.internal/computeMetadata/v1/', /metadata/],
    ['https://localhost/hook', /loopback host/],
    ['https://n8n.localhost/hook', /loopback host/],
    ['https://0.0.0.0/hook', /reserved/],
    ['not a url', /not a valid absolute URL/],
  ])('refuses %s', async (raw, why) => {
    const err = await checkWebhookUrl(raw, ctx, offline).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'bad-request' });
    expect(String((err as Error).message)).toMatch(why);
    expect((err as { hint?: string }).hint).toBeTruthy();
  });

  it('with VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL=1 allows http and local or private hosts, never metadata or link-local', async () => {
    await expect(checkWebhookUrl('http://localhost:5678/webhook/abc', local, offline)).resolves.toBeInstanceOf(URL);
    await expect(checkWebhookUrl('http://127.0.0.1:5678/webhook/abc', local, offline)).resolves.toBeInstanceOf(URL);
    await expect(checkWebhookUrl('http://192.168.1.20:5678/webhook/abc', local, offline)).resolves.toBeInstanceOf(URL);
    await expect(checkWebhookUrl('http://169.254.169.254/latest/meta-data/', local, offline)).rejects.toThrow(/metadata/);
    await expect(checkWebhookUrl('http://169.254.1.1/', local, offline)).rejects.toThrow(/link-local/);
    await expect(checkWebhookUrl('http://metadata.google.internal/', local, offline)).rejects.toThrow(/metadata/);
  });
});

describe.skipIf(!process.env.LIVE)('checkWebhookUrl with live DNS', () => {
  const live = testContext({ runtime: 'node' });

  it('refuses public names whose DNS records point at private or loopback addresses', async () => {
    // localtest.me and nip.io are public DNS zones that answer with loopback or the embedded IP.
    await expect(checkWebhookUrl('https://localtest.me/hook', live)).rejects.toThrow(/resolves to a loopback address/);
    await expect(checkWebhookUrl('https://10.0.0.1.nip.io/hook', live)).rejects.toThrow(/resolves to a private address/);
    await expect(checkWebhookUrl('https://169.254.169.254.nip.io/hook', live)).rejects.toThrow(/resolves to a metadata address/);
  });

  it('accepts a public name and refuses one that does not resolve', async () => {
    await expect(checkWebhookUrl('https://example.com/hook', live)).resolves.toBeInstanceOf(URL);
    await expect(checkWebhookUrl('https://does-not-exist.invalid/hook', live)).rejects.toThrow(/does not resolve/);
  });
});
