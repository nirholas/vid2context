import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockedAddress, checkUrl, checkUrlSync, parseIPv4, parseIPv6 } from '../../src/security/index.ts';

function lines(name: string): string[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

const dns = JSON.parse(readFileSync(new URL('./fixtures/dns-answers.json', import.meta.url), 'utf8')) as {
  answers: Record<string, string[]>;
  publicAnswers: Record<string, string[]>;
};

/** Answers recorded from real DNS (see fixtures/README.md), replayed like replayFetch replays HTTP. */
const recordedResolver = async (host: string): Promise<string[]> => {
  const a = dns.answers[host] ?? dns.publicAnswers[host];
  if (!a) throw new Error(`no recorded DNS answer for ${host}`);
  return a;
};

describe('checkUrlSync: SSRF payload corpus', () => {
  const payloads = lines('ssrf-payloads.txt');

  it('has the corpus loaded', () => {
    expect(payloads.length).toBeGreaterThan(100);
  });

  for (const p of payloads) {
    it(`refuses ${p.slice(0, 90)}`, () => {
      expect(checkUrlSync(p).ok).toBe(false);
    });
  }
});

describe('checkUrlSync: ordinary public URLs', () => {
  for (const u of lines('public-urls.txt')) {
    it(`allows ${u}`, () => {
      const r = checkUrlSync(u);
      expect(r).toMatchObject({ ok: true });
    });
  }
});

describe('checkUrlSync: normalization and options', () => {
  it('normalizes numeric, octal, hex and short IPv4 forms before checking', () => {
    for (const u of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.1/', 'http://127.1/', 'http://0x7F.0.0.1/']) {
      const r = checkUrlSync(u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('loopback');
    }
  });

  it('strips trailing dots and lowercases hosts', () => {
    expect(checkUrlSync('http://LOCALHOST./').ok).toBe(false);
    expect(checkUrlSync('http://Metadata.Google.Internal./computeMetadata/v1/').ok).toBe(false);
    expect(checkUrlSync('http://169.254.169.254./').ok).toBe(false);
    expect(checkUrlSync('https://WWW.YouTube.COM./watch?v=x').ok).toBe(true);
  });

  it('turns IDN into punycode and still refuses local suffixes', () => {
    const ok = checkUrlSync('https://bücher.example/feed');
    expect(ok.ok && ok.url.hostname).toBe('xn--bcher-kva.example');
    expect(checkUrlSync('http://ｌｏｃａｌｈｏｓｔ/').ok).toBe(false);
    expect(checkUrlSync('http://①②⑦.⓪.⓪.①/').ok).toBe(false);
  });

  it('refuses credentials in the URL', () => {
    const r = checkUrlSync('https://user:pass@example.com/');
    expect(r).toEqual({ ok: false, reason: 'credentials in the URL are not allowed' });
  });

  it('enforces allowPorts, including default ports', () => {
    expect(checkUrlSync('https://example.com/', { allowPorts: [443] }).ok).toBe(true);
    expect(checkUrlSync('https://example.com:8443/', { allowPorts: [443] }).ok).toBe(false);
    expect(checkUrlSync('http://example.com/', { allowPorts: [443] }).ok).toBe(false);
  });

  it('allowPrivate allows local hosts but never metadata endpoints', () => {
    expect(checkUrlSync('http://localhost:11434/v1', { allowPrivate: true }).ok).toBe(true);
    expect(checkUrlSync('http://192.168.1.20:8080/', { allowPrivate: true }).ok).toBe(true);
    expect(checkUrlSync('http://169.254.169.254/latest/', { allowPrivate: true }).ok).toBe(false);
    expect(checkUrlSync('http://metadata.google.internal/', { allowPrivate: true }).ok).toBe(false);
  });

  it('allowHosts exempts one exact host:port', () => {
    expect(checkUrlSync('http://127.0.0.1:11434/v1', { allowHosts: ['127.0.0.1:11434'] }).ok).toBe(true);
    expect(checkUrlSync('http://127.0.0.1:11435/v1', { allowHosts: ['127.0.0.1:11434'] }).ok).toBe(false);
  });

  it('refuses other schemes unless the policy lists them', () => {
    expect(checkUrlSync('ftp://example.com/a').ok).toBe(false);
    expect(checkUrlSync('ftp://example.com/a', { protocols: ['ftp:'] }).ok).toBe(true);
  });
});

describe('IP parsing and ranges', () => {
  it('parses legacy IPv4 forms', () => {
    expect(parseIPv4('127.0.0.1')).toBe(0x7f000001);
    expect(parseIPv4('2130706433')).toBe(0x7f000001);
    expect(parseIPv4('0177.0.0.01')).toBe(0x7f000001);
    expect(parseIPv4('0x7f.1')).toBe(0x7f000001);
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseIPv4('example.com')).toBeNull();
  });

  it('parses IPv6 with compression, embedded IPv4 and zones', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('[::ffff:127.0.0.1]')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
  });

  it('blocks every reserved range and allows public unicast', () => {
    for (const a of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:8.8.8.8',
      '::127.0.0.1',
      'fc00::1',
      'fd00:ec2::254',
      'fe80::1',
      'ff02::1',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::',
    ]) {
      expect(blockedAddress(a), a).not.toBeNull();
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '142.251.157.4', '2001:4860:4829:400::', '64:ff9b::808:808']) {
      expect(blockedAddress(a), a).toBeNull();
    }
  });
});

describe('checkUrl with a resolver (recorded real DNS answers)', () => {
  for (const host of Object.keys(dns.answers)) {
    it(`refuses ${host}, which resolves to ${dns.answers[host]?.join(', ')}`, async () => {
      const r = await checkUrl(`http://${host}/latest/meta-data/`, { resolve: recordedResolver });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('resolves to');
    });
  }

  for (const host of Object.keys(dns.publicAnswers)) {
    it(`allows ${host}`, async () => {
      expect((await checkUrl(`https://${host}/`, { resolve: recordedResolver })).ok).toBe(true);
    });
  }

  it('refuses a host whose lookup fails', async () => {
    const r = await checkUrl('https://not-recorded.example/', { resolve: recordedResolver });
    expect(r.ok).toBe(false);
  });
});

describe.skipIf(!process.env.LIVE)('checkUrl with live DNS (LIVE=1)', () => {
  const resolve = async (h: string) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address);

  it('refuses names that point at private addresses', async () => {
    for (const host of ['localtest.me', '169.254.169.254.nip.io', 'company.127.0.0.1.nip.io']) {
      expect((await checkUrl(`http://${host}/`, { resolve })).ok, host).toBe(false);
    }
  });

  it('allows YouTube', async () => {
    expect((await checkUrl('https://www.youtube.com/', { resolve })).ok).toBe(true);
  });
});
