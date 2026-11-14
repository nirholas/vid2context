/**
 * Doctor checks as pure functions: each takes what was observed (a version
 * string, a command's output, a response body) and returns ok, warn or fail
 * with a fix line. run.ts gathers the observations.
 */
import { Vid2ContextError } from '@vid2context/core';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** How to fix it, when status is not ok. */
  fix?: string;
}

const MIN_NODE = 22;

function firstLine(s: string): string {
  return (
    s
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim() ?? ''
  );
}

export function checkNode(version: string): Check {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  const base = { id: 'node', label: 'Node.js' };
  if (major >= MIN_NODE) return { ...base, status: 'ok', detail: `${version} (${MIN_NODE} or newer required)` };
  return {
    ...base,
    status: 'fail',
    detail: `${version} is too old`,
    fix: `Install Node ${MIN_NODE} or newer (https://nodejs.org, or \`nvm install ${MIN_NODE}\`).`,
  };
}

/** "ffmpeg version 7.0.2-static https://..." -> "7.0.2-static". Same for ffprobe. */
export function parseFfVersion(output: string): string | undefined {
  return /^ff(?:mpeg|probe) version (\S+)/m.exec(output)?.[1];
}

export interface ToolObservation {
  /** Where the binary was found, or undefined. */
  path?: string;
  /** A configured path that is not an executable file. */
  problem?: string;
  /** stdout of the version command, when it ran. */
  output?: string;
}

export interface ToolSpec {
  id: string;
  label: string;
  /** Turn the version command's output into a version string. */
  version: (output: string) => string | undefined;
  /** Status when the tool is missing. */
  missing: 'warn' | 'fail';
  /** What the tool is for, shown when it is missing. */
  purpose: string;
  fix: string;
}

export function checkTool(spec: ToolSpec, obs: ToolObservation): Check {
  const base = { id: spec.id, label: spec.label };
  if (obs.problem) return { ...base, status: 'fail', detail: obs.problem, fix: spec.fix };
  if (!obs.path) return { ...base, status: spec.missing, detail: `not found. ${spec.purpose}`, fix: spec.fix };
  if (obs.output === undefined) {
    return { ...base, status: 'fail', detail: `${obs.path} exists but its version command failed`, fix: spec.fix };
  }
  const version = spec.version(obs.output) ?? 'unknown version';
  return { ...base, status: 'ok', detail: `${version} at ${obs.path}` };
}

export const TOOLS: Record<
  'ffmpeg' | 'ffprobe' | 'ytdlp' | 'deno',
  ToolSpec & { binary: string; envVar?: string; args: string[] }
> = {
  ffmpeg: {
    id: 'ffmpeg',
    label: 'ffmpeg',
    binary: 'ffmpeg',
    envVar: 'FFMPEG_PATH',
    args: ['-version'],
    version: parseFfVersion,
    missing: 'warn',
    purpose: 'Needed to transcribe local files and long audio, and to read frames.',
    fix: 'Install ffmpeg (apt install ffmpeg, brew install ffmpeg, or a static build in ~/.local/bin), or set FFMPEG_PATH.',
  },
  ffprobe: {
    id: 'ffprobe',
    label: 'ffprobe',
    binary: 'ffprobe',
    envVar: 'FFPROBE_PATH',
    args: ['-version'],
    version: parseFfVersion,
    missing: 'warn',
    purpose: 'Reads media durations; ships with ffmpeg.',
    fix: 'Install ffmpeg (ffprobe comes with it), or set FFPROBE_PATH.',
  },
  ytdlp: {
    id: 'yt-dlp',
    label: 'yt-dlp',
    binary: 'yt-dlp',
    envVar: 'YTDLP_PATH',
    args: ['--version'],
    version: (o) => firstLine(o) || undefined,
    missing: 'warn',
    purpose: 'Downloads audio for videos without captions, and covers most non-YouTube sites.',
    fix: 'Install yt-dlp (pipx install yt-dlp, brew install yt-dlp, or the release binary in ~/.local/bin), or set YTDLP_PATH.',
  },
  deno: {
    id: 'deno',
    label: 'deno',
    binary: 'deno',
    args: ['--version'],
    version: (o) => /^deno (\S+)/m.exec(o)?.[1],
    missing: 'warn',
    purpose: 'yt-dlp uses a JavaScript runtime to solve YouTube player challenges.',
    fix: 'Install deno (curl -fsSL https://deno.land/install.sh | sh, or brew install deno).',
  },
};

/** `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader`: one line per GPU, or null when missing. */
export function checkGpu(output: string | null): Check {
  const base = { id: 'gpu', label: 'NVIDIA GPU' };
  const gpus = (output ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (gpus.length) return { ...base, status: 'ok', detail: gpus.join('; ') };
  return {
    ...base,
    status: 'warn',
    detail: output === null ? 'nvidia-smi not found: local speech-to-text and LLMs run on the CPU' : 'nvidia-smi found no GPU',
    fix: 'Optional. Free hosted and keyless rungs work without a GPU; install the NVIDIA driver to speed up local models.',
  };
}

export function checkDataDir(dir: string, error?: string): Check {
  const base = { id: 'data-dir', label: 'Data directory' };
  if (!error) return { ...base, status: 'ok', detail: `${dir} is writable` };
  return {
    ...base,
    status: 'fail',
    detail: `${dir} is not writable: ${error}`,
    fix: 'Fix the directory permissions, or set VID2CONTEXT_HOME to a writable directory.',
  };
}

/** Key names that are set, out of every env var a rung requires. Never values. */
export function checkKeys(setNames: string[], knownNames: string[]): Check {
  const base = { id: 'keys', label: 'Keys' };
  if (setNames.length) {
    return { ...base, status: 'ok', detail: `${setNames.length} of ${knownNames.length} set: ${setNames.join(', ')}` };
  }
  return {
    ...base,
    status: 'ok',
    detail: `none of ${knownNames.length} set: local and keyless rungs only. Free keys (GROQ_API_KEY, GEMINI_API_KEY) unlock faster rungs.`,
  };
}

export interface HttpObservation {
  status?: number;
  body?: string;
  error?: string;
}

/** One GET to the keyless OVH models list. */
export function checkKeyless(obs: HttpObservation, keylessOn: boolean): Check {
  const base = { id: 'keyless', label: 'Keyless hosts' };
  if (!keylessOn) return { ...base, status: 'ok', detail: 'turned off (VID2CONTEXT_KEYLESS=0); not checked' };
  if (obs.error) {
    return {
      ...base,
      status: 'warn',
      detail: `OVH AI Endpoints unreachable: ${obs.error}`,
      fix: 'Check the network or proxy. Without it, keyless speech-to-text is unavailable; local and keyed rungs still work.',
    };
  }
  if (obs.status !== 200) {
    return {
      ...base,
      status: 'warn',
      detail: `OVH AI Endpoints answered HTTP ${obs.status}`,
      fix:
        obs.status === 429 ? 'Rate-limited: wait a minute, or add a free key.' : 'Retry later, or add a free key (GROQ_API_KEY).',
    };
  }
  let count = 0;
  try {
    count = (JSON.parse(obs.body ?? '') as { data?: unknown[] }).data?.length ?? 0;
  } catch {
    return {
      ...base,
      status: 'warn',
      detail: 'OVH AI Endpoints answered with something that is not JSON',
      fix: 'Check for a proxy rewriting responses.',
    };
  }
  return { ...base, status: 'ok', detail: `OVH AI Endpoints reachable (${count} models listed)` };
}

export interface YouTubeObservation {
  /** Caption segments fetched, when the probe worked. */
  segments?: number;
  origin?: string;
  error?: unknown;
  /** True when no YouTube source is installed. */
  notInstalled?: boolean;
}

export const PROBE_VIDEO = 'jNQXAC9IVRw';

export function checkYouTube(obs: YouTubeObservation): Check {
  const base = { id: 'youtube', label: 'YouTube captions' };
  if (obs.notInstalled) {
    return {
      ...base,
      status: 'warn',
      detail: 'no YouTube source provider is installed',
      fix: 'Install @vid2context/provider-youtube.',
    };
  }
  if (obs.error === undefined) {
    return {
      ...base,
      status: 'ok',
      detail: `fetched ${obs.segments ?? 0} ${obs.origin ?? 'caption'} segments for ${PROBE_VIDEO}`,
    };
  }
  const err = obs.error;
  if (err instanceof Vid2ContextError && (err.code === 'blocked' || err.code === 'rate-limited')) {
    return {
      ...base,
      status: 'fail',
      detail: `YouTube is blocking this machine's IP (${err.code}): ${err.message}`,
      fix:
        err.hint ??
        'Datacenter and VPN IPs are often blocked. Run from a residential connection, or use the yt-dlp provider with cookies.',
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    ...base,
    status: 'fail',
    detail: `captions probe failed: ${msg}`,
    fix: err instanceof Vid2ContextError && err.hint ? err.hint : 'Check the network, then run with --verbose.',
  };
}
