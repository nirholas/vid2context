/**
 * Invariant helpers against real provider packages in this repo: export
 * condition resolution, import reachability and the model override env.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { overrideEnv, reachableFiles, repoRoot, runtimeEntry, scanPortable, stripComments } from '../src/index.ts';

const pkg = (name: string) => join(repoRoot, 'providers', name);

describe('runtimeEntry', () => {
  it('follows package.json export conditions per runtime', () => {
    expect(runtimeEntry(pkg('stt-transformers'), 'browser')).toBe(join(pkg('stt-transformers'), 'src/browser.ts'));
    expect(runtimeEntry(pkg('stt-transformers'), 'node')).toBe(join(pkg('stt-transformers'), 'src/node.ts'));
    expect(runtimeEntry(pkg('visual-frames'), 'workers')).toBe(join(pkg('visual-frames'), 'src/edge.ts'));
    expect(runtimeEntry(pkg('visual-frames'), 'node')).toBe(join(pkg('visual-frames'), 'src/node-provider.ts'));
    expect(runtimeEntry(pkg('youtube'), 'workers')).toBe(join(pkg('youtube'), 'src/index.ts'));
  });
});

describe('reachableFiles and scanPortable', () => {
  it('keeps a node-only entry out of the browser build and still sees it from node', () => {
    const browser = reachableFiles(runtimeEntry(pkg('stt-transformers'), 'browser') ?? '');
    expect(browser).not.toContain(join(pkg('stt-transformers'), 'src/node.ts'));
    expect(browser).toContain(join(pkg('stt-transformers'), 'src/index.ts'));
    const hits = scanPortable(pkg('stt-transformers'), repoRoot, 'browser');
    expect(hits.some((h) => h.file.endsWith('src/node.ts'))).toBe(true);
    expect(hits.filter((h) => h.reachable)).toEqual([]);
  });

  it('marks every hit reachable when no runtime is given', () => {
    expect(scanPortable(pkg('stt-transformers')).every((h) => h.reachable)).toBe(true);
  });

  it('ignores imports and fetch calls that only appear in comments', () => {
    expect(stripComments("// import x from 'node:fs'\nconst a = 1; /* fetch(url) */")).not.toMatch(/node:fs|fetch\(/);
    expect(stripComments("const s = '// not a comment';")).toContain('// not a comment');
  });
});

describe('overrideEnv', () => {
  it('sets documented base URL variables that share the model variable prefix', () => {
    const env = overrideEnv('LOCAL_LLM_MODEL', 'm', ['LOCAL_LLM_BASE_URL', 'LOCAL_LLM_API_KEY', 'OLLAMA_BASE_URL']);
    expect(env.LOCAL_LLM_MODEL).toBe('m');
    expect(env.LOCAL_LLM_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(env.LOCAL_LLM_API_KEY).toBeUndefined();
    expect(env.OLLAMA_BASE_URL).toBeUndefined();
  });
});
