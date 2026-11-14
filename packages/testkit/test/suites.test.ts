/**
 * Self-tests: the rung, storage and formatter suites run against foundation
 * code with the real fixtures that code already records. If a suite fails here, either the
 * suite or the foundation code broke the contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatters, MemoryKv, MemoryStorage, MemoryVectors } from '@vid2context/core';
import { llmRungs } from '@vid2context/provider-llm-openai-compatible';
import { sttRungs } from '@vid2context/provider-stt-openai-compatible';
import { describeFormatter, describeLlmRung, describeStorage, describeSttRung, repoRoot } from '../src/index.ts';

const stt = (name: string) => readFileSync(join(repoRoot, 'providers/stt-openai-compatible/test/fixtures', name), 'utf8');
const llm = (name: string) => readFileSync(join(repoRoot, 'providers/llm-openai-compatible/test/fixtures', name), 'utf8');

const OVH_STT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';
const ovhStt = sttRungs({}).find((r) => r.id === 'stt/ovh/whisper-large-v3-turbo');
if (!ovhStt) throw new Error('the keyless OVH speech-to-text rung is missing');
const apollo = new Uint8Array(readFileSync(join(repoRoot, 'tests/fixtures/media/apollo11-small-step.mp3')));

describeSttRung(ovhStt, {
  audio: { kind: 'bytes', data: apollo, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' },
  options: { language: 'en' },
  routes: [{ method: 'POST', url: OVH_STT, response: { body: stt('ovh-whisper-large-v3-turbo.verbose.json') } }],
  expectText: 'one small step',
  errors: [
    {
      name: 'OVH 429',
      status: 429,
      routes: [{ url: OVH_STT, response: { status: 429, headers: { 'retry-after': '31' }, body: stt('ovh-429.json') } }],
    },
    {
      name: 'OVH 400 bad extension',
      status: 400,
      routes: [{ url: OVH_STT, response: { status: 400, body: stt('ovh-400-extension.json') } }],
    },
  ],
});

const OVH_CHAT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const question = {
  messages: [{ role: 'user' as const, content: 'Which year did Apollo 11 land on the moon? Use keys year and mission.' }],
  maxTokens: 200,
};
const llama = llmRungs({}).find((r) => r.id === 'llm/ovh/Meta-Llama-3_3-70B-Instruct');
const gptOss = llmRungs({}).find((r) => r.id === 'llm/ovh/gpt-oss-120b');
if (!llama || !gptOss) throw new Error('the keyless OVH LLM rungs are missing');

describeLlmRung(llama, {
  request: { ...question, json: true },
  routes: [{ method: 'POST', url: OVH_CHAT, response: { body: llm('ovh-llama-3.3-70b.json-object.json') } }],
  expectText: '1969',
});
describeLlmRung(gptOss, {
  request: question,
  routes: [{ method: 'POST', url: OVH_CHAT, response: { body: llm('ovh-gpt-oss-120b.json') } }],
  expectText: /1969/,
  errors: [
    {
      name: 'reasoning model spent its budget (empty answer)',
      code: 'upstream',
      routes: [{ url: OVH_CHAT, response: { body: llm('ovh-gpt-oss-120b.empty-length.json') } }],
    },
  ],
});

describeStorage(() => new MemoryStorage(), { name: 'MemoryStorage' });

/** MemoryStorage with the process-local KvStore and VectorStore from core mixed in, to exercise the optional contracts. */
class MemoryStorageWithExtensions extends MemoryStorage {
  private kv = new MemoryKv();
  private vectors = new MemoryVectors();
  kvGet = this.kv.kvGet.bind(this.kv);
  kvSet = this.kv.kvSet.bind(this.kv);
  kvDelete = this.kv.kvDelete.bind(this.kv);
  kvList = this.kv.kvList.bind(this.kv);
  upsertVectors = this.vectors.upsertVectors.bind(this.vectors);
  deleteVectors = this.vectors.deleteVectors.bind(this.vectors);
  queryVectors = this.vectors.queryVectors.bind(this.vectors);
}
describeStorage(() => new MemoryStorageWithExtensions(), { name: 'MemoryStorage + MemoryKv + MemoryVectors' });

for (const id of ['text', 'json']) {
  const f = formatters[id];
  if (!f) throw new Error(`formatter ${id} is missing`);
  describeFormatter(f);
}
