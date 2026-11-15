/**
 * docs/cli.md must describe every command, subcommand, flag and formatter in
 * the command table, so a new flag cannot ship undocumented.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatters } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { COMMANDS, FLAGS } from '../src/spec.ts';
import { ROOT } from './helpers.ts';

const doc = readFileSync(join(ROOT, 'docs/cli.md'), 'utf8');
const commandTable = doc.slice(doc.indexOf('## Commands'), doc.indexOf('A first argument'));

describe('docs/cli.md', () => {
  it.each(COMMANDS.map((c) => c.name))('lists the %s command in the command table', (name) => {
    expect(commandTable).toMatch(new RegExp(`\`${name}\\b`));
  });

  it.each(COMMANDS.filter((c) => c.subcommands))('names every %s subcommand', (command) => {
    for (const sub of command.subcommands ?? []) expect(doc).toContain(sub.name);
  });

  it.each(Object.keys(FLAGS))('documents --%s', (flag) => {
    expect(doc).toMatch(new RegExp(`--${flag}(?![\\w-])`));
  });

  it('shows every formatter in the formats sample', () => {
    for (const id of Object.keys(formatters)) expect(doc).toMatch(new RegExp(`^${id} +\\w+ +(one|many) `, 'm'));
  });
});
