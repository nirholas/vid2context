/**
 * npm run discovery:gen   writes the root manifests (server.json, glama.json, ...)
 * npm run build:npm       bundles the publishable npm packages into packages/discovery/dist/npm/
 * npm run discovery:logo  renders assets/logo.png (400x400) from assets/logo.svg
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootFiles } from './manifests.ts';
import { buildAll, ROOT } from './npm.ts';

const command = process.argv[2];

if (command === 'gen') {
  const files = Object.entries(rootFiles());
  for (const [path, content] of files) writeFileSync(join(ROOT, path), content);
  // Biome owns JSON formatting in this repo; format so `npm run lint` stays clean.
  const json = files.map(([p]) => p).filter((p) => p.endsWith('.json'));
  execFileSync(join(ROOT, 'node_modules/.bin/biome'), ['format', '--write', ...json], { cwd: ROOT, stdio: 'inherit' });
  console.error(`wrote ${files.map(([p]) => p).join(', ')}`);
} else if (command === 'build') {
  for (const dir of await buildAll()) console.error(`built ${dir}`);
  console.error('publish each with: npm publish --access public <dir>');
} else if (command === 'logo') {
  const { default: sharp } = await import('sharp');
  const dir = join(ROOT, 'packages/discovery/assets');
  await sharp(join(dir, 'logo.svg'), { density: 900 }).resize(400, 400).png().toFile(join(dir, 'logo.png'));
  console.error('wrote packages/discovery/assets/logo.png');
} else {
  console.error('usage: tsx packages/discovery/src/cli.ts gen | build | logo');
  process.exitCode = 2;
}
