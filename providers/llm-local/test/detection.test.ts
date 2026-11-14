import { type Route, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/detect.ts';
import { detectLocalServers } from '../src/detection.ts';
import { fixture, httpFixture } from './helpers.ts';

// Probe responses recorded on 2026-11-14 from Ollama 0.40.16, llama.cpp server
// b12383 and whisper.cpp server b5454, each on its own port (see fixtures README).
// Any URL without a recording throws, which is what a closed port looks like.
const OLLAMA = 'http://127.0.0.1:24434';
const LLAMACPP = 'http://127.0.0.1:25080/v1';
const WHISPER = 'http://127.0.0.1:26080/v1';

function shows(base: string): Route {
  const byModel: Record<string, string> = {
    'qwen2.5:3b': 'ollama-show-qwen2.5-3b.json',
    'qwen2.5:0.5b': 'ollama-show-qwen2.5-0.5b.json',
    'nomic-embed-text:latest': 'ollama-show-nomic-embed-text.json',
  };
  return {
    method: 'POST',
    url: `${base}/api/show`,
    response: (call) => ({ body: fixture(byModel[JSON.parse(String(call.body)).model] as string) }),
  };
}

const machine: Route[] = [
  { method: 'GET', url: `${OLLAMA}/api/version`, response: httpFixture('ollama-api-version.http') },
  { method: 'GET', url: `${OLLAMA}/api/tags`, response: { body: fixture('ollama-tags.json') } },
  shows(OLLAMA),
  { method: 'GET', url: `${LLAMACPP}/models`, response: httpFixture('llamacpp-v1-models.http') },
  { method: 'GET', url: `${WHISPER}/models`, response: httpFixture('whispercpp-v1-models.http') },
];

const env = { OLLAMA_BASE_URL: `${OLLAMA}/v1`, LLAMACPP_BASE_URL: LLAMACPP, LOCAL_STT_BASE_URL: WHISPER };
const GB = 1024 ** 3;

describe('detectLocalServers', () => {
  it('identifies Ollama, llama.cpp and whisper.cpp and lists their models', async () => {
    const r = await detectLocalServers(testContext({ env, fetch: replayFetch(machine) }));
    expect(r.servers.map((s) => [s.kind, s.baseUrl, s.identifiedBy])).toEqual([
      ['ollama', OLLAMA, 'api'],
      ['llamacpp', LLAMACPP, 'header'],
      ['whispercpp', 'http://127.0.0.1:26080', 'header'],
    ]);
    const ollama = r.servers[0];
    expect(ollama?.version).toBe('0.40.16');
    expect(ollama?.models.map((m) => [m.id, m.task, m.contextLength])).toEqual([
      ['qwen2.5:3b', 'chat', 32768],
      ['nomic-embed-text:latest', 'embed', 2048],
      ['qwen2.5:0.5b', 'chat', 32768],
    ]);
    expect(ollama?.models[0]?.capabilities).toEqual(['completion', 'tools']);
    // llama.cpp reports the context it was started with (-c 8192), not the model maximum.
    expect(r.servers[1]?.models).toEqual([
      {
        id: 'qwen2.5-0.5b-instruct-q4_k_m',
        task: 'chat',
        contextLength: 8192,
        capabilities: [],
        sizeBytes: 391859712,
        parameterSize: '494M',
      },
    ]);
    // Closed default ports are reported as failed probes, not servers.
    expect(r.probes.some((p) => p.url === 'http://localhost:1234/v1/models' && p.error)).toBe(true);
  });

  it('recommends a model per task and prints the env lines', async () => {
    const r = await detectLocalServers(testContext({ env, fetch: replayFetch(machine) }), {
      hardware: { totalRamBytes: 16 * GB, gpus: [] },
    });
    expect(r.recommendations.map((x) => [x.task, x.model])).toEqual([
      ['briefs', 'qwen2.5:3b'],
      ['cleanup', 'qwen2.5-0.5b-instruct-q4_k_m'],
      ['embeddings', 'nomic-embed-text:latest'],
      ['speech-to-text', 'whisper-1'],
    ]);
    expect(r.env).toContain('OLLAMA_MODEL=qwen2.5:3b');
    expect(r.env).toContain(`OLLAMA_BASE_URL=${OLLAMA}`);
    expect(r.env).toContain('OLLAMA_EMBED_MODEL=nomic-embed-text:latest');
    expect(r.env).toContain('LLAMACPP_MODEL=qwen2.5-0.5b-instruct-q4_k_m');
    expect(r.env).toContain(`LLAMACPP_BASE_URL=${LLAMACPP}`);
    expect(r.env).toContain(`LOCAL_STT_BASE_URL=${WHISPER}`);
    expect(r.suggestions).toEqual([]);
    const text = renderReport(r);
    expect(text).toContain('Ollama 0.40.16');
    expect(text).toContain('Paste into .env:');
  });

  it('skips models that do not fit in memory when recommending', async () => {
    // 1.8 GB qwen2.5:3b does not fit a 2 GB machine's budget; the 0.5B models do.
    const r = await detectLocalServers(testContext({ env, fetch: replayFetch(machine) }), {
      hardware: { totalRamBytes: 2 * GB },
    });
    expect(r.recommendations.find((x) => x.task === 'briefs')?.model).not.toBe('qwen2.5:3b');
  });

  it('finds Ollama on its default port, and suggests a model and Ollama when nothing is there', async () => {
    const def = 'http://localhost:11434';
    const atDefault = await detectLocalServers(
      testContext({
        fetch: replayFetch([
          { method: 'GET', url: `${def}/api/version`, response: httpFixture('ollama-api-version.http') },
          { method: 'GET', url: `${def}/api/tags`, response: { body: fixture('ollama-tags.json') } },
          shows(def),
        ]),
      }),
    );
    expect(atDefault.servers.map((s) => s.baseUrl)).toEqual([def]);
    expect(atDefault.env.some((l) => l.startsWith('OLLAMA_BASE_URL'))).toBe(false);

    const none = await detectLocalServers(testContext({ fetch: replayFetch([]) }), { hardware: { totalRamBytes: 16 * GB } });
    expect(none.servers).toEqual([]);
    expect(none.env).toEqual([]);
    expect(none.suggestions.join('\n')).toContain('ollama pull qwen2.5:7b');
  });

  it('recognizes Ollama behind a /v1 URL set for another lane, without listing it twice', async () => {
    const r = await detectLocalServers(
      testContext({
        env: { LOCAL_LLM_BASE_URL: `${OLLAMA}/v1`, OLLAMA_BASE_URL: OLLAMA },
        fetch: replayFetch([
          ...machine,
          { method: 'GET', url: `${OLLAMA}/v1/models`, response: httpFixture('ollama-v1-models.http') },
        ]),
      }),
    );
    expect(r.servers.filter((s) => s.kind === 'ollama')).toHaveLength(1);
  });
});
