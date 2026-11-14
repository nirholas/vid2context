/** Demo page for the in-browser LLM rungs: used for manual checks and the Playwright test. Not part of the package. */
import { createContext, type Env, type Logger, streamFromRung } from '@vid2context/core';
import provider, { browserAiEnv, detectBrowserAi, onProgress, recommendedWebLlmModels } from '../src/index.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>('status');
const logEl = $<HTMLPreElement>('log');
const support = $<HTMLPreElement>('support');

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

function setStatus(state: string, text: string) {
  status.dataset.state = state;
  status.textContent = text;
}

onProgress((e) => {
  if (typeof e.progress === 'number') $<HTMLProgressElement>('progress').value = e.progress;
  status.textContent = `${e.engine}: ${e.text}`;
});

const detected = await detectBrowserAi();
support.textContent = JSON.stringify(detected, null, 2);
support.dataset.result = JSON.stringify(detected);
support.dataset.state = 'done';
$<HTMLInputElement>('model').value = recommendedWebLlmModels(detected.shaderF16)[0] ?? '';
const select = $<HTMLSelectElement>('rung');
for (const [value, label] of [
  ['webllm', 'WebLLM'],
  ['chrome-ai', 'Chrome built-in AI (Prompt API)'],
]) {
  const opt = document.createElement('option');
  opt.value = value as string;
  opt.textContent = label as string;
  select.append(opt);
}
if (detected.chromePromptApi !== 'unavailable' && !detected.webllm) select.value = 'chrome-ai';

$<HTMLFormElement>('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const env: Env = { ...browserAiEnv(detected, { allowDownloads: true }) };
  if (select.value === 'webllm') env.WEBLLM_MODEL = $<HTMLInputElement>('model').value;
  else env.CHROME_AI = '1';
  const ctx = createContext({ runtime: 'browser', env, log });
  const rung = provider.rungs(env).find((r) => r.service === select.value && r.isEnabled?.(env));
  const answer = $<HTMLPreElement>('answer');
  answer.textContent = '';
  if (!rung) {
    setStatus('error', 'Error: no enabled rung for this choice.');
    return;
  }
  try {
    setStatus('running', `Running ${rung.id}...`);
    const started = performance.now();
    let deltas = 0;
    for await (const e of streamFromRung(
      rung,
      { messages: [{ role: 'user', content: $<HTMLTextAreaElement>('prompt').value }], maxTokens: 128 },
      ctx,
    )) {
      if (e.type === 'delta') {
        deltas++;
        answer.textContent += e.text;
      } else if (e.type === 'done') {
        status.dataset.result = JSON.stringify({ ...e.result, deltas, rung: rung.id });
      }
    }
    setStatus('done', `Done with ${rung.id} in ${Math.round(performance.now() - started)} ms (${deltas} deltas).`);
  } catch (err) {
    setStatus('error', `Error: ${(err as Error).message}`);
    console.error(err);
  }
});
