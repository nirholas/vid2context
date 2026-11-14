/** Demo page for the browser entry: used for manual checks and the Playwright test. Not part of the package. */
import { createContext, type Logger } from '@vid2context/core';
import { browserHooks, onProgress, resolveModelId, transcribeSamples, webgpuWorks } from '../src/browser.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>('status');
const logEl = $<HTMLPreElement>('log');
const progress = $<HTMLProgressElement>('progress');

function setStatus(state: string, text: string) {
  status.dataset.state = state;
  status.textContent = text;
}

const log: Logger = {
  debug: () => {},
  info: (m) => {
    logEl.textContent += `${m}\n`;
  },
  warn: (m) => {
    logEl.textContent += `warn: ${m}\n`;
  },
  error: (m) => {
    logEl.textContent += `error: ${m}\n`;
  },
};

onProgress((e) => {
  if (e.status === 'progress_total' && typeof e.progress === 'number') progress.value = e.progress;
});

webgpuWorks().then((ok) => {
  status.dataset.webgpu = String(ok);
  logEl.textContent += `WebGPU ${ok ? 'available' : 'not available'}\n`;
});

const fmt = (s: number) => new Date(s * 1000).toISOString().slice(14, 22);

$<HTMLFormElement>('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const file = $<HTMLInputElement>('file').files?.[0];
  if (!file) return;
  const env = {
    TRANSFORMERS_STT_MODEL: $<HTMLInputElement>('model').value,
    TRANSFORMERS_DEVICE: $<HTMLSelectElement>('device').value,
    TRANSFORMERS_DTYPE: $<HTMLInputElement>('dtype').value || undefined,
  };
  const ctx = createContext({ runtime: 'browser', env, log });
  const out = $<HTMLPreElement>('segments');
  out.textContent = '';
  try {
    setStatus('decoding', 'Decoding audio...');
    const data = new Uint8Array(await file.arrayBuffer());
    const samples = await browserHooks.decode({ kind: 'bytes', data, mimeType: file.type, filename: file.name }, ctx);
    setStatus('loading', 'Loading the model...');
    const started = performance.now();
    const result = await transcribeSamples(
      browserHooks,
      resolveModelId(env.TRANSFORMERS_STT_MODEL),
      samples,
      { language: $<HTMLInputElement>('language').value || undefined },
      ctx,
    );
    out.textContent = result.segments.map((s) => `[${fmt(s.startSec)} - ${fmt(s.endSec)}] ${s.text}`).join('\n');
    status.dataset.device = result.device;
    status.dataset.language = result.language;
    status.dataset.result = JSON.stringify(result.segments);
    setStatus('done', `Done on ${result.device} in ${Math.round(performance.now() - started)} ms, language ${result.language}.`);
  } catch (err) {
    setStatus('error', `Error: ${(err as Error).message}`);
    console.error(err);
  }
});
