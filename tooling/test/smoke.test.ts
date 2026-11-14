import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../checks/lib.mjs';
import { cliHelp, mcpInitialize } from '../release/smoke.mjs';

// Runs against the bundles `npm run build:npm` wrote. `npm run ci` builds
// them first and also runs this smoke test as its own step after the build.
const OUT = join(ROOT, 'packages/discovery/dist/npm');
const built = existsSync(join(OUT, 'vid2context/package.json')) && existsSync(join(OUT, 'vid2context-mcp/package.json'));

describe.skipIf(!built)('npm bundles (built by npm run build:npm)', () => {
  it('vid2context --help prints usage', () => {
    expect(cliHelp(OUT)).toMatch(/usage/i);
  });

  it('vid2context-mcp answers initialize over stdio', async () => {
    const res = await mcpInitialize(OUT);
    expect(res.jsonrpc).toBe('2.0');
    expect(res.result.serverInfo.name).toBeTruthy();
    expect(res.result.capabilities).toBeTypeOf('object');
  });
});
