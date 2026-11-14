import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTION_PATHS, buildActionSchema, run } from '../src/action.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Op = { operationId: string; summary: string; description: string; parameters: { name: string }[] };

describe('GPT Action schema', () => {
  const schema = buildActionSchema('https://v2c.example.org/') as {
    openapi: string;
    servers: { url: string }[];
    security: unknown[];
    components: { securitySchemes: Record<string, unknown> };
    paths: Record<string, { get: Op }>;
  };

  it('is OpenAPI 3.1 with the given server and Bearer auth', () => {
    expect(schema.openapi).toBe('3.1.0');
    expect(schema.servers).toEqual([{ url: 'https://v2c.example.org' }]);
    expect(schema.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
    expect(schema.security).toEqual([{ bearerAuth: [] }]);
  });

  it('covers the read routes, each in the HTTP API contract', () => {
    expect(Object.keys(schema.paths)).toEqual(ACTION_PATHS);
    const contract = readFileSync(join(REPO, 'docs', 'contracts', 'http-api.md'), 'utf8');
    // Implemented routes are written with the /api/v1 prefix in the contract, planned ones without.
    for (const path of ACTION_PATHS) {
      const listed = contract.includes(`GET ${path}?`) || contract.includes(`GET ${path.replace('/api/v1', '')}?`);
      expect(listed, path).toBe(true);
    }
  });

  it('gives every operation a unique id and descriptions within the GPT editor limit', () => {
    const ops = Object.values(schema.paths).map((p) => p.get);
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
    for (const op of ops) {
      expect(op.description.length).toBeLessThanOrEqual(300);
      expect(op.summary).toMatch(/\((implemented|planned route)\)$/);
    }
  });

  it('refuses http, non-URLs and an /api/v1 base with a hint', () => {
    expect(() => buildActionSchema('http://localhost:8787')).toThrow(/https/);
    expect(() => buildActionSchema('your-host')).toThrow(/Not a URL/);
    expect(() => buildActionSchema('https://h.example.org/api/v1')).toThrow(/server root/);
  });

  it('writes the file to --out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2c-action-'));
    try {
      const out = run(['--server', 'https://v2c.example.org', '--out', join(dir, 'a.json')]);
      expect(JSON.parse(readFileSync(out, 'utf8')).servers).toEqual([{ url: 'https://v2c.example.org' }]);
      expect(() => run([])).toThrow(/--server/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
