# Offline and in-browser AI

vid2context can transcribe and summarize without sending anything off your device. On Node, Whisper runs on Transformers.js with no binaries to build. In the browser, the same Whisper models run on WebGPU or WASM, and two local chat engines answer questions: WebLLM and Chrome's built-in Prompt API. This is what powers the GitHub Pages client-only mode, where a user drops a local recording into the page and it is transcribed and summarized in that tab.

| Rung | Runs on | Enabled by | What it does |
|---|---|---|---|
| `stt/transformers/<model>` | Node, browser | `TRANSFORMERS_STT_MODEL` | Whisper speech-to-text with timestamps, language detection, translation to English |
| `llm/webllm/<model>` | browser (WebGPU) | `WEBLLM_MODEL` | streaming chat with a small instruct model |
| `llm/chrome-ai/prompt-api` | Chrome desktop | `CHROME_AI=1` | streaming chat with Chrome's on-device model |

All three are tier `local`: the default `free` policy tries them before any hosted service, and `VID2CONTEXT_POLICY=local-only` keeps only them (plus other local rungs such as whisper.cpp and Ollama).

## Whisper on Transformers.js

### Node

```sh
TRANSFORMERS_STT_MODEL=whisper-base npm run cli -- recording.mp3 --mode stt
```

The first run downloads the model from huggingface.co into `.vid2context/models/transformers/` (or `$VID2CONTEXT_HOME/models/transformers/`). After that it runs offline. Audio is decoded with ffmpeg (`FFMPEG_PATH`, then `PATH`) to 16 kHz mono samples, so anything ffmpeg reads works, including video files. Inference uses onnxruntime-node on the CPU; set `TRANSFORMERS_DEVICE=cuda` (Linux), `dml` (Windows) or `coreml` (macOS) to use a GPU where your onnxruntime-node install supports it (GPU devices were not verified for this guide).

### Browser

The browser entry (the package's `browser` export condition) decodes audio with Web Audio (`OfflineAudioContext` resamples to 16 kHz) and runs on WebGPU when the browser hands out an adapter, WASM otherwise. Models are cached in the browser's Cache Storage, so the second visit works offline. ONNX Runtime's WASM files load from cdn.jsdelivr.net (pinned to the bundled version) unless `TRANSFORMERS_WASM_PATH` points at a self-hosted copy of `onnxruntime-web/dist/`.

In the web app, in-browser transcription runs in a Web Worker (`packages/web/src/audio/transcribe.worker.ts`), so a long file never freezes the page, and Cancel terminates the worker, which really stops Whisper. One worker is kept for the page, so the model loads once. Workers have no Web Audio, so the app builds the Whisper rung with `createTransformersProvider` from the package's `./shared` entry and hooks that read its own 16 kHz PCM WAV directly; Web Audio is used only where it exists. If a module worker cannot start (an old browser or a strict CSP), the same code runs on the page.

The web app can show download progress with the exported hook:

```ts
import { onProgress } from '@vid2context/provider-stt-transformers';
const stop = onProgress((e) => { if (e.status === 'progress_total') bar.value = e.progress; });
```

### Models and download sizes

| `TRANSFORMERS_STT_MODEL` | Weights downloaded (default precision) | Good for |
|---|---|---|
| `whisper-tiny` | about 150 MB (fp32) | quick drafts on slow machines |
| `whisper-base` (default) | about 290 MB (fp32) | CPU and WASM |
| `whisper-small` | about 970 MB (fp32) | better accuracy on a fast CPU |
| `whisper-large-v3-turbo` | about 1.6 GB on WebGPU (fp16 encoder, 4-bit decoder); about 1 GB on CPU (8-bit encoder, 4-bit decoder) | best accuracy; use it on WebGPU or a GPU |

Any Whisper repo in the `onnx-community` organization works by short name, and any other ONNX Whisper export by its full repo id. English-only models (`whisper-base.en`) skip language detection. `whisper-large-v3-turbo` cannot translate (it was trained without translation data), so its rung does not advertise `translate`.

Why full precision for the small models: on the Apollo clip, 8-bit weights made whisper-base loop ("4-4-4-...") on CPU and mishear words on WASM ("one small stem for land"), while fp32 was both accurate and no slower. `TRANSFORMERS_DTYPE` overrides the choice: one value (`fp32`, `fp16`, `q8`, `q4`) or `encoder=<dtype>,decoder=<dtype>`.

### Long recordings and timestamps

Audio is transcribed in 30 s windows with 5 s of overlap on each side; Transformers.js stitches the windows and returns absolute times, which become `Segment`s. Memory is about 64 KB per second of audio for the decoded samples (230 MB per hour) plus the model.

### Language

Transformers.js assumes English when no language is given. The rung instead runs Whisper's own language identification on the first 30 s (one decoder step restricted to language tokens) and transcribes in the detected language. Pass a language to skip the step. Callers that want English output from another language pass `task: 'translate'` (see `TransformersSttOptions`).

## WebGPU or WASM

WebGPU uses the GPU and is many times faster for the larger models; it is on by default in desktop Chrome and Edge, and in recent Safari and Firefox releases on some platforms. WASM runs everywhere on the CPU: whisper-base transcribed the 24 s Apollo clip in about 25 s in headless Chromium (single-threaded, model load included). Multi-threaded WASM needs the page to be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`); GitHub Pages cannot set those headers, so expect single-threaded speed there.

`TRANSFORMERS_DEVICE` forces a device: `wasm` or `webgpu` in the browser.

## In-browser chat

### WebLLM

[WebLLM](https://github.com/mlc-ai/web-llm) runs MLC-compiled models on WebGPU. `WEBLLM_MODEL` takes a comma-separated list of ids from WebLLM's prebuilt list; each becomes a streaming rung. The recommended ones:

| Model | VRAM (WebLLM's figure) |
|---|---|
| `Llama-3.2-1B-Instruct-q4f16_1-MLC` | 0.9 GB |
| `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` | 1.6 GB |
| `Llama-3.2-3B-Instruct-q4f16_1-MLC` | 2.3 GB |

`q4f16` builds need the WebGPU `shader-f16` feature; on GPUs without it use the `q4f32_1` builds of the same models (`detectBrowserAi()` reports `shaderF16`, and `recommendedWebLlmModels(shaderF16)` returns the right list). The download is about the VRAM figure and is cached by the browser. All of these have a 4096-token window, so send excerpts or chunked sections, not a whole long transcript.

### Chrome built-in AI (Prompt API)

Chrome's `LanguageModel` API runs Gemini Nano on the device: desktop Chrome 148 and later on web pages (Chrome 138 in extensions), on Windows 10 or 11, macOS 13 or later, Linux and Chromebook Plus. It needs about 22 GB of free disk for the model, and a GPU with more than 4 GB of memory or a CPU with 16 GB of RAM and 4 cores. The model downloads once (progress comes through `onProgress`). The rung opens a fresh session per request seeded with the conversation and reports the session's `contextWindow` as its context size.

Chromium builds (not Google Chrome) expose the same API without a model: `availability()` says `downloadable`, and every answer is "On-device model is not available in Chromium" followed by the prompt. The rung recognizes that notice and fails with `no-provider`, so the chain moves on instead of returning the echo.

Neither engine advertises JSON output: structured output was not verified for them, so callers that need `json` get a hosted or Ollama rung instead.

## How the web app enables these rungs

Rungs decide from env only. In the browser, env is the user's settings, so the web app runs feature detection once and writes flags:

```ts
import { browserAiEnv, detectBrowserAi } from '@vid2context/provider-llm-browser';

const support = await detectBrowserAi();
// { webgpu, webllm, chromePromptApi: 'available' | 'downloadable' | 'unavailable', shaderF16 }
const env = {
  ...userSettings,
  ...browserAiEnv(support, { allowDownloads: userAgreedToDownloads }),
  TRANSFORMERS_STT_MODEL: support.webgpu ? 'whisper-large-v3-turbo' : 'whisper-base',
};
```

`browserAiEnv` sets `CHROME_AI=1` when the Prompt API is ready (or downloadable and downloads are allowed), and `WEBLLM_MODEL` to the smallest recommended model when WebGPU works and downloads are allowed. Ask before downloads: they are hundreds of megabytes to several gigabytes.

## Privacy

These rungs never send audio or text anywhere. The only network traffic is the one-time model download (huggingface.co for Whisper and WebLLM weights, cdn.jsdelivr.net for ONNX Runtime's WASM files unless self-hosted, Google's component updater for Chrome's model). After that, everything runs on the device and works offline.

## What was verified (2026-11-14)

- Node: whisper-base downloaded into a temporary `VID2CONTEXT_HOME` and transcribed the Apollo clip on onnxruntime-node (CPU), language detected as `en`, through the CLI with `--mode stt` (`attempts` shows `stt/transformers/onnx-community/whisper-base`).
- Browser, headless Chromium 159 (Playwright): the Whisper demo transcribed the Apollo clip on WASM in about 25 s. Headless Chromium has no WebGPU adapter by default, so the WebGPU path of the Whisper rung was not exercised.
- Chromium exposes the Prompt API as `downloadable` but without a model (the echo described above); the rung's refusal was verified. A real Gemini Nano answer was not verified (no Google Chrome with the model here).
- WebLLM on a software WebGPU adapter (`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`): `SmolLM2-360M-Instruct-q4f32_1-MLC` downloaded and loaded, but the device was lost during generation after about 13 minutes, so a streamed WebLLM answer is unverified. It needs a real GPU.
- Not verified: GPU devices in Node (`cuda`, `dml`, `coreml`), and `whisper-large-v3-turbo`.

## Demo pages

`providers/stt-transformers/demo/` and `providers/llm-browser/demo/` are small pages served by Vite for manual checks and the Playwright tests; they are not part of the packages.

```sh
npx vite --config providers/stt-transformers/demo/vite.config.mjs --port 24123
npx vite --config providers/llm-browser/demo/vite.config.mjs --port 24124
```
