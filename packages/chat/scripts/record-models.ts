/**
 * Record the real ModelInfo list the browser registry produces, with core's
 * listModels (the same function behind GET /api/v1/models), for picker and
 * meter tests. Two envs: no keys at all (what a first-time visitor sees in
 * client-only mode), and with a Groq key name set to a dummy value so the
 * enabled and pooled-key paths are covered. The dummy value never leaves
 * this script: listModels returns env var names only, never values.
 *
 *   npx tsx packages/chat/scripts/record-models.ts
 */
import { writeFileSync } from 'node:fs';
import { listModels } from '@vid2context/core';
import { createRegistry } from '@vid2context/registry/browser';

const registry = createRegistry();
const out = (name: string, env: Record<string, string>) => {
  const models = listModels(registry, env, { kind: 'llm' });
  const file = new URL(`../test/fixtures/${name}`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ recordedAt: new Date().toISOString(), env: Object.keys(env), models }, null, 2)}\n`);
  console.error(`${name}: ${models.length} models, ${models.filter((m) => m.enabled).length} enabled`);
};

out('models-browser-nokeys.json', {});
out('models-browser-groq.json', { GROQ_API_KEY: 'dummy', GROQ_FALLBACK_KEYS: 'dummy-2' });
