import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mediaFile from '@vid2context/provider-media-file';
import sttProvider from '@vid2context/provider-stt-openai-compatible';
import { describe, expect, it } from 'vitest';
import { createContext, getVideoContext, Registry } from '../../src/index.ts';
import { createTelemetry, OtlpExporter } from '../../src/telemetry/index.ts';
import { replayFetch, testContext } from '../../src/testing.ts';

// LIVE=1 with OTEL_EXPORTER_OTLP_ENDPOINT pointing at a running OpenTelemetry
// Collector (see docs/observability.md). The pipeline replays the recorded OVH
// transcription of the shared Apollo 11 clip; the export goes to the real collector.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const root = join(import.meta.dirname, '../../../..');
const APOLLO = join(root, 'tests/fixtures/media/apollo11-small-step.mp3');
const OVH_STT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';

describe.skipIf(!process.env.LIVE || !endpoint)('OTLP export to a real collector (LIVE)', () => {
  it('exports a pipeline run and the collector accepts traces and metrics', async () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=live-test' };
    const telemetry = createTelemetry({ env, fetch: globalThis.fetch.bind(globalThis) }, { flushIntervalMs: 0 });
    const ovh = replayFetch([
      {
        method: 'POST',
        url: OVH_STT,
        response: {
          body: readFileSync(
            join(root, 'providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json'),
            'utf8',
          ),
        },
      },
    ]);
    const ctx = createContext({ runtime: 'node', env: {}, fetch: ovh, log: testContext().log, telemetry });
    await getVideoContext(new Registry([mediaFile, sttProvider], 'node'), APOLLO, { mode: 'stt' }, ctx);
    await telemetry.flush();

    const otlp = telemetry.exporters.find((e): e is OtlpExporter => e instanceof OtlpExporter);
    expect(otlp?.stats).toMatchObject({ spansExported: 6, spansDropped: 0, metricExports: 1, failures: 0, lastStatus: 200 });
    await telemetry.shutdown();
  });
});
