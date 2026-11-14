/**
 * Package videos for an agent or a ChatGPT/Claude Project: a .zip with every
 * format per video, one context.md written for a model, a manifest with
 * SHA-256 hashes and a README that tells an agent how to read it.
 *
 *   npx tsx examples/library/context-bundle.ts [out.zip]
 *
 * Offline: bundles two real recorded transcripts. Writes the zip to the path
 * given, or to ./<bundle name>.zip in the current directory.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildBundle, type VideoContext } from '@vid2context/core';

const load = (file: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8'));

const bundle = await buildBundle([load('youtube-jNQXAC9IVRw.json'), load('youtube-cCPsdFdlshc.json')], {
  name: 'g-wagon-and-zoo',
  maxTokens: 8000,
  // A fixed date makes the zip byte-identical on every run. Leave it out to use the current time.
  createdAt: new Date('2026-11-14T00:00:00Z'),
});

process.stdout.write(
  `${bundle.files.length} files in ${bundle.root}/, context written by "${bundle.manifest.contextFormatter}"\n`,
);
for (const v of bundle.manifest.videos) {
  process.stdout.write(`  ${v.folder}/  ${v.title} (${v.origin}, about ${v.estimatedTokens} tokens)\n`);
}
process.stdout.write('\n');
for (const f of bundle.manifest.files) process.stdout.write(`  ${String(f.bytes).padStart(6)}  ${f.path}\n`);

const zip = new Uint8Array(await new Response(bundle.zip()).arrayBuffer());
const path = process.argv[2] ?? bundle.filename;
writeFileSync(path, zip);
process.stdout.write(`\nwrote ${path} (${zip.byteLength} bytes)\n`);
