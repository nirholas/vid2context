import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { COMMANDS, flagsFor } from '../src/spec.ts';
import { cli } from './helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'v2c-completion-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

async function script(shell: string): Promise<string> {
  const res = await cli(['completion', shell]);
  expect(res.code).toBe(0);
  return res.stdout;
}

/** Run the shell's syntax check on the script. Throws with the shell's message on a syntax error. */
function syntaxCheck(shell: string, text: string): void {
  const file = join(tmp, `v2c.${shell}`);
  writeFileSync(file, text);
  execFileSync(shell, ['-n', file], { stdio: 'pipe' });
}

describe('completion', () => {
  it('bash: passes bash -n and covers every command and flag', async () => {
    const text = await script('bash');
    syntaxCheck('bash', text);
    for (const c of COMMANDS) {
      expect(text).toContain(`${c.name})`);
      for (const f of flagsFor(c)) expect(text).toContain(`--${f.name}`);
    }
  });

  it('bash: completes commands, flags and choices when sourced', async () => {
    const text = await script('bash');
    const complete = (words: string[]) =>
      execFileSync(
        'bash',
        [
          '-c',
          `source "$1"; COMP_WORDS=(${words.map((w) => `'${w}'`).join(' ')}); COMP_CWORD=${words.length - 1}; _vid2context; printf '%s\\n' "\${COMPREPLY[@]}"`,
          '_',
          join(tmp, 'v2c.bash'),
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n');
    writeFileSync(join(tmp, 'v2c.bash'), text);
    expect(complete(['vid2context', 'doc'])).toContain('doctor');
    expect(complete(['vid2context', 'get', '--for'])).toEqual(['--format', '--force']);
    expect(complete(['vid2context', 'models', '--kind', 'v'])).toEqual(['video', 'visual']);
    expect(complete(['vid2context', 'library', ''])).toEqual(['ls', 'show', 'rm']);
  });

  it.skipIf(!has('zsh'))('zsh: passes zsh -n', async () => {
    syntaxCheck('zsh', await script('zsh'));
  });

  it.skipIf(!has('fish'))('fish: passes fish -n', async () => {
    syntaxCheck('fish', await script('fish'));
  });

  it('zsh and fish scripts name every command; unknown shells are usage errors', async () => {
    const zsh = await script('zsh');
    const fish = await script('fish');
    expect(zsh.startsWith('#compdef vid2context')).toBe(true);
    for (const c of COMMANDS) {
      expect(zsh).toContain(`'${c.name}:`);
      expect(fish).toContain(`-a ${c.name} `);
    }
    expect((await cli(['completion', 'powershell'])).code).toBe(2);
  });
});
