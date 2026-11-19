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

/** Export conditions each runtime's bundler or loader honours, in the order they are tried. */
export const RUNTIME_CONDITIONS: Record<Runtime, string[]> = {
  node: ['node', 'import', 'default'],
  workers: ['workerd', 'worker', 'edge-light', 'browser', 'import', 'default'],
  browser: ['browser', 'import', 'default'],
};

/** Resolve an `exports` target the way Node does: the first key of a conditions object that the runtime honours. */
function resolveTarget(target: unknown, conditions: string[]): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = resolveTarget(t, conditions);
      if (r) return r;
    }
    return undefined;
  }
  if (target && typeof target === 'object') {
    for (const [k, v] of Object.entries(target as Record<string, unknown>)) {
      if (conditions.includes(k)) {
        const r = resolveTarget(v, conditions);
        if (r) return r;
      }
    }
  }
  return undefined;
}

/** The file a runtime loads for `import '<package>'`, from package.json `exports` (or `main`). */
export function runtimeEntry(pkgDir: string, runtime: Runtime): string | undefined {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    exports?: unknown;
    main?: string;
  };
  const exp = pkg.exports;
  const dot =
    exp && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'))
      ? (exp as Record<string, unknown>)['.']
      : exp;
  const target = resolveTarget(dot, RUNTIME_CONDITIONS[runtime]) ?? pkg.main;
  if (!target) return undefined;
  const file = join(pkgDir, target);
  return existsSync(file) ? file : undefined;
}

const RELATIVE_IMPORT =
  /\b(?:import|export)\s[^'"]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function resolveRelative(fromFile: string, spec: string): string | undefined {
  const base = join(fromFile, '..', spec);
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

/**
 * Source files reachable from an entry through relative static and dynamic
 * imports. Dynamic imports count as reachable on purpose: a bundler still
 * pulls them into the runtime build.
 */
export function reachableFiles(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(RELATIVE_IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const next = spec ? resolveRelative(file, spec) : undefined;
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  return [...seen].sort();
}

export interface PortableHit {
  file: string;
  line: number;
  rule: string;
  message: string;
  /** False when the file is in src/ but not loaded by the runtime's entry (a node-only entry, a CLI script). */
  reachable: boolean;
}

/**
 * Scan one provider package's src/ for code that cannot run on Workers or in a
 * browser. With a runtime, each hit says whether the file is reachable from
 * the entry that runtime resolves through package.json `exports` conditions.
 */
export function scanPortable(pkgDir: string, root = repoRoot, runtime?: Runtime): PortableHit[] {
  const hits: PortableHit[] = [];
  const entry = runtime ? runtimeEntry(pkgDir, runtime) : undefined;
  const reachable = entry ? new Set(reachableFiles(entry)) : undefined;
  for (const file of listSourceFiles(join(pkgDir, 'src'))) {
    const isReachable = reachable ? reachable.has(file) : true;
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((text, idx) => {
      for (const rule of SCAN_RULES) {
        if (rule.re.test(text)) {
          hits.push({
            file: relative(root, file),
            line: idx + 1,
            rule: rule.name,
            message: rule.message,
            reachable: isReachable,
          });
        }
      }
    });
  }
  return hits;
}

/**
 * Rungs whose model cannot be a `*_MODEL` value, each with the reason. The model-override check lists them as notes
 * instead of violations. Add to this list only when no env value could pick the model.
 */
export const FIXED_MODEL_RUNGS: { match: RegExp; why: string }[] = [
  {
    match: /^llm\/chrome-ai\//,
    why: "Chrome's Prompt API runs the browser's own on-device model; no request can choose another",
  },
  {
    match: /^visual\/tesseract\//,
    why: 'the model is the OCR language list, set with the documented TESSERACT_LANGS (language codes, not model ids)',
  },
];

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

/**
 * Env for checking one model variable. Some rungs exist only once their
 * server is configured (LOCAL_LLM_MODEL needs LOCAL_LLM_BASE_URL), so every
 * documented `<PREFIX>_BASE_URL` / `_URL` / `_HOST` sharing the variable's
 * prefix is set too, to an address that is never contacted.
 */
export function overrideEnv(name: string, value: string, documented: string[]): Env {
  const env: Env = { [name]: value };
  const parts = name.replace(/_MODEL$/, '').split('_');
  for (let n = parts.length; n >= 1; n--) {
    const prefix = parts.slice(0, n).join('_');
    for (const d of documented) {
      if (d.startsWith(`${prefix}_`) && /_(BASE_URL|URL|HOST)$/.test(d) && !(d in env)) env[d] = 'http://127.0.0.1:9/v1';
    }
  }
  return env;
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

/**
 * Load the providers of one runtime, package by package, from the list in
 * packages/registry/src/generated/<runtime>.ts. Importing each package on its
 * own means one broken package is reported alone instead of hiding the rest.
 */
export async function loadRuntimeProviders(
  runtime: Runtime,
  root = repoRoot,
): Promise<{
  providers: Provider[];
  packages: string[];
  origins: Map<string, string>;
  failures: { pkg: string; error: string }[];
}> {
  const generated = join(root, 'packages/registry/src/generated', `${runtime}.ts`);
  const m = /providerPackages: string\[\] = (\[[^\]]*\])/.exec(readFileSync(generated, 'utf8'));
  if (!m?.[1]) throw new Error(`no providerPackages list in ${relative(root, generated)}; run npm run gen`);
  const packages = JSON.parse(m[1]) as string[];
  const providers: Provider[] = [];
  const origins = new Map<string, string>();
  const failures: { pkg: string; error: string }[] = [];
  for (const name of packages) {
    try {
      const mod = (await import(name)) as { default: Provider | Provider[] };
      for (const p of [mod.default].flat()) {
        if (!p || typeof p !== 'object') throw new Error('the default export is not a Provider or Provider[]');
        providers.push(p);
        origins.set(p.id, name);
      }
    } catch (err) {
      failures.push({ pkg: name, error: (err as Error).message.split('\n')[0] ?? String(err) });
    }
  }
  return { providers, packages, origins, failures };
}

function rungsOf(p: Provider, env: Env): Rung[] {
  return 'rungs' in p && typeof p.rungs === 'function' ? (p.rungs(env) as Rung[]) : [];
}

// ---------------------------------------------------------------- checks

export interface CheckOptions {
  root?: string;
  /** Provider lists per runtime. Default: load the generated registries. */
  registries?: Partial<Record<Runtime, { providers: Provider[]; origins?: Map<string, string> }>>;
}

export async function checkInvariants(opts: CheckOptions = {}): Promise<InvariantReport> {
  const root = opts.root ?? repoRoot;
  const violations: Violation[] = [];
  const notes: string[] = [];
  const seenIds: Record<Runtime, string[]> = { node: [], workers: [], browser: [] };
  const v = (x: Violation) => {
    if (
      !violations.some((y) => y.check === x.check && y.provider === x.provider && y.file === x.file && y.message === x.message)
    ) {
      violations.push(x);
    }
  };

  const pkgs = providerPackages(root);
  const docVars = documentedEnvVars(root);
  const loaded: Partial<Record<Runtime, { providers: Provider[]; origins: Map<string, string> }>> = {};
  for (const runtime of RUNTIMES) {
    const given = opts.registries?.[runtime];
    if (given) {
      loaded[runtime] = { providers: given.providers, origins: given.origins ?? new Map() };
      continue;
    }
    try {
      const reg = await loadRuntimeProviders(runtime, root);
      loaded[runtime] = reg;
      for (const f of reg.failures) {
        const dir = pkgs.find((p) => p.name === f.pkg)?.dir;
        v({
          check: 'package-loads',
          provider: f.pkg,
          runtime,
          file: dir ? relative(root, join(dir, 'package.json')) : undefined,
          message: `failed to import, so its providers were not checked: ${f.error}`,
        });
      }
    } catch (err) {
      v({
        check: 'registry-loads',
        runtime,
        message: `the ${runtime} registry list could not be read: ${(err as Error).message}`,
      });
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
    const origins = new Map<string, ProviderPackage>();
    for (const [id, name] of reg.origins) {
      const pkg = pkgs.find((p) => p.name === name);
      if (pkg) origins.set(id, pkg);
    }
    seenIds[runtime] = reg.providers.map((p) => p.id);

    // Provider ids: unique and kebab-case.
    const counts = new Map<string, number>();
    for (const p of reg.providers) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    for (const [id, n] of counts) {
      if (n > 1) v({ check: 'unique-provider-id', provider: id, runtime, message: `provider id "${id}" appears ${n} times` });
    }
    for (const p of reg.providers) {
      const file = origins.get(p.id) ? relative(root, join(origins.get(p.id)?.dir ?? '', 'src/index.ts')) : undefined;
      if (!KEBAB.test(p.id))
        v({ check: 'kebab-provider-id', provider: p.id, runtime, file, message: `id "${p.id}" is not kebab-case` });
      if (!p.name) v({ check: 'provider-fields', provider: p.id, runtime, file, message: 'name is empty' });
      if (!p.runtimes?.includes(runtime)) {
        v({
          check: 'provider-fields',
          provider: p.id,
          runtime,
          file,
          message: `is in the ${runtime} registry but does not list it in runtimes`,
        });
      }
      if (p.kind === 'storage') {
        try {
          const { value, touched } = withoutNetwork(() => p.isEnabled(Object.freeze({})));
          if (typeof value !== 'boolean' || isPromiseLike(value) || touched.length > 0) {
            v({
              check: 'storage-is-enabled',
              provider: p.id,
              runtime,
              file,
              message: 'isEnabled must be a synchronous, offline boolean check on env',
            });
          }
        } catch (err) {
          v({
            check: 'storage-is-enabled',
            provider: p.id,
            runtime,
            file,
            message: `isEnabled threw on a frozen env: ${(err as Error).message}`,
          });
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
            v({
              check: 'rungs-offline',
              provider: p.id,
              runtime,
              file,
              message: `rungs(env) reached the network: ${run.touched[0]}`,
            });
          }
        } catch (err) {
          v({ check: 'rungs-build', provider: p.id, runtime, file, message: `rungs(${label}) threw: ${(err as Error).message}` });
          continue;
        }
        const a = first.map((r) => r.id);
        const b = second.map((r) => r.id);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          v({
            check: 'rungs-deterministic',
            provider: p.id,
            runtime,
            file,
            message: `rungs(${label}) returned different ids on a second call`,
          });
        }
        for (const r of first) {
          for (const problem of rungProblems(r, p.kind as RungKind, { builtFromEmptyEnv: label === 'empty env' })) {
            v({ check: 'rung-contract', provider: p.id, runtime, file, message: `${r.id}: ${problem}` });
          }
          if (r.provider && r.provider !== p.id) {
            v({
              check: 'rung-contract',
              provider: p.id,
              runtime,
              file,
              message: `${r.id}: rung.provider "${r.provider}" is not the provider id "${p.id}"`,
            });
          }
          const prev = owner.get(r.id);
          if (prev !== undefined) {
            v({
              check: 'unique-rung-id',
              provider: p.id,
              runtime,
              file,
              message: `rung id ${r.id} is also produced by ${prev} (${label})`,
            });
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
        const key = `${runtime}:${pkg.dir}`;
        if (checkedPortable.has(key)) continue;
        checkedPortable.add(key);
        const skipped = new Set<string>();
        for (const hit of scanPortable(pkg.dir, root, runtime)) {
          if (!hit.reachable) {
            skipped.add(hit.file);
            continue;
          }
          v({
            check: `portable-source:${hit.rule}`,
            provider: p.id,
            runtime,
            file: `${hit.file}:${hit.line}`,
            message: hit.message,
          });
        }
        if (skipped.size > 0) {
          notes.push(
            `${p.id} (${runtime}): Node-only code in ${[...skipped].join(', ')} is not reachable from the ${runtime} entry, so it is allowed`,
          );
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
          after = rungsOf(p, overrideEnv(name, sentinel, docVars));
        } catch {
          continue;
        }
        let hit = false;
        for (const r of base) {
          // Providers may normalise the value (an org prefix, a lowercase form), so the sentinel only has to appear in the model.
          if (after.some((x) => x.service === r.service && (x.model ?? '').toLowerCase().includes(sentinel))) {
            overridden.add(r.id);
            hit = true;
          }
        }
        if (hit) used.push(name);
      }
      if (used.length === 0) {
        notes.push(
          `${p.id}: no documented *_MODEL variable changes its rungs; document them in docs/providers.md to make this checkable`,
        );
      }
      for (const r of base) {
        if (!overridden.has(r.id)) {
          const fixed = FIXED_MODEL_RUNGS.find((f) => f.match.test(r.id));
          if (fixed) {
            notes.push(`${r.id}: no *_MODEL override by design (${fixed.why})`);
            continue;
          }
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
