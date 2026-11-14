#!/usr/bin/env node
/**
 * npm run deploy:pages -- [options]
 *
 * Builds the client-only static bundle (site, /app/, /chat/ with
 * VITE_CLIENT_ONLY=1) and commits it to the gh-pages branch from a temporary
 * git worktree. GitHub Actions is unavailable on this account, so this script
 * is the publishing path. It never pushes unless you pass --push.
 *
 * Options:
 *   --api-base <url>    VITE_API_BASE for the apps (default '': pure client-only)
 *   --cname <domain>    write a CNAME file and serve from the domain root
 *   --base-path <path>  URL prefix (default '/' with --cname, else '/<repo>/' for project pages)
 *   --branch <name>     target branch (default gh-pages)
 *   --remote <name>     remote to push to (default origin)
 *   --dry-run           do everything in a throwaway clone; the real repo is not touched
 *   --push              push the branch after committing (never with --dry-run)
 *   --no-build          reuse existing dist/ output of the apps instead of building
 *   --strict            fail if an app is present but does not build
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildAssets, normalizeBasePath } from '../lib/assets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const ALLOWED_EMAILS = ['22895867+nirholas@users.noreply.github.com', 'nirholas@users.noreply.github.com'];

function git(cwd, args, { lock = false, allowFail = false } = {}) {
  const lockFile = join(root, '.vid2context/locks/git');
  const useLock = lock && existsSync(dirname(lockFile));
  const [cmd, argv] = useLock ? ['flock', [lockFile, 'git', ...args]] : ['git', args];
  const res = spawnSync(cmd, argv, { cwd, encoding: 'utf8' });
  if (res.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  return { ok: res.status === 0, out: (res.stdout ?? '').trim() };
}

function repoName() {
  const url = git(root, ['remote', 'get-url', 'origin'], { allowFail: true }).out;
  const m = /([^/:]+?)(?:\.git)?$/.exec(url);
  return m?.[1] ?? basename(root);
}

/**
 * Build and commit. Returns where the commit was made.
 * @param {object} o
 */
export function publishPages(o = {}) {
  const log = o.log ?? ((m) => console.error(m));
  const branch = o.branch ?? 'gh-pages';
  const remote = o.remote ?? 'origin';
  const basePath = normalizeBasePath(o.basePath ?? (o.cname ? '/' : `/${repoName()}/`));
  if (o.push && o.dryRun) throw new Error('--push cannot be combined with --dry-run.');

  const out = join(root, 'dist/pages');
  const assets = buildAssets({
    root,
    out,
    build: o.build ?? true,
    strict: o.strict ?? false,
    clientOnly: true,
    apiBase: o.apiBase ?? '',
    basePath,
    log,
  });
  writeFileSync(join(out, '.nojekyll'), '');
  if (o.cname) writeFileSync(join(out, 'CNAME'), `${o.cname.trim()}\n`);
  log(`[pages] built ${assets.files} files for base path ${basePath}`);

  // Where the commit happens: a throwaway clone for --dry-run, else this repo.
  const work = mkdtempSync(join(tmpdir(), 'v2c-pages-'));
  let repo = root;
  if (o.dryRun) {
    repo = join(work, 'clone');
    git(work, ['clone', '--quiet', '--no-checkout', root, repo]);
    log(`[pages] dry run: committing in a throwaway clone at ${repo}`);
  }
  const email = git(repo, ['config', 'user.email'], { allowFail: true }).out;
  const name = git(repo, ['config', 'user.name'], { allowFail: true }).out;
  if (name !== 'nirholas' || !ALLOWED_EMAILS.includes(email)) {
    throw new Error(`git identity is "${name} <${email}>"; AGENTS.md allows only nirholas with a noreply address. Not committing.`);
  }

  const wt = join(work, 'worktree');
  const lock = !o.dryRun;
  const localBranch = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).ok;
  const remoteHasBranch =
    !o.dryRun && git(repo, ['ls-remote', '--exit-code', '--heads', remote, branch], { allowFail: true }).ok;
  if (localBranch) {
    git(repo, ['worktree', 'add', '--quiet', wt, branch], { lock });
  } else if (remoteHasBranch) {
    git(repo, ['fetch', '--quiet', remote, `${branch}:${branch}`], { lock });
    git(repo, ['worktree', 'add', '--quiet', wt, branch], { lock });
  } else {
    git(repo, ['worktree', 'add', '--quiet', '--orphan', '-b', branch, wt], { lock });
  }

  try {
    // Replace the branch contents with the new build (the worktree holds only this branch's files).
    for (const entry of readdirSync(wt)) if (entry !== '.git') rmSync(join(wt, entry), { recursive: true, force: true });
    cpSync(out, wt, { recursive: true });
    git(wt, ['add', '--all', '--', '.']);
    const changed = !git(wt, ['diff', '--cached', '--quiet'], { allowFail: true }).ok;
    const source = git(root, ['rev-parse', '--short', 'HEAD']).out;
    let commit = git(wt, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }).out;
    if (changed) {
      git(wt, [
        'commit',
        '--quiet',
        '-m',
        `chore(pages): publish the client-only build of ${source}`,
        '-m',
        `Site, apps and llms.txt built with VITE_CLIENT_ONLY=1 for base path ${basePath} by deploy/serverless/github-pages/publish.mjs.`,
        '-m',
        TRAILER,
      ]);
      commit = git(wt, ['rev-parse', 'HEAD']).out;
      log(`[pages] committed ${commit.slice(0, 7)} on ${branch}`);
    } else {
      log(`[pages] ${branch} already matches this build; nothing to commit`);
    }
    if (o.push) {
      git(repo, ['push', remote, branch], { lock });
      log(`[pages] pushed ${branch} to ${remote}`);
    } else {
      log(`[pages] not pushed (pass --push to publish)`);
    }
    return { repo, branch, commit, changed, out, basePath, parts: assets.parts, work };
  } finally {
    git(repo, ['worktree', 'remove', '--force', wt], { lock, allowFail: true });
    if (!o.keep) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'api-base': { type: 'string' },
      cname: { type: 'string' },
      'base-path': { type: 'string' },
      branch: { type: 'string' },
      remote: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      push: { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
    },
  });
  try {
    publishPages({
      apiBase: values['api-base'],
      cname: values.cname,
      basePath: values['base-path'],
      branch: values.branch,
      remote: values.remote,
      dryRun: values['dry-run'],
      push: values.push,
      build: !values['no-build'],
      strict: values.strict,
    });
  } catch (err) {
    console.error(`[pages] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
