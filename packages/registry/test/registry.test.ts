import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { providerPackages as browserPackages, createRegistry as createBrowserRegistry } from '../src/browser.ts';
import { createRegistry, loadEnvFiles, providerPackages as nodePackages } from '../src/node.ts';
import { createRegistry as createWorkersRegistry, providerPackages as workersPackages } from '../src/workers.ts';

describe('generated registries', () => {
  it('include node-only providers in the node registry only', () => {
    expect(nodePackages).toContain('@vid2context/provider-media-file');
    expect(workersPackages).not.toContain('@vid2context/provider-media-file');
    expect(browserPackages).not.toContain('@vid2context/provider-media-file');
    expect(
      createRegistry()
        .sources()
        .map((s) => s.id),
    ).toContain('media-file');
    expect(
      createWorkersRegistry()
        .sources()
        .map((s) => s.id),
    ).not.toContain('media-file');
    expect(
      createBrowserRegistry()
        .sources()
        .map((s) => s.id),
    ).toContain('youtube');
  });

  it('resolve YouTube inputs before anything else claims them', () => {
    expect(createRegistry().resolve('https://youtu.be/jNQXAC9IVRw').source.id).toBe('youtube');
  });

  it('give long audio the ffmpeg splitter on Node only (X audio is m4a, which the built-in splitters cannot cut)', () => {
    expect(createRegistry().splitters.map((s) => s.id)).toEqual(['ffmpeg-silence']);
    expect(createWorkersRegistry().splitters).toEqual([]);
    expect(createBrowserRegistry().splitters).toEqual([]);
  });
});

describe('loadEnvFiles', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('loads VID2CONTEXT_ENV_FILE and ./.env without overriding the shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2c-env-'));
    writeFileSync(join(dir, '.env'), 'V2C_TEST_A=from-dotenv\nV2C_TEST_B=from-dotenv\n');
    writeFileSync(join(dir, 'keys.env'), 'V2C_TEST_C=from-explicit\n');
    process.env.VID2CONTEXT_ENV_FILE = join(dir, 'keys.env');
    process.env.V2C_TEST_A = 'from-shell';
    expect(loadEnvFiles(dir)).toEqual([join(dir, 'keys.env'), join(dir, '.env')]);
    expect([process.env.V2C_TEST_A, process.env.V2C_TEST_B, process.env.V2C_TEST_C]).toEqual([
      'from-shell',
      'from-dotenv',
      'from-explicit',
    ]);
  });
});
