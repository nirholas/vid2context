import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, type VideoContext } from '@vid2context/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeObsidian } from '../src/node.ts';
import { exportObsidian, type ObsidianFile, renderObsidian } from '../src/obsidian.ts';

const fixture = (name: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${name}.json`, import.meta.url), 'utf8')) as VideoContext;

const zoo = fixture('youtube-jNQXAC9IVRw');
const gwagon = fixture('youtube-cCPsdFdlshc');

let root: string;
let vault: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v2c-obsidian-'));
  vault = join(root, 'vault');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('writeObsidian', () => {
  it('writes a whole vault folder, including the index note, creating folders as needed', async () => {
    const storage = new MemoryStorage();
    const c = await storage.createCollection({ name: 'G-Wagon buyer research' });
    const collection = await storage.addToCollection(c.id, [gwagon.metadata.ref.id, zoo.metadata.ref.id]);
    const files = exportObsidian([zoo, gwagon], collection);
    const written = await writeObsidian(files, vault);
    expect(written.map((w) => w.status)).toEqual(['created', 'created', 'created']);
    for (const f of files) expect(readFileSync(join(vault, f.path), 'utf8')).toBe(f.content);
  });

  it('updates its own notes on a second export', async () => {
    const files = renderObsidian([zoo]);
    await writeObsidian(files, vault);
    const again = await writeObsidian(files, vault);
    expect(again.map((w) => w.status)).toEqual(['updated']);
  });

  it('never replaces a note with a different or missing vid2context-id unless overwrite is set, and writes nothing when refused', async () => {
    const [zooNote] = renderObsidian([zoo]);
    const [gwagonNote] = renderObsidian([gwagon]);
    if (!zooNote || !gwagonNote) throw new Error('render failed');
    mkdirSync(join(vault, 'vid2context'), { recursive: true });
    const mine = '# Me at the zoo\n\nMy own notes about this video.\n';
    writeFileSync(join(vault, zooNote.path), mine);
    await expect(writeObsidian([gwagonNote, zooNote], vault)).rejects.toMatchObject({ code: 'bad-request' });
    expect(readFileSync(join(vault, zooNote.path), 'utf8')).toBe(mine);
    expect(existsSync(join(vault, gwagonNote.path))).toBe(false);

    // A note vid2context wrote for another video under the same name is protected too.
    writeFileSync(join(vault, zooNote.path), gwagonNote.content);
    await expect(writeObsidian([zooNote], vault)).rejects.toThrow(/already exist/);

    const forced = await writeObsidian([zooNote], vault, { overwrite: true });
    expect(forced).toEqual([{ path: join(vault, zooNote.path), status: 'updated' }]);
    expect(readFileSync(join(vault, zooNote.path), 'utf8')).toBe(zooNote.content);
  });

  it.each([
    ['../escape.md'],
    ['notes/../../escape.md'],
    ['/etc/escape.md'],
    ['C:\\escape.md'],
    ['\\\\server\\share\\escape.md'],
    ['.obsidian/app.md'],
    ['notes/./x.md'],
    ['notes/x.json'],
    [''],
  ])('refuses the path %j', async (path) => {
    const [note] = renderObsidian([zoo]);
    const file: ObsidianFile = { path, content: note?.content ?? '' };
    await expect(writeObsidian([file], vault)).rejects.toMatchObject({ code: 'bad-request' });
    expect(existsSync(join(root, 'escape.md'))).toBe(false);
  });

  it('refuses to write through a symlinked folder that leads outside the vault', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(vault, { recursive: true });
    symlinkSync(outside, join(vault, 'linked'), 'dir');
    const [note] = renderObsidian([zoo], { folder: 'linked' });
    if (!note) throw new Error('render failed');
    await expect(writeObsidian([note], vault)).rejects.toThrow(/link that leaves the vault/);
    expect(existsSync(join(outside, 'Me at the zoo.md'))).toBe(false);
  });

  it('refuses to replace a symlinked note', async () => {
    const outside = join(root, 'outside.md');
    const [note] = renderObsidian([zoo]);
    if (!note) throw new Error('render failed');
    writeFileSync(outside, note.content);
    mkdirSync(join(vault, 'vid2context'), { recursive: true });
    symlinkSync(outside, join(vault, note.path));
    await expect(writeObsidian([note], vault)).rejects.toThrow(/not a plain note/);
  });

  it('refuses two files that map to the same note', async () => {
    const [note] = renderObsidian([zoo]);
    if (!note) throw new Error('render failed');
    const twin = { ...note, path: note.path.replace('Me at the zoo', 'ME AT THE ZOO') };
    await expect(writeObsidian([note, twin], vault)).rejects.toThrow(/same note/);
  });
});
