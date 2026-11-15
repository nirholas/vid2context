/**
 * Vision-model rungs that read one frame over an OpenAI-compatible
 * /chat/completions API with an image data URL (runtime-neutral, plain fetch).
 *
 *   local    Ollama (OLLAMA_VISION_MODEL, e.g. qwen2.5vl or llava)
 *   free     Gemini AI Studio (GEMINI_API_KEY, GEMINI_VISION_MODEL), one rung per pooled key
 *   keyless  OVH AI Endpoints Qwen2.5-VL-72B-Instruct (OVH_VISION_MODEL), no account
 *
 * Every rung asks for one JSON object: a `kind` and the on-screen `text`
 * copied exactly (code verbatim, tables as Markdown), or a one-line
 * `description` when the frame has no text.
 */
import {
  type Ctx,
  type Env,
  errorFromResponse,
  fetchWithTimeout,
  keyPool,
  pooledService,
  type Tier,
  Vid2ContextError,
  type VisualNote,
  type VisualRung,
} from '@vid2context/core';
import { takeSlot } from './throttle.ts';

export const PROVIDER_ID = 'visual-frames';

export interface Frame {
  data: Uint8Array;
  mimeType: string;
  atSec: number;
}

export const VISION_PROMPT = `You read one frame of a video and copy the text shown on screen.
Reply with a single JSON object with exactly these keys:
"kind": one of "slide", "code", "chart", "ocr", "description".
"text": every readable piece of on-screen text, copied exactly as shown and in its original language. Keep line breaks. Copy code, terminal output and markup verbatim with indentation. Write tables as Markdown tables. For a chart, copy its title, axis labels, tick values and legend.
"description": one short line describing the picture, only when "text" is empty; otherwise "".
Kinds: "slide" is a presentation slide or title card; "code" is source code, a terminal or markup; "chart" is a chart, graph or diagram; "ocr" is any other readable text (web pages, documents, interfaces, signs); "description" means there is no readable text.
Ignore subtitles burned into the bottom of the picture (they repeat the spoken audio) and small logos or watermarks. Never translate, summarize or add text that is not visible.`;

/** "1:05" or "1:02:03" for the user message, so the model knows where it is. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Base64 without Node's Buffer, chunked so large frames do not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function dataUrl(frame: Pick<Frame, 'data' | 'mimeType'>): string {
  return `data:${frame.mimeType};base64,${toBase64(frame.data)}`;
}

export interface VisionEndpoint {
  url: string;
  model: string;
  key?: string;
  label: string;
  /** Send response_format json_object. */
  jsonMode: boolean;
  timeoutMs: number;
  /** Minimum spacing between requests from this rung, in ms (0 = none). */
  intervalMs: number;
}

export function buildVisionBody(ep: Pick<VisionEndpoint, 'model' | 'jsonMode'>, frame: Frame): Record<string, unknown> {
  return {
    model: ep.model,
    messages: [
      { role: 'system', content: VISION_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Frame at ${clock(frame.atSec)}. Reply with the JSON object.` },
          { type: 'image_url', image_url: { url: dataUrl(frame) } },
        ],
      },
    ],
    max_tokens: 2000,
    temperature: 0,
    ...(ep.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}

interface CompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | { type?: string; text?: string }[] | null }; finish_reason?: string }[];
}

/** The answer text: content parts joined, inline <think> blocks removed. */
export function answerText(res: CompletionResponse): string {
  const content = res.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : '';
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Parse the first JSON object in a reply, tolerating code fences and text around it. Null when there is none. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  for (const candidate of [unfenced, unfenced.slice(unfenced.indexOf('{'), unfenced.lastIndexOf('}') + 1)]) {
    if (!candidate.startsWith('{')) continue;
    try {
      const v: unknown = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const KIND_ALIASES: Record<string, VisualNote['kind']> = {
  slide: 'slide',
  slides: 'slide',
  title: 'slide',
  'title card': 'slide',
  presentation: 'slide',
  code: 'code',
  terminal: 'code',
  markup: 'code',
  console: 'code',
  chart: 'chart',
  graph: 'chart',
  plot: 'chart',
  diagram: 'chart',
  table: 'slide',
  ocr: 'ocr',
  text: 'ocr',
  document: 'ocr',
  webpage: 'ocr',
  'web page': 'ocr',
  screenshot: 'ocr',
  ui: 'ocr',
  description: 'description',
  none: 'description',
  photo: 'description',
  image: 'description',
};

/** Map a model's kind to a VisualNote kind. Unknown kinds become `ocr` when there is text, else `description`. */
export function mapKind(raw: unknown, hasText: boolean): VisualNote['kind'] {
  const k = typeof raw === 'string' ? KIND_ALIASES[raw.trim().toLowerCase()] : undefined;
  if (!hasText) return 'description';
  if (!k || k === 'description') return 'ocr';
  return k;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Turn a parsed reply into notes: one for the text, or one description when there is no text. */
export function notesFromReply(obj: Record<string, unknown>, atSec: number, producer: string): VisualNote[] {
  const text = str(obj.text);
  if (text) return [{ atSec, kind: mapKind(obj.kind, true), text, producer }];
  const description = str(obj.description);
  if (description) return [{ atSec, kind: 'description', text: description, producer }];
  return [];
}

export async function readWithVision(ep: VisionEndpoint, rungId: string, frame: Frame, ctx: Ctx): Promise<VisualNote[]> {
  takeSlot(rungId, ep.intervalMs, ep.label);
  const res = await fetchWithTimeout(
    ctx,
    ep.url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ep.key ? { authorization: `Bearer ${ep.key}` } : {}) },
      body: JSON.stringify(buildVisionBody(ep, frame)),
    },
    ep.timeoutMs,
  );
  if (!res.ok) throw await errorFromResponse(res, `${ep.label} vision`);
  const json = (await res.json()) as CompletionResponse;
  const text = answerText(json);
  if (!text) {
    const reason = json.choices?.[0]?.finish_reason;
    throw new Vid2ContextError('upstream', `${ep.label} vision: empty answer${reason ? ` (finish_reason ${reason})` : ''}.`);
  }
  const obj = parseJsonObject(text);
  if (!obj) throw new Vid2ContextError('upstream', `${ep.label} vision: the reply was not a JSON object: ${text.slice(0, 120)}`);
  return notesFromReply(obj, frame.atSec, rungId);
}

// ---------------------------------------------------------------- lanes

interface Lane {
  service: string;
  tier: Tier;
  priority: number;
  quality: number;
  url: (env: Env) => string;
  /** Env var holding a comma-separated model list. */
  modelVar: string;
  defaultModels: string[];
  /**
   * For lanes with no default model that the user opts into by setting
   * `modelVar`: the model named in the disabled rung's id until then, so the
   * id stays a valid `visual/<service>/<model>` and points at a sensible pick.
   */
  optInModel?: string;
  /** Env var with the key; each pooled key becomes its own rung. */
  keyVar?: string;
  /** Env var overriding the request spacing in seconds. */
  intervalVar?: string;
  defaultIntervalSec: number;
  jsonMode: boolean;
  timeoutMs: number;
}

export const OVH_CHAT_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
export const GEMINI_CHAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

export const LANES: Lane[] = [
  {
    service: 'ollama',
    tier: 'local',
    priority: 10,
    quality: 3,
    url: (env) => `${(env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '')}/chat/completions`,
    modelVar: 'OLLAMA_VISION_MODEL',
    // Off until OLLAMA_VISION_MODEL is set: only the user knows which models they pulled.
    defaultModels: [],
    optInModel: 'qwen2.5vl',
    defaultIntervalSec: 0,
    jsonMode: true,
    // Vision models on a CPU can take minutes per frame.
    timeoutMs: 600_000,
  },
  {
    service: 'gemini',
    tier: 'free',
    priority: 10,
    quality: 4,
    url: () => GEMINI_CHAT_URL,
    modelVar: 'GEMINI_VISION_MODEL',
    defaultModels: ['gemini-2.5-flash-lite'],
    keyVar: 'GEMINI_API_KEY',
    intervalVar: 'GEMINI_VISION_INTERVAL_SEC',
    defaultIntervalSec: 4,
    jsonMode: true,
    timeoutMs: 120_000,
  },
  {
    service: 'ovh',
    tier: 'keyless',
    priority: 10,
    quality: 4,
    url: () => OVH_CHAT_URL,
    modelVar: 'OVH_VISION_MODEL',
    defaultModels: ['Qwen2.5-VL-72B-Instruct'],
    intervalVar: 'OVH_VISION_INTERVAL_SEC',
    defaultIntervalSec: 30,
    jsonMode: true,
    timeoutMs: 180_000,
  },
];

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function intervalMs(lane: Lane, env: Env): number {
  const raw = lane.intervalVar ? env[lane.intervalVar] : undefined;
  const n = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Math.round((Number.isFinite(n) && n >= 0 ? n : lane.defaultIntervalSec) * 1000);
}

/** Every vision rung the env describes, enabled or not (a keyed lane without a key yields one disabled rung). */
export function visionRungs(env: Env): VisualRung[] {
  const out: VisualRung[] = [];
  for (const lane of LANES) {
    const override = list(env[lane.modelVar]);
    const models = override.length > 0 ? override : lane.defaultModels;
    // Opt-in lanes have no default model: they appear disabled, named after optInModel, until the model var is set.
    const shown = models.length > 0 ? models : lane.optInModel ? [lane.optInModel] : [];
    const keys = lane.keyVar ? keyPool(env, lane.keyVar) : [];
    const slots = lane.keyVar ? (keys.length > 0 ? keys : [undefined]) : [undefined];
    for (const [mi, model] of shown.entries()) {
      for (const k of slots) {
        const service = k ? pooledService(lane.service, k.index) : lane.service;
        const id = `visual/${service}/${model}`;
        const enabled = models.length > 0 && (!lane.keyVar || Boolean(k));
        const ep: VisionEndpoint = {
          url: lane.url(env),
          model,
          key: k?.key,
          label: service,
          jsonMode: lane.jsonMode,
          timeoutMs: lane.timeoutMs,
          intervalMs: intervalMs(lane, env),
        };
        out.push({
          id,
          provider: PROVIDER_ID,
          service,
          model,
          tier: lane.tier,
          priority: lane.priority + mi + (k?.index ?? 0),
          quality: lane.quality,
          capabilities: ['vision', 'json'],
          requires: [...(lane.keyVar ? [lane.keyVar] : []), ...(lane.defaultModels.length === 0 ? [lane.modelVar] : [])],
          isEnabled: () => enabled,
          read: (frame, ctx) => readWithVision(ep, id, frame, ctx),
        });
      }
    }
  }
  return out;
}
