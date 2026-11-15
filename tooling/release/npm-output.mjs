/**
 * Reads what `npm publish --dry-run` says about a bundle, so the release
 * script can tell a harmless manifest normalization from a change that would
 * break the published package.
 */

/**
 * Warnings `npm publish` prints on its own, outside the corrections list
 * (npm/lib/commands/publish.js). Every other `npm warn publish` line after
 * the "errors corrected:" header is a correction, whatever its wording, so a
 * wording npm adds later counts as a correction and fails safe.
 */
const SEPARATE_WARNINGS = [/^This command requires you to be logged in/, /^Skipping workspace /, /^npm auto-corrected /];

/** The corrections npm made to the manifest, without the log prefix. */
export function corrections(stderr) {
  const lines = stderr.split('\n');
  const start = lines.findIndex((l) => /^npm warn publish errors corrected:\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith('npm warn publish ')) break;
    const text = l.slice('npm warn publish '.length).trim();
    if (text && !SEPARATE_WARNINGS.some((re) => re.test(text))) out.push(text);
  }
  return out;
}

/**
 * npm canonicalizes a bin target such as `./dist/cli.mjs` to `dist/cli.mjs`
 * and reports it as `"bin[cli]" script name dist/cli.mjs was invalid and
 * removed`, although the entry is kept (@npmcli/package-json normalize.js
 * reassigns `pkg.bin[base] = binTarget` right after). Only that exact case is
 * harmless: same bin name, same path minus a leading `./`.
 */
export function isHarmless(line, pkg) {
  const m = /^"bin\[([^\]]+)\]" script name (\S+) was invalid and removed$/.exec(line);
  if (!m) return false;
  const [, name, target] = m;
  const declared = typeof pkg.bin === 'object' && pkg.bin ? pkg.bin[name] : undefined;
  return typeof declared === 'string' && declared.startsWith('./') && declared.slice(2) === target;
}

/** Corrections that would change what ships: anything not proven harmless. */
export function harmfulCorrections(stderr, pkg) {
  return corrections(stderr).filter((l) => !isHarmless(l, pkg));
}

/** True when the registry already has this exact version. */
export function alreadyPublished(stderr) {
  return /You cannot publish over the previously published versions?/.test(stderr);
}
