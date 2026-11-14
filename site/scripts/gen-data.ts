/**
 * Build-time data for the site. Everything the pages count or quote comes
 * from here, computed from the repo on every build: the provider registry and
 * its rungs, docs/providers.md notes, the install commands in
 * @vid2context/discovery, real outputs rendered by @vid2context/core from the
 * shared fixtures, git dates for the sitemap, and the GitHub star count.
 *
 * Run from the repo root: `npx tsx site/scripts/gen-data.ts`. Writes
 * site/src/generated/site-data.json (gitignored). Logs go to stderr.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBundle,
  createContext,
  formatters,
  formatTimestamp,
  type Provider,
  Registry,
  type Rung,
  render,
  type VideoContext,
} from '@vid2context/core';
import * as discovery from '@vid2context/discovery';
import { contextHeader } from '../../packages/mcp/src/shared.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outFile = join(root, 'site/src/generated/site-data.json');
const log = (msg: string) => console.error(`[site:data] ${msg}`);

// ------------------------------------------------------------------ registry

interface LoadedRegistry {
  registry: Registry;
  packages: string[];
  skipped: { pkg: string; error: string }[];
}

/**
 * The provider registry as @vid2context/registry builds it. When one package
 * fails to import (another change in progress), load the rest one by one so
 * the site still builds, and report the skipped ones in the build log and the
 * data file. SITE_STRICT=1 makes any skipped package fail the build.
 */
async function loadRegistry(): Promise<LoadedRegistry> {
  const generated = readFileSync(join(root, 'packages/registry/src/generated/node.ts'), 'utf8');
  const listMatch = generated.match(/providerPackages: string\[\] = (\[.*\]);/);
  if (!listMatch?.[1]) throw new Error('packages/registry/src/generated/node.ts has no providerPackages list. Run `npm run gen`.');
  const packages = JSON.parse(listMatch[1]) as string[];
  try {
    const mod = await import('@vid2context/registry/node');
    return { registry: mod.createRegistry(), packages, skipped: [] };
  } catch (err) {
    log(`the registry did not import as a whole (${(err as Error).message.split('\n')[0]}); loading packages one by one`);
  }
  const providers: Provider[] = [];
  const skipped: LoadedRegistry['skipped'] = [];
  for (const pkg of packages) {
    try {
      const mod = (await import(pkg)) as { default: Provider | Provider[] };
      providers.push(...[mod.default].flat());
    } catch (err) {
      const error = (err as Error).message.split('\n')[0] ?? String(err);
      skipped.push({ pkg, error: error.replace(root, '.') });
      log(`skipped ${pkg}: ${error.replace(root, '.')}`);
    }
  }
  if (skipped.length && process.env.SITE_STRICT === '1') {
    throw new Error(`SITE_STRICT=1 and ${skipped.length} provider package(s) failed to import.`);
  }
  return { registry: new Registry(providers, 'node'), packages, skipped };
}

// ------------------------------------------------------------------ docs/providers.md notes

/** Rung-id patterns from the tables in docs/providers.md, with their "Free limits and notes" cell. */
function providerNotes(): { pattern: RegExp; source: string; notes: string }[] {
  const text = readFileSync(join(root, 'docs/providers.md'), 'utf8');
  const rows: { pattern: RegExp; source: string; notes: string }[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*`((?:stt|llm|embed|video|visual)\/[^`]+)`\s*\|([^|]*)\|([^|]*)\|(.*)\|\s*$/);
    if (!m?.[1]) continue;
    const id = m[1];
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[^&]*?>/g, '.+');
    rows.push({ pattern: new RegExp(`^${escaped}$`), source: id, notes: (m[4] ?? '').trim() });
  }
  return rows;
}

/** Strip Markdown so a note reads as plain text in a tooltip or a small caption. */
function plain(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------ sources

/**
 * One input per platform, shaped like that platform's links (YouTube, Vimeo
 * and the podcast episode are real public media). Each is resolved through the
 * registry, offline, so the site claims a platform only when a provider
 * package understands it, and says which one. Nothing here is fetched.
 */
const PLATFORM_SAMPLES: { name: string; input: string }[] = [
  { name: 'YouTube', input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
  { name: 'Vimeo', input: 'https://vimeo.com/76979871' },
  { name: 'TikTok', input: 'https://www.tiktok.com/@nasa/video/7000000000000000000' },
  { name: 'X', input: 'https://x.com/NASA/status/1000000000000000000' },
  { name: 'Instagram', input: 'https://www.instagram.com/reel/C0000000000/' },
  { name: 'Twitch', input: 'https://www.twitch.tv/videos/1000000000' },
  { name: 'Podcasts', input: 'https://traffic.megaphone.fm/NATIONALAERONAUTICSANDSPACEADMINISTRATION1369565567.mp3' },
  { name: 'Google Drive, Dropbox and OneDrive links', input: 'https://www.dropbox.com/scl/fi/k3x9q2w7z1/talk.mp4?rlkey=r8' },
  { name: 'Local files', input: './talk.mp4' },
];

/** yt-dlp's extractor count from the binary the ytdlp provider installs, when it is present. */
function ytdlpExtractorCount(): number | null {
  const candidates = [process.env.YTDLP_PATH, join(root, '.vid2context/bin/yt-dlp')].filter((p): p is string => Boolean(p));
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    try {
      const out = execFileSync(bin, ['--list-extractors'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
      const n = out.split('\n').filter((l) => l.trim() && !l.includes('(CURRENTLY BROKEN)')).length;
      return n > 0 ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ------------------------------------------------------------------ deploy targets

interface DeployTarget {
  name: string;
  summary: string;
  /** Repo path that proves the target exists. */
  evidence: string;
  /** docs/deploy page, when one exists. */
  doc: string | null;
  command: string | null;
}

/** A deploy target is listed only when the repo has something for it at build time. */
function deployTargets(): DeployTarget[] {
  const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  const doc = (name: string) => (existsSync(join(root, `docs/deploy/${name}.md`)) ? `docs/deploy/${name}.md` : null);
  const dockerComment = existsSync(join(root, 'Dockerfile'))
    ? (readFileSync(join(root, 'Dockerfile'), 'utf8').match(/^#\s+(docker build[^\n]+)$/m)?.[1]?.trim() ?? null)
    : null;
  const candidates: (DeployTarget | null)[] = [
    existsSync(join(root, 'deploy/containers/compose.yaml'))
      ? {
          name: 'Docker',
          summary: 'Compose file for the full server (HTTP API, yt-dlp, ffmpeg), plus a small stdio MCP image at the repo root.',
          evidence: 'deploy/containers/compose.yaml',
          doc: doc('docker'),
          command:
            readFileSync(join(root, 'deploy/containers/compose.yaml'), 'utf8')
              .match(/^#\s+(docker compose [^\n]+)$/m)?.[1]
              ?.trim() ?? null,
        }
      : existsSync(join(root, 'Dockerfile'))
        ? { name: 'Docker', summary: 'A stdio MCP server image built from source.', evidence: 'Dockerfile', doc: doc('docker'), command: dockerComment }
        : null,
    existsSync(join(root, 'wrangler.jsonc'))
      ? {
          name: 'Cloudflare',
          summary: 'One Worker serves the site, the apps and the API, with Workers AI as an optional free rung.',
          evidence: 'wrangler.jsonc',
          doc: doc('cloudflare'),
          command: scripts.deploy ? 'npm run deploy' : null,
        }
      : null,
    existsSync(join(root, 'deploy/serverless/vercel')) || doc('vercel')
      ? {
          name: 'Vercel',
          summary: 'A prebuilt Build Output tree: the same layout with the API as a function.',
          evidence: existsSync(join(root, 'deploy/serverless/vercel')) ? 'deploy/serverless/vercel' : 'docs/deploy/vercel.md',
          doc: doc('vercel'),
          command: scripts['build:vercel'] ? 'npm run build:vercel' : null,
        }
      : null,
    existsSync(join(root, 'railway.json')) || existsSync(join(root, 'railway.toml')) || doc('railway')
      ? {
          name: 'Railway',
          summary: 'Deploy the server container on Railway.',
          evidence: existsSync(join(root, 'railway.json')) ? 'railway.json' : existsSync(join(root, 'railway.toml')) ? 'railway.toml' : 'docs/deploy/railway.md',
          doc: doc('railway'),
          command: null,
        }
      : null,
    existsSync(join(root, 'deploy/serverless/github-pages')) || doc('github-pages')
      ? {
          name: 'GitHub Pages',
          summary: 'A client-only build: the apps run in the browser with your own keys or local models.',
          evidence: existsSync(join(root, 'deploy/serverless/github-pages')) ? 'deploy/serverless/github-pages' : 'docs/deploy/github-pages.md',
          doc: doc('github-pages'),
          command: scripts['deploy:pages'] ? 'npm run deploy:pages' : null,
        }
      : null,
  ];
  return candidates.filter((c): c is DeployTarget => c !== null);
}

// ------------------------------------------------------------------ MCP tools

interface ToolInfo {
  name: string;
  title: string;
  description: string;
}

/** The MCP server's real tool list: start it in memory and call tools/list. Null when it does not start. */
async function mcpTools(registry: Registry): Promise<ToolInfo[] | null> {
  try {
    const { createServer } = await import('@vid2context/mcp');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const ctx = createContext({ runtime: 'node', env: {} });
    const server = createServer(registry, ctx);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'vid2context-site-build', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools
      .map((t) => ({
        name: t.name,
        title: t.title ?? t.annotations?.title ?? t.name,
        description: (t.description ?? '').split(/(?<=\.)\s/)[0] ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    log(`the MCP server did not start in memory (${(err as Error).message.split('\n')[0]}); the tool list is left out`);
    return null;
  }
}

// ------------------------------------------------------------------ playlist (replayed)

const GWAGON_PLAYLIST = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';

interface PlaylistItem {
  id: string;
  url: string;
}

/**
 * The G-Wagon playlist as the YouTube source lists it, replaying the innertube
 * responses recorded in providers/youtube/test/fixtures/browse/ (no network).
 * Null when the provider has no playlist support or the recording is missing.
 */
async function replayPlaylist(registry: Registry): Promise<{ url: string; title: string | null; items: PlaylistItem[] } | null> {
  const dir = join(root, 'providers/youtube/test/fixtures/browse');
  if (!existsSync(join(dir, 'requests.json'))) return null;
  try {
    const { replayFetch } = await import('@vid2context/core/testing');
    const { isDeepStrictEqual } = await import('node:util');
    const recorded = JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')) as {
      endpoint: string;
      body: Record<string, unknown>;
      status: number;
      file: string;
    }[];
    const fetch = replayFetch([
      {
        method: 'POST',
        url: /^https:\/\/www\.youtube\.com\/youtubei\/v1\/(browse|search|navigation\/resolve_url)\?prettyPrint=false$/,
        response: (call) => {
          const endpoint = new URL(call.url).pathname.replace('/youtubei/v1/', '');
          const { context: _context, ...body } = JSON.parse(String(call.body)) as Record<string, unknown>;
          const hit = recorded.find((r) => r.endpoint === endpoint && isDeepStrictEqual(r.body, body));
          if (!hit) throw new Error(`no recording for ${endpoint}`);
          return { status: hit.status, headers: { 'content-type': 'application/json' }, body: readFileSync(join(dir, hit.file), 'utf8') };
        },
      },
    ]);
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const ctx = createContext({ runtime: 'node', env: {}, fetch, log: silent });
    const { source, ref } = registry.resolve(GWAGON_PLAYLIST);
    if (!source.listItems) return null;
    const items: PlaylistItem[] = [];
    for await (const item of source.listItems(ref, ctx)) {
      items.push({ id: item.nativeId, url: item.url ?? `https://www.youtube.com/watch?v=${item.nativeId}` });
    }
    let title: string | null = null;
    try {
      title = (await source.getMetadata(ref, ctx)).title;
    } catch {
      title = null;
    }
    return items.length ? { url: GWAGON_PLAYLIST, title, items } : null;
  } catch (err) {
    log(`the recorded playlist did not replay (${(err as Error).message.split('\n')[0]}); the playlist page is left out`);
    return null;
  }
}

// ------------------------------------------------------------------ git

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Last commit date of a repo path (file or directory); the file's mtime when it has no commit yet. */
function lastModified(path: string): string {
  const committed = git(['log', '-1', '--format=%cI', '--', path]);
  if (committed) return new Date(committed).toISOString();
  const abs = join(root, path);
  return existsSync(abs) ? statSync(abs).mtime.toISOString() : new Date(0).toISOString();
}

function listFiles(dir: string, ext: string, recursive = false): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory() && recursive) out.push(...listFiles(rel, ext, true));
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push(rel);
  }
  return out.sort();
}

// ------------------------------------------------------------------ network

async function githubStars(): Promise<number | null> {
  if (process.env.SITE_OFFLINE === '1') return null;
  try {
    const res = await fetch('https://api.github.com/repos/nirholas/vid2context', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'vid2context-site-build' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log(`GitHub API answered ${res.status}; rendering without a star count`);
      return null;
    }
    const body = (await res.json()) as { stargazers_count?: unknown };
    return typeof body.stargazers_count === 'number' ? body.stargazers_count : null;
  } catch (err) {
    log(`GitHub API unreachable (${(err as Error).message}); rendering without a star count`);
    return null;
  }
}

/**
 * The published version of the MCP server on npm, or null. The install buttons
 * only use `npx` once a real release is there: a prerelease or a placeholder
 * without the `vid2context-mcp` bin (a name reservation) does not count.
 */
async function npmVersion(name: string, bin: string): Promise<string | null> {
  if (process.env.SITE_OFFLINE === '1') return null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown; bin?: unknown };
    if (typeof body.version !== 'string' || body.version.includes('-')) {
      log(`npm ${name}@${String(body.version)} is a prerelease; install steps use a clone`);
      return null;
    }
    const bins = typeof body.bin === 'string' ? { [name]: body.bin } : (body.bin as Record<string, unknown> | undefined);
    if (!bins || !(bin in bins)) {
      log(`npm ${name}@${body.version} has no "${bin}" bin; install steps use a clone`);
      return null;
    }
    return body.version;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ fixtures

function readContext(file: string): VideoContext {
  return JSON.parse(readFileSync(join(root, 'tests/fixtures/contexts', file), 'utf8')) as VideoContext;
}

interface WhisperVerbose {
  language: string;
  duration: number;
  segments: { start: number; end: number; text: string }[];
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const { registry, packages, skipped } = await loadRegistry();
  const notes = providerNotes();

  const providers = registry.providers.map((p) => {
    const rungs: Rung[] = 'rungs' in p && typeof p.rungs === 'function' ? (p.rungs({}) as Rung[]) : [];
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      runtimes: p.runtimes,
      catchAll: p.kind === 'source' ? Boolean(p.catchAll) : false,
      rungs: rungs.map((r) => {
        const note = notes.find((n) => n.pattern.test(r.id));
        return {
          id: r.id,
          provider: p.id,
          kind: p.kind,
          service: r.service,
          model: r.model,
          tier: r.tier,
          requires: r.requires,
          capabilities: r.capabilities,
          note: note ? plain(note.notes) : '',
        };
      }),
    };
  });

  const sources = PLATFORM_SAMPLES.flatMap(({ name, input }) => {
    try {
      const { source } = registry.resolve(input);
      return [{ name, provider: source.id, providerName: source.name, catchAll: Boolean(source.catchAll) }];
    } catch {
      return [];
    }
  });

  const zoo = readContext('youtube-jNQXAC9IVRw.json');
  const gwagon = readContext('youtube-cCPsdFdlshc.json');
  const bundle = await buildBundle([zoo], { createdAt: new Date(zoo.transcript.createdAt) });
  const decoder = new TextDecoder();
  const bundleFiles = bundle.files.map((f) => ({ path: f.path, mimeType: f.mimeType, bytes: f.bytes.length, text: decoder.decode(f.bytes) }));

  const whisper = JSON.parse(
    readFileSync(join(root, 'providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json'), 'utf8'),
  ) as WhisperVerbose;

  const gwagonText = render(gwagon, 'text', { timestamps: true }).split('\n');

  const tools = await mcpTools(registry);
  const playlist = await replayPlaylist(registry);
  const mcpVersion = await npmVersion(discovery.MCP_PACKAGE.name, discovery.MCP_PACKAGE.bin);
  const cliVersion = await npmVersion(discovery.CLI_PACKAGE.name, discovery.CLI_PACKAGE.bin);
  const stars = await githubStars();

  const docSources = [
    'README.md',
    'docs/ARCHITECTURE.md',
    'docs/providers.md',
    ...listFiles('docs/contracts', '.md'),
    ...listFiles('docs/guides', '.md'),
    ...listFiles('docs/deploy', '.md'),
  ];
  const datedPaths = [
    ...docSources,
    'llms.txt',
    'llms-full.txt',
    'site/src',
    'site/src/pages/index.astro',
    'site/src/components',
    'site/src/data',
    'site/src/content',
    ...listFiles('site/src/content', '.md', true),
    'tests/fixtures/contexts',
    'packages/discovery/src',
  ];
  const gitDates = Object.fromEntries(datedPaths.map((p) => [p, lastModified(p)]));

  const data = {
    head: git(['rev-parse', '--short', 'HEAD']),
    stars,
    npm: {
      mcpPackage: discovery.MCP_PACKAGE.name,
      cliPackage: discovery.CLI_PACKAGE.name,
      published: mcpVersion !== null,
      version: mcpVersion,
      cliPublished: cliVersion !== null,
      cliVersion,
      url: `https://www.npmjs.com/package/${discovery.MCP_PACKAGE.name}`,
    },
    meta: {
      siteUrl: discovery.SITE_URL,
      repoUrl: discovery.REPO_URL,
      license: discovery.LICENSE,
      title: discovery.TITLE,
      description: discovery.DESCRIPTION,
      shortDescription: discovery.SHORT_DESCRIPTION,
      keywords: discovery.KEYWORDS,
      softwareVersion: discovery.MCP_PACKAGE.version,
      registryName: discovery.MCP_REGISTRY_NAME,
      envVars: discovery.ENV_VARS,
    },
    install: {
      mcpCommandLine: `${discovery.MCP_COMMAND.command} ${discovery.MCP_COMMAND.args.join(' ')}`,
      claudeCode: discovery.claudeCodeCommand,
      claudeCodeWithKey: discovery.claudeCodeCommandWithKey,
      codex: discovery.codexCommand,
      gemini: discovery.geminiCommand,
      mcpServersJson: discovery.mcpServersJson(),
      mcpServersJsonWithEnv: discovery.mcpServersJson(true),
      vscodeMcpJson: discovery.vscodeMcpJson(),
      vscodeInstallUrl: discovery.vscodeInstallUrl(),
      vscodeInsidersInstallUrl: discovery.vscodeInstallUrl(true),
      vscodeDeeplink: discovery.vscodeDeeplink(),
      cursorInstallUrl: discovery.cursorInstallUrl(),
      cursorDeeplink: discovery.cursorDeeplink(),
      lmStudioDeeplink: discovery.lmStudioDeeplink(),
      gooseDeeplink: discovery.gooseDeeplink(discovery.SHORT_DESCRIPTION),
      envVarsMarkdown: discovery.envVarsMarkdown(),
    },
    registry: { packages, skipped },
    providers,
    sources,
    ytdlpExtractors: ytdlpExtractorCount(),
    deployTargets: deployTargets(),
    mcpTools: tools,
    playlist,
    formatters: Object.values(formatters).map((f) => ({ id: f.id, description: f.description, extension: f.extension })),
    demo: {
      fixture: 'tests/fixtures/contexts/youtube-jNQXAC9IVRw.json',
      title: zoo.metadata.title,
      channel: zoo.metadata.channel?.name ?? '',
      url: zoo.metadata.ref.url ?? '',
      durationSec: zoo.metadata.durationSec ?? 0,
      origin: zoo.transcript.origin,
      producer: zoo.transcript.producer,
      attempts: zoo.attempts,
      zipName: bundle.filename,
      zipBytes: (await new Response(bundle.zip()).arrayBuffer()).byteLength,
      files: bundleFiles,
      text: render(zoo, 'text', { timestamps: true }),
      markdown: render(zoo, 'markdown', {}),
      srt: render(zoo, 'srt', {}),
      mcpTranscript: contextHeader(zoo) + render(zoo, 'text', { timestamps: true }),
      metadataJson: `${JSON.stringify(
        {
          title: zoo.metadata.title,
          channel: zoo.metadata.channel?.name,
          description: zoo.metadata.description,
          durationSec: zoo.metadata.durationSec,
          chapters: zoo.metadata.chapters,
          tags: zoo.metadata.tags,
          language: zoo.metadata.language,
        },
        null,
        2,
      )}\n`,
    },
    gwagon: {
      fixture: 'tests/fixtures/contexts/youtube-cCPsdFdlshc.json',
      title: gwagon.metadata.title,
      channel: gwagon.metadata.channel?.name ?? '',
      url: gwagon.metadata.ref.url ?? '',
      duration: formatTimestamp(gwagon.metadata.durationSec ?? 0),
      segments: gwagon.transcript.segments.length,
      origin: gwagon.transcript.origin,
      header: contextHeader(gwagon).trim(),
      textExcerpt: `${gwagonText.slice(0, 12).join('\n')}\n`,
      packExcerpt: `${render(gwagon, 'pack', {}).split('\n').slice(0, 24).join('\n')}\n`,
    },
    whisper: {
      fixture: 'providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json',
      media: 'tests/fixtures/media/apollo11-small-step.mp3',
      language: whisper.language,
      durationSec: whisper.duration,
      text: `${whisper.segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text.trim()}`).join('\n')}\n`,
    },
    docSources,
    gitDates,
  };

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(data, null, 2)}\n`);
  const rungCount = providers.reduce((n, p) => n + p.rungs.length, 0);
  log(
    `wrote ${relative(root, outFile)}: ${providers.length} providers, ${rungCount} rungs, ${sources.length} sources, ` +
      `${docSources.length} docs, stars ${stars ?? 'unknown'}, npm ${mcpVersion ?? 'not published'}` +
      (skipped.length ? `, ${skipped.length} package(s) skipped` : ''),
  );
}

main().catch((err) => {
  console.error(`[site:data] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
