/**
 * Elicitation: ask the user mid-call through the client.
 *
 * choose_caption_track lists a video's caption tracks and, when there is a
 * real choice, asks the user which one to use. confirmExpensive asks before
 * slow or costly work (speech-to-text on long audio) and is exported for the
 * base tools.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type CaptionsProvider,
  type CaptionTrackInfo,
  type Ctx,
  type Env,
  type Registry,
  render,
  Vid2ContextError,
  type VideoContext,
  type VideoMetadata,
} from '@vid2context/core';
import type { Extra } from './digest.ts';
import { clientSupportsElicitation, contextHeader, depsOf, type ToolResult, text, toolError } from './shared.ts';

export const DEFAULT_CONFIRM_STT_MINUTES = 20;

export interface TrackOption {
  /** Stable value sent back by the client: `<language>:<creator|auto|native>`. */
  value: string;
  /** What the user sees, e.g. "English (auto-generated)". */
  label: string;
  track: CaptionTrackInfo;
}

const ORIGIN_KEY: Record<CaptionTrackInfo['origin'], string> = {
  'creator-captions': 'creator',
  'auto-captions': 'auto',
  'native-transcript': 'native',
};

/** One option per track, with unique values and labels. */
export function trackOptions(tracks: CaptionTrackInfo[]): TrackOption[] {
  const out: TrackOption[] = [];
  for (const track of tracks) {
    const base = `${track.language}:${ORIGIN_KEY[track.origin]}`;
    let value = base;
    for (let n = 2; out.some((o) => o.value === value); n++) value = `${base}:${n}`;
    let label = track.name || track.language;
    if (track.origin === 'auto-captions' && !/auto/i.test(label)) label = `${label} (auto-generated)`;
    if (out.some((o) => o.label === label)) label = `${label} [${track.language}]`;
    out.push({ value, label, track });
  }
  return out;
}

function trackList(title: string, url: string, options: TrackOption[], note: string): string {
  const lines = [
    `"${title}" has ${options.length} caption track${options.length === 1 ? '' : 's'}:`,
    ...options.map((o) => `- ${o.track.language}: ${o.label} (${o.track.origin}${o.track.translatable ? ', translatable' : ''})`),
    '',
    note,
    `To read one, call get_transcript with {"url": ${JSON.stringify(url)}, "language": "<code>"}.`,
  ];
  return lines.join('\n');
}

async function fetchTrack(
  provider: CaptionsProvider,
  metadata: VideoMetadata,
  option: TrackOption,
  ctx: Ctx,
): Promise<ToolResult> {
  const { track } = option;
  const transcript = await provider.getCaptions(
    metadata.ref,
    { language: track.language, allowAuto: track.origin === 'auto-captions', allowTranslated: false },
    ctx,
  );
  if (!transcript || transcript.segments.length === 0) {
    return toolError(
      new Vid2ContextError('no-transcript', `The "${option.label}" track returned no captions.`, {
        hint: 'Pick another track, or call get_transcript with mode "stt" to transcribe the audio.',
      }),
    );
  }
  const context: VideoContext = {
    metadata,
    transcript,
    attempts: [{ id: provider.id, stage: 'captions', outcome: 'ok', detail: `${track.language} ${transcript.origin}` }],
  };
  // The captions provider prefers creator captions in a language; say so when it served another kind than chosen.
  const note =
    transcript.origin !== track.origin
      ? `Note: you chose "${option.label}", but the captions provider served the ${transcript.origin} track in ${transcript.language}.\n\n`
      : '';
  return text(note + contextHeader(context) + render(context, 'text', { timestamps: true }));
}

export async function chooseCaptionTrack(
  server: McpServer,
  registry: Registry,
  url: string,
  ctx: Ctx,
  extra: Extra,
): Promise<ToolResult> {
  const { source, ref } = registry.resolve(url);
  if (ref.kind !== 'video') {
    throw new Vid2ContextError('unsupported-input', `"${url}" is a ${ref.kind}, not a single video.`, {
      hint: 'Pass one video URL.',
    });
  }
  const provider = registry.captions().find((p) => p.supports(ref) && p.listTracks);
  if (!provider?.listTracks) {
    throw new Vid2ContextError('no-provider', `No installed captions provider can list tracks for ${ref.platform}.`, {
      hint: 'Call get_transcript instead; it picks the best available transcript or transcribes the audio.',
    });
  }
  const [tracks, metadata] = await Promise.all([
    provider.listTracks(ref, ctx),
    source.getMetadata(ref, ctx).catch((err: unknown): VideoMetadata => {
      ctx.log.warn('metadata failed, using a minimal header', { error: err instanceof Error ? err.message : String(err) });
      return { ref, title: ref.url ?? ref.input, chapters: [] };
    }),
  ]);
  const options = trackOptions(tracks);
  const link = ref.url ?? url;

  if (options.length === 0) {
    return text(
      `"${metadata.title}" has no caption tracks. Call get_transcript with {"url": ${JSON.stringify(link)}, "mode": "stt"} to transcribe the audio.`,
    );
  }
  const only = options[0];
  if (options.length === 1 && only) return fetchTrack(provider, metadata, only, ctx);

  if (!clientSupportsElicitation(server)) {
    return text(trackList(metadata.title, link, options, 'This client cannot show a picker (no MCP elicitation support).'));
  }

  const res = await server.server.elicitInput(
    {
      mode: 'form',
      message: `"${metadata.title}" has ${options.length} caption tracks. Which one should vid2context use?`,
      requestedSchema: {
        type: 'object',
        properties: {
          track: {
            type: 'string',
            title: 'Caption track',
            oneOf: options.map((o) => ({ const: o.value, title: o.label })),
          },
        },
        required: ['track'],
      },
    },
    { signal: extra.signal, relatedRequestId: extra.requestId },
  );
  if (res.action !== 'accept') {
    return text(trackList(metadata.title, link, options, `The user ${res.action === 'decline' ? 'declined' : 'dismissed'} the picker.`));
  }
  const chosen = options.find((o) => o.value === res.content?.track);
  if (!chosen) {
    return text(trackList(metadata.title, link, options, `The picker returned an unknown track (${String(res.content?.track)}).`));
  }
  return fetchTrack(provider, metadata, chosen, ctx);
}

/** The confirmation threshold in minutes from VID2CONTEXT_CONFIRM_STT_MINUTES (default 20; 0 always asks). */
export function confirmThresholdMinutes(env: Env): number {
  const raw = env.VID2CONTEXT_CONFIRM_STT_MINUTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONFIRM_STT_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIRM_STT_MINUTES;
}

/**
 * Ask the user before expensive work, such as speech-to-text on long audio.
 *
 * - `accept`: below the threshold (no question asked), or the user confirmed.
 * - `decline`: the user said no or dismissed the question.
 * - `unsupported`: the client has no elicitation support; the caller decides
 *   (for example, go ahead and say how long it will take).
 *
 * The threshold comes from VID2CONTEXT_CONFIRM_STT_MINUTES in `opts.env`, else
 * in the ctx.env given to registerAgenticFeatures for this server. Pass the
 * tool call's `extra` so the question travels on that call's stream (needed
 * for Streamable HTTP) and is cancelled with it.
 */
export async function confirmExpensive(
  server: McpServer,
  opts: { message: string; estimateMinutes: number; env?: Env; extra?: Pick<Extra, 'signal' | 'requestId'> },
): Promise<'accept' | 'decline' | 'unsupported'> {
  const env = opts.env ?? depsOf(server)?.ctx.env ?? {};
  if (opts.estimateMinutes < confirmThresholdMinutes(env)) return 'accept';
  if (!clientSupportsElicitation(server)) return 'unsupported';
  const minutes = Math.round(opts.estimateMinutes);
  const res = await server.server.elicitInput(
    {
      mode: 'form',
      message: `${opts.message} (about ${minutes} minute${minutes === 1 ? '' : 's'} of audio)`,
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean', title: 'Go ahead', default: true } },
        required: ['confirm'],
      },
    },
    opts.extra ? { signal: opts.extra.signal, relatedRequestId: opts.extra.requestId } : undefined,
  );
  return res.action === 'accept' && res.content?.confirm !== false ? 'accept' : 'decline';
}
