#!/usr/bin/env node
/**
 * Bump the release version and cut the changelog, in one step.
 *
 *   node tooling/release/version.mjs patch|minor|major|<x.y.z> [--date YYYY-MM-DD] [--root <dir>]
 *
 * The published packages take their versions from packages/cli and
 * packages/mcp (see packages/discovery/src/meta.ts), and the root
 * package.json carries the same number, so all three move together. Only the
 * `"version"` line of each manifest changes; formatting is left alone.
 *
 * CHANGELOG.md (Keep a Changelog): the `## [Unreleased]` notes become
 * `## [x.y.z] - date`, a fresh empty Unreleased section goes on top, and the
 * link references at the bottom are updated. Refuses when there are no
 * unreleased notes, so every release says what changed.
 *
 * It does not commit, tag or publish; it prints the commands for that.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFESTS = ['package.json', 'packages/cli/package.json', 'packages/mcp/package.json'];
const REPO = 'https://github.com/nirholas/vid2context';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current, bump) {
  const m = current.match(SEMVER);
  if (!m) throw new Error(`current version ${current} is not x.y.z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  const t = bump.match(SEMVER);
  if (!t) throw new Error(`expected patch, minor, major or x.y.z, got ${bump}`);
  const cmp = t.slice(1).map(Number);
  const cur = [major, minor, patch];
  const newer = cmp[0] !== cur[0] ? cmp[0] > cur[0] : cmp[1] !== cur[1] ? cmp[1] > cur[1] : cmp[2] > cur[2];
  if (!newer) throw new Error(`${bump} is not newer than ${current}`);
  return bump;
}

/** Replaces only the top-level "version" value, keeping the file's formatting. */
export function setVersion(json, version) {
  const re = /^(\s{2}"version":\s*")([^"]+)(")/m;
  if (!re.test(json)) throw new Error('no top-level "version" field');
  return json.replace(re, `$1${version}$3`);
}

/** Moves the Unreleased notes under a new version heading and fixes the link references. */
export function cutChangelog(text, { version, previous, date }) {
  const head = /^## \[Unreleased\][^\n]*\n/m;
  const start = text.search(head);
  if (start === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  const bodyStart = start + text.slice(start).match(head)[0].length;
  const rest = text.slice(bodyStart);
  const nextHeading = rest.search(/^## \[|^\[[^\]]+\]:\s/m);
  const notes = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  if (!notes) throw new Error('the Unreleased section is empty: add notes for this release first');

  const after = nextHeading === -1 ? '' : rest.slice(nextHeading);
  let out = `${text.slice(0, start)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${notes}\n\n${after}`;

  const unreleasedLink = `[Unreleased]: ${REPO}/compare/v${version}...HEAD`;
  const versionLink = previous
    ? `[${version}]: ${REPO}/compare/v${previous}...v${version}`
    : `[${version}]: ${REPO}/releases/tag/v${version}`;
  if (/^\[Unreleased\]:.*$/m.test(out)) out = out.replace(/^\[Unreleased\]:.*$/m, `${unreleasedLink}\n${versionLink}`);
  else out = `${out.trimEnd()}\n\n${unreleasedLink}\n${versionLink}\n`;
  return `${out.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** True when CHANGELOG.md already has a released section, so a compare link has a base. */
function hasRelease(changelog, version) {
  return new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog);
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return null;
    const [, v] = args.splice(i, 2);
    if (!v) throw new Error(`${flag} needs a value`);
    return v;
  };
  const root = resolve(take('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  const date = take('--date') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
  const [bump] = args;
  if (!bump || args.length !== 1) throw new Error('usage: version.mjs patch|minor|major|<x.y.z> [--date YYYY-MM-DD]');

  const files = MANIFESTS.map((p) => ({ path: p, text: readFileSync(join(root, p), 'utf8') }));
  const versions = new Set(files.map((f) => JSON.parse(f.text).version));
  if (versions.size !== 1) {
    throw new Error(
      `versions differ (${files.map((f) => `${f.path}: ${JSON.parse(f.text).version}`).join(', ')}); align them first`,
    );
  }
  const [current] = versions;
  const version = nextVersion(current, bump);

  const changelogPath = join(root, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  const cut = cutChangelog(changelog, { version, previous: hasRelease(changelog, current) ? current : null, date });

  // Everything is computed before anything is written, so a refusal changes nothing.
  for (const f of files) writeFileSync(join(root, f.path), setVersion(f.text, version));
  writeFileSync(changelogPath, cut);
  console.error(`version: ${current} -> ${version}`);
  console.error('next steps:');
  console.error('  npm install                      # sync package-lock.json');
  console.error('  npm run ci && npm run release:dry');
  console.error(
    `  git commit -m "chore(release): v${version}" -- ${[...MANIFESTS, 'package-lock.json', 'CHANGELOG.md'].join(' ')}`,
  );
  console.error(`  git tag -a v${version} -m "v${version}" && git push origin main v${version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`version: ${err.message}`);
    process.exitCode = 1;
  }
}
