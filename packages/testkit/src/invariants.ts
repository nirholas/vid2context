/**
 * Static invariants over the generated provider registries (node, workers,
 * browser). checkInvariants() never throws for a provider problem: it returns
 * every violation with the provider id and, where it applies, the file, so
 * `npm run conformance` can print one list for the whole repo.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type Env, type Provider, Registry, type Rung, type Runtime } from '@vid2context/core';
import { isPromiseLike, repoRoot, withoutNetwork } from './fixtures.ts';
import { type RungKind, rungProblems } from './rung-checks.ts';

export const RUNTIMES: Runtime[] = ['node', 'workers', 'browser'];
const RUNG_KINDS: RungKind[] = ['stt', 'llm', 'embed', 'video', 'visual'];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface Violation {
  check: string;
  provider?: string;
  runtime?: Runtime;
  file?: string;
  message: string;
}

export interface InvariantReport {
  violations: Violation[];
  /** Things the checker could not verify, with the reason. Not failures. */
  notes: string[];
  /** Provider ids seen per runtime. */
  providers: Record<Runtime, string[]>;
}

interface ProviderPackage {
  name: string;
  dir: string;
  runtimes: Runtime[];
}

/** Provider packages under providers/*, from their package.json. */
export function providerPackages(root = repoRoot): ProviderPackage[] {
  const dir = join(root, 'providers');
  if (!existsSync(dir)) return [];
  const out: ProviderPackage[] = [];
  for (const d of readdirSync(dir).sort()) {
    const pkgPath = join(dir, d, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; vid2context?: { runtimes?: Runtime[] } };
      if (pkg.name && Array.isArray(pkg.vid2context?.runtimes)) {
        out.push({ name: pkg.name, dir: join(dir, d), runtimes: pkg.vid2context.runtimes });
      }
    } catch {
      // gen-registry reports invalid package.json files; nothing to scan here.
    }
  }
  return out;
}

// ---------------------------------------------------------------- source scan

/** Remove // and block comments, keeping strings (import specifiers live in strings). */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i] ?? '';
    const n = src[i + 1] ?? '';
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const block = src.slice(i, end === -1 ? src.length : end + 2);
      out += block.replace(/[^\n]/g, ' ');
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const SCAN_RULES: { name: string; re: RegExp; message: string }[] = [
  {
    name: 'node-import',
    re: /\b(?:from|import)\s*\(?\s*['"]node:[^'"]+['"]|\brequire\(\s*['"]node:[^'"]+['"]\)/,
    message: 'imports a node: built-in',
  },
  {
    name: 'builtin-import',
    re: /\b(?:from|import)\s*\(?\s*['"](?:child_process|fs|fs\/promises|os|path|net|tls|http|https|worker_threads)['"]|\brequire\(\s*['"](?:child_process|fs|fs\/promises)['"]\)/,
    message: 'imports a Node built-in (child_process, fs, ...)',
  },
  { name: 'process-env', re: /\bprocess\.env\b/, message: 'reads process.env (use ctx.env)' },
  { name: 'global-fetch', re: /(?<![.\w$])fetch\s*\(/, message: 'calls the global fetch( (use ctx.fetch)' },
  { name: 'global-fetch', re: /\b(?:globalThis|window|self)\.fetch\b/, message: 'uses the global fetch (use ctx.fetch)' },
];

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|mts|js|mjs)$/.test(entry) && !/\.(test|spec)\./.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Scan one provider package's src/ for code that cannot run on Workers or in a browser. */
export function scanPortable(pkgDir: string, root = repoRoot): { file: string; line: number; rule: string; message: string }[] {
  const hits: { file: string; line: number; rule: string; message: string }[] = [];
  for (const file of listSourceFiles(join(pkgDir, 'src'))) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((text, idx) => {
      for (const rule of SCAN_RULES) {
        if (rule.re.test(text)) hits.push({ file: relative(root, file), line: idx + 1, rule: rule.name, message: rule.message });
      }
    });
  }
  return hits;
}

// ---------------------------------------------------------------- env helpers

/** Env var names documented in docs/providers.md and .env.example. */
export function documentedEnvVars(root = repoRoot): string[] {
  const names = new Set<string>();
  for (const f of ['docs/providers.md', '.env.example']) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) names.add(m[0]);
  }
  return [...names].sort();
}

/** Model override variables: `<PROVIDER>_MODEL`, `_STT_MODEL`, `_EMBED_MODEL` and the other `_<KIND>_MODEL` forms. */
export function modelVars(names: string[]): string[] {
  return names.filter((n) => /_MODEL$/.test(n) && !n.startsWith('VID2CONTEXT_'));
}

const SECRET_NAME = /_(API_KEY|KEY|TOKEN|SECRET|PASSWORD|FALLBACK_KEYS|KEYS)$/;

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A value with the shape of a real key for that variable (a random one, never a working credential). */
export function keyShapedValue(name: string): string {
  const body = randomHex(20);
  if (name.startsWith('ANTHROPIC')) return `sk-ant-api03-${body}`;
  if (name.startsWith('OPENAI')) return `sk-proj-${body}`;
  if (name.startsWith('GROQ')) return `gsk_${body}`;
  if (name.startsWith('GEMINI') || name.startsWith('GOOGLE')) return `AIzaSy${body.slice(0, 33)}`;
  if (name.startsWith('GITHUB')) return `ghp_${body.slice(0, 36)}`;
  if (name.startsWith('HF_') || name.startsWith('HUGGINGFACE')) return `hf_${body.slice(0, 34)}`;
  return `${name.toLowerCase().replace(/_/g, '').slice(0, 8)}_${body}`;
}

/** Env with a key-shaped value for every secret-looking variable (documented or required by a rung). */
export function keyShapedEnv(names: string[]): Env {
  const env: Env = {};
  for (const n of names) {
    if (!SECRET_NAME.test(n)) continue;
    env[n] = n.endsWith('_KEYS') ? `${keyShapedValue(n)},${keyShapedValue(n)}` : keyShapedValue(n);
  }
  return env;
}

// ---------------------------------------------------------------- loading

/** Load one generated runtime registry module. */
export async function loadRuntimeProviders(runtime: Runtime): Promise<{ providers: Provider[]; packages: string[] }> {
  const mod = (await import(`@vid2context/registry/${runtime}`)) as { providers: Provider[]; providerPackages: string[] };
  return { providers: mod.providers, packages: mod.providerPackages };
}

/** Which package (and so which directory) each provider id comes from. */
async function providerOrigins(packages: string[], all: ProviderPackage[]): Promise<Map<string, ProviderPackage>> {
  const map = new Map<string, ProviderPackage>();
  for (const name of packages) {
    const pkg = all.find((p) => p.name === name);
    if (!pkg) continue;
    try {
      const mod = (await import(name)) as { default: Provider | Provider[] };
      for (const p of [mod.default].flat()) if (p?.id) map.set(p.id, pkg);
    } catch {
      // Load failures are reported once by checkInvariants.
    }
  }
  return map;
}

function rungsOf(p: Provider, env: Env): Rung[] {
  return 'rungs' in p && typeof p.rungs === 'function' ? (p.rungs(env) as Rung[]) : [];
}

// ---------------------------------------------------------------- checks

export interface CheckOptions {
  root?: string;
  /** Provider lists per runtime. Default: load the generated registries. */
  registries?: Partial<Record<Runtime, { providers: Provider[]; packages: string[] }>>;
}

export async function checkInvariants(opts: CheckOptions = {}): Promise<InvariantReport> {
  const root = opts.root ?? repoRoot;
  const violations: Violation[] = [];
  const notes: string[] = [];
  const seenIds: Record<Runtime, string[]> = { node: [], workers: [], browser: [] };
  const v = (x: Violation) => {
    if (!violations.some((y) => y.check === x.check && y.provider === x.provider && y.file === x.file && y.message === x.message)) {
      violations.push(x);
    }
  };

  const pkgs = providerPackages(root);
  const docVars = documentedEnvVars(root);
  const loaded: Partial<Record<Runtime, { providers: Provider[]; packages: string[] }>> = {};
  for (const runtime of RUNTIMES) {
    const given = opts.registries?.[runtime];
    if (given) {
      loaded[runtime] = given;
      continue;
    }
    try {
      loaded[runtime] = await loadRuntimeProviders(runtime);
    } catch (err) {
      v({ check: 'registry-loads', runtime, message: `the ${runtime} registry failed to load: ${(err as Error).message}` });
    }
  }

  // Every secret-looking var any rung requires, in any runtime, plus the documented ones.
  const secretNames = new Set(docVars.filter((n) => SECRET_NAME.test(n)));
  for (const reg of Object.values(loaded)) {
    for (const p of reg?.providers ?? []) {
      try {
        for (const r of rungsOf(p, {})) for (const k of r.requires ?? []) secretNames.add(k);
      } catch {
        // Reported below by the rung checks.
      }
    }
  }
  const keyEnv = keyShapedEnv([...secretNames]);
  const envs: { label: string; env: Env }[] = [
    { label: 'empty env', env: {} },
    { label: 'every key set', env: keyEnv },
  ];

  const checkedPortable = new Set<string>();
  const checkedOverride = new Set<string>();

  for (const runtime of RUNTIMES) {
    const reg = loaded[runtime];
    if (!reg) continue;
    const origins = await providerOrigins(reg.packages, pkgs);
    seenIds[runtime] = reg.providers.map((p) => p.id);

    // Provider ids: unique and kebab-case.
    const counts = new Map<string, number>();
    for (const p of reg.providers) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    for (const [id, n] of counts) {
      if (n > 1) v({ check: 'unique-provider-id', provider: id, runtime, message: `provider id "${id}" appears ${n} times` });
    }
    for (const p of reg.providers) {
      const file = origins.get(p.id) ? relative(root, join(origins.get(p.id)?.dir ?? '', 'src/index.ts')) : undefined;
      if (!KEBAB.test(p.id)) v({ check: 'kebab-provider-id', provider: p.id, runtime, file, message: `id "${p.id}" is not kebab-case` });
      if (!p.name) v({ check: 'provider-fields', provider: p.id, runtime, file, message: 'name is empty' });
      if (!p.runtimes?.includes(runtime)) {
        v({ check: 'provider-fields', provider: p.id, runtime, file, message: `is in the ${runtime} registry but does not list it in runtimes` });
      }
      if (p.kind === 'storage') {
        try {
          const { value, touched } = withoutNetwork(() => p.isEnabled(Object.freeze({})));
          if (typeof value !== 'boolean' || isPromiseLike(value) || touched.length > 0) {
            v({ check: 'storage-is-enabled', provider: p.id, runtime, file, message: 'isEnabled must be a synchronous, offline boolean check on env' });
          }
        } catch (err) {
          v({ check: 'storage-is-enabled', provider: p.id, runtime, file, message: `isEnabled threw on a frozen env: ${(err as Error).message}` });
        }
      }
    }

    try {
      new Registry(reg.providers, runtime);
    } catch (err) {
      v({ check: 'registry-builds', runtime, message: (err as Error).message });
    }

    // Rungs: contract, unique ids per env, deterministic rebuild.
    for (const { label, env } of envs) {
      const owner = new Map<string, string>();
      for (const p of reg.providers) {
        if (!RUNG_KINDS.includes(p.kind as RungKind)) continue;
        const file = origins.get(p.id) ? relative(root, join(origins.get(p.id)?.dir ?? '', 'src')) : undefined;
        let first: Rung[];
        let second: Rung[];
        try {
          const run = withoutNetwork(() => [rungsOf(p, env), rungsOf(p, env)] as const);
          [first, second] = run.value;
          if (run.touched.length > 0) {
            v({ check: 'rungs-offline', provider: p.id, runtime, file, message: `rungs(env) reached the network: ${run.touched[0]}` });
          }
        } catch (err) {
          v({ check: 'rungs-build', provider: p.id, runtime, file, message: `rungs(${label}) threw: ${(err as Error).message}` });
          continue;
        }
        const a = first.map((r) => r.id);
        const b = second.map((r) => r.id);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          v({ check: 'rungs-deterministic', provider: p.id, runtime, file, message: `rungs(${label}) returned different ids on a second call` });
        }
        for (const r of first) {
          for (const problem of rungProblems(r, p.kind as RungKind)) {
            v({ check: 'rung-contract', provider: p.id, runtime, file, message: `${r.id}: ${problem}` });
          }
          if (r.provider && r.provider !== p.id) {
            v({ check: 'rung-contract', provider: p.id, runtime, file, message: `${r.id}: rung.provider "${r.provider}" is not the provider id "${p.id}"` });
          }
          const prev = owner.get(r.id);
          if (prev !== undefined) {
            v({ check: 'unique-rung-id', provider: p.id, runtime, file, message: `rung id ${r.id} is also produced by ${prev} (${label})` });
          }
          owner.set(r.id, p.id);
        }
      }
    }

    // Workers and browser providers: no Node-only code anywhere in src/.
    if (runtime !== 'node') {
      for (const p of reg.providers) {
        const pkg = origins.get(p.id);
        if (!pkg) {
          notes.push(`${p.id} (${runtime}): could not map to a package directory, source scan skipped`);
          continue;
        }
        const key = `${pkg.dir}`;
        if (checkedPortable.has(key)) continue;
        checkedPortable.add(key);
        for (const hit of scanPortable(pkg.dir, root)) {
          v({ check: `portable-source:${hit.rule}`, provider: p.id, runtime, file: `${hit.file}:${hit.line}`, message: hit.message });
        }
      }
    }

    // Model overrides: every rung's model must be replaceable from env.
    const vars = modelVars(docVars);
    const sentinel = 'conformance-override-model';
    for (const p of reg.providers) {
      if (!RUNG_KINDS.includes(p.kind as RungKind) || checkedOverride.has(p.id)) continue;
      checkedOverride.add(p.id);
      let base: Rung[];
      try {
        base = rungsOf(p, {});
      } catch {
        continue;
      }
      if (base.length === 0) {
        notes.push(`${p.id}: no rungs with an empty env, so model overrides were not checked`);
        continue;
      }
      const overridden = new Set<string>();
      const used: string[] = [];
      for (const name of vars) {
        let after: Rung[];
        try {
          after = rungsOf(p, { [name]: sentinel });
        } catch {
          continue;
        }
        let hit = false;
        for (const r of base) {
          if (after.some((x) => x.service === r.service && x.model === sentinel)) {
            overridden.add(r.id);
            hit = true;
          }
        }
        if (hit) used.push(name);
      }
      if (used.length === 0) {
        notes.push(`${p.id}: no documented *_MODEL variable changes its rungs; document them in docs/providers.md to make this checkable`);
      }
      for (const r of base) {
        if (!overridden.has(r.id)) {
          const file = origins.get(p.id) ? relative(root, join(origins.get(p.id)?.dir ?? '', 'src')) : undefined;
          v({
            check: 'model-override',
            provider: p.id,
            runtime,
            file,
            message: `${r.id}: no documented *_MODEL variable in docs/providers.md or .env.example overrides this rung's model`,
          });
        }
      }
    }

    // Health output never echoes key values.
    try {
      const health = JSON.stringify(new Registry(reg.providers, runtime).health(keyEnv));
      for (const [name, value] of Object.entries(keyEnv)) {
        for (const part of (value ?? '').split(',')) {
          if (part && health.includes(part)) {
            v({ check: 'health-no-secrets', runtime, message: `registry.health(env) output contains the value of ${name}` });
          }
        }
      }
    } catch (err) {
      v({ check: 'health-no-secrets', runtime, message: `registry.health(env) threw: ${(err as Error).message}` });
    }
  }

  return { violations, notes: [...new Set(notes)], providers: seenIds };
}

/** Plain-text report: one line per violation, grouped by provider. */
export function formatReport(report: InvariantReport): string {
  const lines: string[] = [];
  for (const runtime of RUNTIMES) {
    lines.push(`${runtime}: ${report.providers[runtime].length} provider(s): ${report.providers[runtime].join(', ') || 'none'}`);
  }
  if (report.violations.length === 0) lines.push('', 'No invariant violations.');
  else {
    lines.push('', `${report.violations.length} invariant violation(s):`);
    const byProvider = new Map<string, Violation[]>();
    for (const x of report.violations) {
      const k = x.provider ?? '(registry)';
      byProvider.set(k, [...(byProvider.get(k) ?? []), x]);
    }
    for (const [provider, list] of [...byProvider].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${provider}`);
      for (const x of list) {
        lines.push(`    [${x.check}]${x.runtime ? ` (${x.runtime})` : ''} ${x.message}${x.file ? `  at ${x.file}` : ''}`);
      }
    }
  }
  if (report.notes.length > 0) lines.push('', 'Not checked:', ...report.notes.map((n) => `  ${n}`));
  return lines.join('\n');
}
