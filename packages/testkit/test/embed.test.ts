/**
 * Self-test: the embedding rung suite against the keyless OVH bge-m3 rung from
 * the embed provider, replaying the responses that provider recorded.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embedRungs } from '@vid2context/provider-embed';
import { describeEmbedRung, repoRoot } from '../src/index.ts';

const fixture = (name: string) => readFileSync(join(repoRoot, 'providers/embed/test/fixtures', name), 'utf8');
const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings';

const bge = embedRungs({}).find((r) => r.service === 'ovh' && r.model === 'bge-m3');
if (!bge) throw new Error('the keyless OVH bge-m3 embedding rung is missing');

describeEmbedRung(bge, {
  texts: JSON.parse(fixture('sentences.json')) as string[],
  routes: [{ method: 'POST', url: OVH, response: { body: fixture('ovh-bge-m3.json') } }],
  errors: [
    {
      name: 'OVH 429',
      status: 429,
      routes: [
        { url: OVH, response: { status: 429, headers: { 'retry-after': '2' }, body: fixture('ovh-rate-limited.429.json') } },
      ],
    },
    {
      name: 'OVH 404 unknown model',
      status: 404,
      routes: [{ url: OVH, response: { status: 404, body: fixture('ovh-bad-model.404.json') } }],
    },
  ],
});
