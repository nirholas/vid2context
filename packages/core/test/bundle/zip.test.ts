import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32 } from '../../src/bundle/crc32.ts';
import { dosDateTime, zipStream, zipToBytes } from '../../src/bundle/zip.ts';
import { Vid2ContextError } from '../../src/errors.ts';
import { render } from '../../src/format/index.ts';
import { gwagon, hasUnzip, unzipTest, zoo } from './helpers.ts';
import { readZip } from './zip-reader.ts';

const enc = new TextEncoder();
const date = new Date('2026-11-14T16:00:00Z');

function entries() {
  return [
    { path: 'a/context.json', data: enc.encode(render(gwagon(), 'json')) },
    { path: 'a/transcript.txt', data: enc.encode(render(zoo(), 'text')) },
    { path: 'a/empty.txt', data: new Uint8Array(0) },
    { path: 'a/ünïcödé ノート.txt', data: enc.encode(zoo().metadata.description ?? '') },
  ];
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('dosDateTime', () => {
  it('encodes UTC fields so time zones cannot change the bytes', () => {
    const { date: d, time: t } = dosDateTime(new Date('2026-11-14T16:00:58Z'));
    expect(d >> 9).toBe(46);
    expect((d >> 5) & 15).toBe(11);
    expect(d & 31).toBe(14);
    expect(t >> 11).toBe(16);
    expect((t >> 5) & 63).toBe(0);
    expect((t & 31) * 2).toBe(58);
    expect(dosDateTime(new Date('1970-01-01T00:00:00Z'))).toEqual({ date: 33, time: 0 });
  });
});

describe('zipToBytes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes a valid archive that round-trips, deflating only what shrinks', async () => {
    const input = entries();
    const zip = await zipToBytes(input, { date });
    const read = readZip(zip);
    expect(read.map((e) => e.path)).toEqual(input.map((e) => e.path));
    for (const [i, e] of read.entries()) expect(e.data).toEqual(input[i]?.data);
    expect(read.every((e) => (e.flags & 0x0800) !== 0)).toBe(true);
    expect(read[0]?.method).toBe(8);
    expect(read[0]?.compressedSize).toBeLessThan(read[0]?.size ?? 0);
    expect(read[2]?.method).toBe(0);
  });

  it('stores every entry when CompressionStream is missing, and the archive stays valid', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    expect(typeof CompressionStream).toBe('undefined');
    const zip = await zipToBytes(entries(), { date });
    const read = readZip(zip);
    expect(read.every((e) => e.method === 0)).toBe(true);
    expect(read.map((e) => e.data)).toEqual(entries().map((e) => e.data));
    if (hasUnzip) expect(unzipTest(zip)).toContain('No errors detected');
  });

  it("stores every entry with compression: 'store'", async () => {
    const read = readZip(await zipToBytes(entries(), { date, compression: 'store' }));
    expect(read.every((e) => e.method === 0)).toBe(true);
  });

  it('is byte-identical for the same inputs and date', async () => {
    expect(await zipToBytes(entries(), { date })).toEqual(await zipToBytes(entries(), { date }));
  });

  it('streams entries from an async iterable as they are produced', async () => {
    async function* produce() {
      for (const e of entries()) yield e;
    }
    const zip = await zipToBytes(produce(), { date });
    expect(readZip(zip)).toHaveLength(4);
  });

  it.skipIf(!hasUnzip)('passes the system unzip -t', async () => {
    expect(unzipTest(await zipToBytes(entries(), { date }))).toContain('No errors detected');
  });

  it('refuses more than 65,535 entries with too-large', () => {
    const many = Array.from({ length: 65_536 }, (_, i) => ({ path: `f${i}`, data: new Uint8Array(0) }));
    try {
      zipStream(many);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Vid2ContextError);
      expect((err as Vid2ContextError).code).toBe('too-large');
      expect((err as Vid2ContextError).hint).toMatch(/Split/);
    }
  });

  it('refuses unsafe and duplicate paths', async () => {
    await expect(zipToBytes([{ path: '../evil', data: new Uint8Array(0) }])).rejects.toMatchObject({ code: 'bad-request' });
    const dup = [
      { path: 'x', data: new Uint8Array(0) },
      { path: 'x', data: new Uint8Array(0) },
    ];
    await expect(zipToBytes(dup)).rejects.toMatchObject({ code: 'bad-request' });
  });
});
