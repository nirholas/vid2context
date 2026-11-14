/**
 * Speaker naming. Diarization gives anonymous labels ("Speaker 0",
 * "Speaker A"); this asks the free-first LLM chain who each label is, then
 * keeps a name only when the model quotes transcript text that really exists
 * near the cited time and the name appears in the video itself. Anything
 * weaker leaves the label anonymous. The input context is never mutated; the
 * caller gets a copy with confidently named labels replaced.
 */
import {
  type Attempt,
  type ChainOptions,
  type Ctx,
  chat,
  type Registry,
  type Segment,
  type VideoContext,
  Vid2ContextError,
} from '@vid2context/core';
import { DEFAULT_TOLERANCE_SEC, isPlausibleName, nameIsGrounded, quoteAppearsNear } from './evidence.ts';
import { buildSpeakerMessages, SPEAKER_SCHEMA, type SampleOptions, sampleTurns, speakerLabels, speakerTurns } from './prompt.ts';

export { isPlausibleName, nameIsGrounded, nameTokens, normalizeText, quoteAppearsNear } from './evidence.ts';
export {
  buildSpeakerMessages,
  hasNamingCue,
  SPEAKER_SCHEMA,
  type SampleOptions,
  sampleTurns,
  speakerLabels,
  speakerTurns,
  type Turn,
} from './prompt.ts';

export interface SpeakerEvidence {
  quote: string;
  startSec: number;
}

export interface SpeakerMapping {
  /** The diarization label, e.g. "Speaker 0". */
  label: string;
  /** The accepted name, or null when the evidence did not hold up. */
  name: string | null;
  /** The model's confidence, 0..1 (0 when it gave none). */
  confidence: number;
  /** Quotes that were verified against the transcript. */
  evidence: SpeakerEvidence[];
}

export interface NameSpeakersOptions extends SampleOptions {
  /** Names below this confidence are not applied. Default 0.7. */
  minConfidence?: number;
  /** How far (seconds) from the cited time a quote may be found. Default 30. */
  toleranceSec?: number;
  /** LLM chain options. Paid rungs are excluded unless this sets allowPaid: true. */
  chain?: ChainOptions;
  maxTokens?: number;
}

export interface NameSpeakersResult {
  mapping: SpeakerMapping[];
  /** A copy of the input with named labels replaced in transcript segments. */
  context: VideoContext;
  /** The LLM rung that answered, when one was called. */
  rung?: string;
  attempts: Attempt[];
}

interface RawEntry {
  label?: unknown;
  name?: unknown;
  confidence?: unknown;
  evidence?: unknown;
}

/** Parse the model's JSON, tolerating code fences and text around the object. */
export function parseSpeakerJson(text: string): RawEntry[] {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Vid2ContextError('upstream', 'The model did not return a JSON object for speaker naming.', {
      hint: 'Retry, or pick a stronger model with chain options (for example only: ["groq"]).',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch (err) {
    throw new Vid2ContextError('upstream', 'The model returned malformed JSON for speaker naming.', {
      hint: 'Retry, or pick a stronger model with chain options (for example only: ["groq"]).',
      cause: err,
    });
  }
  const list = (parsed as { speakers?: unknown }).speakers;
  return Array.isArray(list) ? (list as RawEntry[]) : [];
}

function labelKey(label: string): string {
  return label.trim().toLowerCase().replace(/^speaker\s*/, '');
}

/**
 * Apply the evidence rule to the model's answer. Exported so a caller with
 * its own model output can run the same checks.
 */
export function validateSpeakerNames(
  entries: RawEntry[],
  context: VideoContext,
  opts: { minConfidence?: number; toleranceSec?: number } = {},
): SpeakerMapping[] {
  const minConfidence = opts.minConfidence ?? 0.7;
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const segments = context.transcript.segments;
  const byKey = new Map<string, RawEntry>();
  for (const e of entries) if (typeof e.label === 'string') byKey.set(labelKey(e.label), e);

  const mapping = speakerLabels(segments).map((label): SpeakerMapping => {
    const e = byKey.get(labelKey(label));
    const rawConf = typeof e?.confidence === 'number' && Number.isFinite(e.confidence) ? e.confidence : 0;
    const confidence = Math.min(1, Math.max(0, rawConf));
    const evidence: SpeakerEvidence[] = (Array.isArray(e?.evidence) ? e.evidence : [])
      .map((x: unknown) => x as { quote?: unknown; startSec?: unknown })
      .filter((x): x is SpeakerEvidence => typeof x.quote === 'string' && typeof x.startSec === 'number')
      .filter((x) => quoteAppearsNear(segments, x.quote, x.startSec, tolerance))
      .map((x) => ({ quote: x.quote.trim(), startSec: x.startSec }));
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    const accepted =
      name !== '' &&
      isPlausibleName(name) &&
      confidence >= minConfidence &&
      evidence.length > 0 &&
      nameIsGrounded(name, segments, context.metadata);
    return { label, name: accepted ? name : null, confidence, evidence };
  });

  // One name, one label: when two labels claim the same person, keep the more confident one.
  const best = new Map<string, SpeakerMapping>();
  for (const m of mapping) {
    if (!m.name) continue;
    const k = m.name.toLowerCase();
    const prev = best.get(k);
    if (!prev || m.confidence > prev.confidence) best.set(k, m);
  }
  return mapping.map((m) => (m.name && best.get(m.name.toLowerCase()) !== m ? { ...m, name: null } : m));
}

/** A copy of the context with named labels replaced. The input is untouched. */
export function applySpeakerNames(context: VideoContext, mapping: SpeakerMapping[]): VideoContext {
  const names = new Map(mapping.filter((m) => m.name).map((m) => [m.label, m.name as string]));
  const segments: Segment[] = context.transcript.segments.map((s) =>
    s.speaker && names.has(s.speaker) ? { ...s, speaker: names.get(s.speaker) } : { ...s },
  );
  return { ...context, transcript: { ...context.transcript, segments } };
}

/**
 * Map anonymous diarization labels to real names. Labels whose name is not
 * backed by a verified quote stay as they are.
 */
export async function nameSpeakers(
  context: VideoContext,
  registry: Registry,
  ctx: Ctx,
  opts: NameSpeakersOptions = {},
): Promise<NameSpeakersResult> {
  const segments = context.transcript.segments;
  const labels = speakerLabels(segments);
  if (labels.length === 0) return { mapping: [], context: applySpeakerNames(context, []), attempts: [] };

  const sample = sampleTurns(speakerTurns(segments), opts);
  const messages = buildSpeakerMessages(context, sample, labels);
  const res = await chat(
    registry,
    { messages, json: { schema: SPEAKER_SCHEMA, name: 'speakers' }, temperature: 0, maxTokens: opts.maxTokens ?? 2000 },
    { allowPaid: false, ...opts.chain },
    ctx,
  );
  const mapping = validateSpeakerNames(parseSpeakerJson(res.text), context, opts);
  for (const m of mapping) {
    ctx.log.debug('speaker naming', { label: m.label, name: m.name, confidence: m.confidence, evidence: m.evidence.length });
  }
  return { mapping, context: applySpeakerNames(context, mapping), rung: res.rung, attempts: res.attempts };
}
