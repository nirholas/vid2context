#!/usr/bin/env node
/**
 * Smoke-tests the built npm bundles the way a user runs them:
 *   vid2context --help          prints usage and exits 0
 *   vid2context-mcp             answers a JSON-RPC `initialize` over stdio
 *
 *   node tooling/release/smoke.mjs [--out <bundles dir>]
 *
 * Runs plain `node` on each package's `bin` file, with no workspace on the
 * module path, so a missing bundled import fails here instead of on npx.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? join(ROOT, 'packages/discovery/dist/npm') : resolve(process.argv[outIndex + 1]);

/** Absolute path of the bin a package installs, from its generated package.json. */
export function binOf(name, out = OUT) {
  const dir = join(out, name);
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`${name}: no bundle at ${dir}; run npm run build:npm`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
  if (!rel) throw new Error(`${name}: package.json has no bin "${name}"`);
  const file = join(dir, rel);
  if (!existsSync(file)) throw new Error(`${name}: bin ${rel} is missing from the bundle`);
  if (!readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node')) throw new Error(`${name}: bin ${rel} has no node shebang`);
  return file;
}

// An empty working directory, so no .env or workspace file can leak in.
const sandbox = () => mkdtempSync(join(tmpdir(), 'v2c-smoke-'));

export function cliHelp(out = OUT) {
  const res = spawnSync(process.execPath, [binOf('vid2context', out), '--help'], {
    cwd: sandbox(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.status !== 0) throw new Error(`vid2context --help exited ${res.status}: ${res.stderr.slice(0, 500)}`);
  const text = `${res.stdout}${res.stderr}`;
  if (!/usage/i.test(text)) throw new Error(`vid2context --help printed no usage: ${text.slice(0, 300)}`);
  return text;
}

/** Starts the MCP bundle, sends `initialize`, resolves with the parsed response. */
export function mcpInitialize(out = OUT, timeoutMs = 30_000) {
  const child = spawn(process.execPath, [binOf('vid2context-mcp', out)], {
    cwd: sandbox(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    const finish = (err, value) => {
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolvePromise(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`no initialize response in ${timeoutMs} ms; stderr: ${stderr.slice(0, 500)}`)),
      timeoutMs,
    );
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.stdout.on('data', (d) => {
      stdout += d;
      for (const line of stdout.split('\n').slice(0, -1)) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return finish(new Error(`MCP stdout carried a non-JSON line (stdout must be protocol only): ${line.slice(0, 200)}`));
        }
        if (msg.id === 1) {
          if (msg.error) return finish(new Error(`initialize failed: ${JSON.stringify(msg.error)}`));
          return finish(null, msg);
        }
      }
    });
    child.on('exit', (code) => finish(new Error(`MCP server exited (${code}) before answering; stderr: ${stderr.slice(0, 500)}`)));
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vid2context-smoke', version: '1.0.0' } },
      })}\n`,
    );
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cliHelp();
    console.error('smoke: vid2context --help ok');
    const res = await mcpInitialize();
    const info = res.result?.serverInfo;
    console.error(`smoke: vid2context-mcp initialize ok (${info?.name} ${info?.version}, protocol ${res.result?.protocolVersion})`);
  } catch (err) {
    console.error(`smoke: ${err.message}`);
    process.exitCode = 1;
  }
}
