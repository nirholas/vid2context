/**
 * Local speech-to-text through whisper.cpp. Node only (spawns processes).
 *
 *   rung     stt/whisper-cpp/<model>, tier local, enabled when WHISPER_CPP_MODEL is set
 *   order    before other local rungs when setup found a GPU (WHISPER_CPP_GPU=1), after them otherwise
 *   setup    npx tsx providers/stt-whisper-cpp/src/setup.ts (installs the binary, downloads a verified model)
 *
 * isEnabled reads env only; paths are checked when a transcription runs, and
 * a missing binary or model fails with a hint that names the setup command.
 */
import { defineProvider, type Env, type SttProvider, type SttRung } from '@vid2context/core';
import { isEnglishOnly, modelNameOf, qualityOf } from './models.ts';
import { isTruthy, transcribeWhisperCpp } from './whisper.ts';

export { type DetectOptions, describeHardware, detectHardware, type GpuInfo, type GpuVendor, type Hardware } from './hardware.ts';
export { type BuildInfo, installWhisperCpp, planInstall } from './install.ts';
export { downloadModel, MODEL_NAMES, MODEL_SIZES, recommendModel, resolveModel } from './models.ts';
export { resolveBinary, resolveFfmpeg } from './paths.ts';
export { stopManagedServers } from './server.ts';
export { transcribeWhisperCpp, type WhisperCppOptions, type WhisperCppResult } from './whisper.ts';

/** Priority within the local tier. The OpenAI-compatible local rung sits at 10. */
export const GPU_PRIORITY = 5;
export const CPU_PRIORITY = 20;

export function whisperCppRungs(env: Env): SttRung[] {
  const value = env.WHISPER_CPP_MODEL?.trim() ?? '';
  const model = value ? modelNameOf(value) : '';
  const english = isEnglishOnly(model);
  return [
    {
      id: model ? `stt/whisper-cpp/${model}` : 'stt/whisper-cpp',
      provider: 'stt-whisper-cpp',
      service: 'whisper-cpp',
      model,
      tier: 'local',
      priority: isTruthy(env.WHISPER_CPP_GPU) ? GPU_PRIORITY : CPU_PRIORITY,
      quality: qualityOf(model),
      capabilities: english ? ['segments', 'prompt'] : ['segments', 'language-detect', 'prompt', 'translate'],
      requires: ['WHISPER_CPP_MODEL'],
      isEnabled: (e) => Boolean(e.WHISPER_CPP_MODEL?.trim()),
      transcribe: (audio, opts, ctx) => transcribeWhisperCpp(audio, opts, ctx),
    },
  ];
}

const provider: SttProvider = defineProvider({
  id: 'stt-whisper-cpp',
  kind: 'stt',
  name: 'whisper.cpp (local speech-to-text)',
  runtimes: ['node'],
  rungs: whisperCppRungs,
});

export default provider;
