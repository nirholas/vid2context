/**
 * Typed access to src/generated/site-data.json, which scripts/gen-data.ts
 * writes from the repo on every build. Pages read numbers only from here.
 */
import raw from '../generated/site-data.json';

export type Tier = 'local' | 'free' | 'keyless' | 'paid';
export const TIERS: Tier[] = ['local', 'free', 'keyless', 'paid'];

export interface RungInfo {
  id: string;
  provider: string;
  kind: string;
  service: string;
  model: string;
  tier: Tier;
  requires: string[];
  capabilities: string[];
  note: string;
}

export interface ProviderInfo {
  id: string;
  kind: string;
  name: string;
  runtimes: string[];
  catchAll: boolean;
  rungs: RungInfo[];
}

export interface BundleFileInfo {
  path: string;
  mimeType: string;
  bytes: number;
  text: string;
}

export interface Attempt {
  stage: string;
  id: string;
  outcome: string;
  reason?: string;
  detail?: string;
  ms?: number;
}

interface SiteData {
  head: string;
  stars: number | null;
  npm: { mcpPackage: string; cliPackage: string; published: boolean; version: string | null; url: string };
  meta: {
    siteUrl: string;
    repoUrl: string;
    license: string;
    title: string;
    description: string;
    shortDescription: string;
    keywords: string[];
    softwareVersion: string;
    registryName: string;
    envVars: { name: string; label: string; description: string; secret: boolean }[];
  };
  install: Record<
    | 'mcpCommandLine'
    | 'claudeCode'
    | 'claudeCodeWithKey'
    | 'codex'
    | 'gemini'
    | 'mcpServersJson'
    | 'mcpServersJsonWithEnv'
    | 'vscodeMcpJson'
    | 'vscodeInstallUrl'
    | 'vscodeInsidersInstallUrl'
    | 'vscodeDeeplink'
    | 'cursorInstallUrl'
    | 'cursorDeeplink'
    | 'lmStudioDeeplink'
    | 'gooseDeeplink'
    | 'envVarsMarkdown',
    string
  >;
  registry: { packages: string[]; skipped: { pkg: string; error: string }[] };
  providers: ProviderInfo[];
  sources: { name: string; provider: string; providerName: string; catchAll: boolean }[];
  ytdlpExtractors: number | null;
  mcpTools: { name: string; title: string; description: string }[] | null;
  deployTargets: { name: string; summary: string; evidence: string; doc: string | null; command: string | null }[];
  formatters: { id: string; description: string; extension: string }[];
  demo: {
    fixture: string;
    title: string;
    channel: string;
    url: string;
    durationSec: number;
    origin: string;
    producer: string;
    attempts: Attempt[];
    zipName: string;
    zipBytes: number;
    files: BundleFileInfo[];
    text: string;
    markdown: string;
    srt: string;
    mcpTranscript: string;
    metadataJson: string;
  };
  gwagon: {
    fixture: string;
    title: string;
    channel: string;
    url: string;
    duration: string;
    segments: number;
    origin: string;
    header: string;
    textExcerpt: string;
    packExcerpt: string;
  };
  whisper: { fixture: string; media: string; language: string; durationSec: number; text: string };
  docSources: string[];
  gitDates: Record<string, string>;
}

export const data = raw as unknown as SiteData;
export const SITE_URL = data.meta.siteUrl;
export const REPO_URL = data.meta.repoUrl;

/**
 * Every rung once. Two provider packages can list the same rung while one is
 * being split out of the other; the chain keys rungs by id, so the site does too.
 */
export function allRungs(): RungInfo[] {
  const seen = new Map<string, RungInfo>();
  for (const p of data.providers) for (const r of p.rungs) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

export function rungsByTier(): Record<Tier, RungInfo[]> {
  const out: Record<Tier, RungInfo[]> = { local: [], free: [], keyless: [], paid: [] };
  for (const r of allRungs()) out[r.tier]?.push(r);
  return out;
}

export const KIND_LABEL: Record<string, string> = {
  stt: 'Speech-to-text',
  llm: 'LLM',
  embed: 'Embeddings',
  video: 'Video model',
  visual: 'Vision',
};

export const TIER_INFO: Record<Tier, { label: string; meaning: string }> = {
  local: { label: 'Local', meaning: 'Runs on your machine. Free, private, nothing leaves it.' },
  free: { label: 'Free tier', meaning: 'Hosted free tiers that use your own key.' },
  keyless: { label: 'Keyless', meaning: 'Hosted and free with no account at all.' },
  paid: { label: 'Paid', meaning: 'Last backstop, used only when you set its key.' },
};

/** Distinct upstream services that have at least one rung. */
export function serviceCount(): number {
  return new Set(allRungs().map((r) => r.service.replace(/#\d+$/, ''))).size;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** Last commit date among repo paths, for sitemap lastmod and "updated" lines. */
export function lastModOf(paths: string[]): string {
  const dates = paths.map((p) => data.gitDates[p]).filter((d): d is string => Boolean(d));
  if (!dates.length) throw new Error(`No git date recorded for ${paths.join(', ')}. Add the path to datedPaths in scripts/gen-data.ts.`);
  return dates.sort().at(-1) as string;
}
