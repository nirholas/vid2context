import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import type { EvalResult } from '../src/results.ts';
import { main } from '../src/run.ts';

describe.skipIf(!process.env.LIVE)('eval runner, live', () => {
  it(
    'scores the first stt.json video with the keyless OVH rung and writes JSON and Markdown',
    async () => {
      const { createNodeContext, createRegistry, loadEnvFiles } = await import('@vid2context/registry/node');
      const out = mkdtempSync(join(tmpdir(), 'vid2context-evals-'));
      const stdout: string[] = [];
      const code = await main(['--suite', 'stt', '--limit', '1', '--rungs', 'stt/ovh/whisper-large-v3-turbo', '--out', out], {
        env: process.env as Env,
        setup: async () => ({
          envFiles: loadEnvFiles().length,
          registry: createRegistry(),
          ctx: createNodeContext({ env: process.env as Env }),
        }),
        stdout: (s) => stdout.push(s),
        stderr: (s) => process.stderr.write(s),
      });
      expect(code).toBe(0);
      const date = new Date().toISOString().slice(0, 10);
      const json = join(out, `${date}-stt.json`);
      expect(existsSync(json)).toBe(true);
      expect(existsSync(join(out, `${date}-stt.md`))).toBe(true);
      const result = JSON.parse(readFileSync(json, 'utf8')) as EvalResult;
      expect(result.environment.rungs).toEqual(['stt/ovh/whisper-large-v3-turbo']);
      const item = result.items.find((i) => i.rung === 'stt/ovh/whisper-large-v3-turbo');
      expect(item?.outcome, JSON.stringify(result.items.map((i) => [i.rung, i.reason, i.detail]))).toBe('ok');
      expect(item?.wer?.refLength).toBeGreaterThan(50);
      expect(stdout.join('')).toMatch(/## Summary/);
    },
    20 * 60_000,
  );
});
