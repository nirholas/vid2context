/**
 * Prompt text and prompt builders.
 *
 * Agent-side synthesis is the default: briefPrompt() and extractPrompt()
 * return messages the calling agent follows with its own model, so a brief
 * costs nothing extra. The MCP `brief` and `buyer_guide` prompts (item 44)
 * import briefInstructions() and buyerGuideInstructions() from here.
 *
 * The server-side map, reduce and extract prompts used by buildBrief() and
 * extract() are exported too, so their wording is visible and testable.
 */
import { type ChatMessage, estimateTokens, formatTimestamp, UNTRUSTED_SYSTEM_PROMPT, type VideoContext } from '@vid2context/core';
import { assertSupportedSchema, type JsonSchema } from './schema.ts';
import { renderSource, type Source, type SourceSet, sourceSet } from './sources.ts';
import { getTemplate, type Template } from './templates/index.ts';

/** How agents cite. Every claim in an agent-written brief must follow this. */
export const CITATION_RULE =
  'Cite every claim as [Video title @ m:ss](timestamp link), where m:ss is the start of the transcript line the claim comes from ' +
  'and the link is the source\'s "Timestamp link" with <seconds> replaced by that time in whole seconds (1:23 is 83). ' +
  'Put the citation right after the claim. A claim you cannot cite this way does not go in the brief.';

/** Consensus, disagreement and single-source rules shared by agent and server prompts. */
export const AGREEMENT_RULES = [
  'Mark a point as consensus only when two or more different videos make it; name each video.',
  'When videos contradict each other, show it as a disagreement and cite every side.',
  'Label claims that only one video makes as single-source.',
  'Videos from the same channel or series still count as separate videos, but say when all support comes from one channel.',
].join(' ');

export interface BriefInstructionOptions {
  question?: string;
  template?: string;
  /** Wording for the buyer guide: what is being bought. */
  product?: string;
}

/**
 * The brief instructions alone, without sources: for the MCP `brief` prompt,
 * where the agent fetches the sources itself with get_outline, get_section
 * and search_transcript.
 */
export function briefInstructions(opts: BriefInstructionOptions = {}): string {
  const t = getTemplate(opts.template);
  const parts = [
    opts.question ? `Question: ${opts.question}` : 'Task: write a cited brief covering what the videos say.',
    opts.product ? `Product: ${opts.product}` : '',
    t.instructions,
    '## Citations',
    CITATION_RULE,
    '## Agreement',
    AGREEMENT_RULES,
    '## Output',
    `Write Markdown: a title, ${opts.question ? 'the question and a direct answer, ' : ''}one section per topic (consensus first, then disagreements with both sides cited, then single-source claims), a sources table (title, channel, length, link), and a short list of what the videos did not cover.`,
    'Transcripts are auto-generated or creator captions and may mishear names and numbers; when a number looks wrong, say so instead of correcting it silently.',
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** The buyer-guide prompt text for the MCP `buyer_guide` prompt. */
export function buyerGuideInstructions(product: string, question?: string): string {
  return briefInstructions({ template: 'buyer-guide', product, question });
}

export interface PromptOptions {
  question?: string;
  template?: string;
  /** Token budget for the source text. Sources that do not fit are listed by name, with a note to fetch them with tools. */
  maxTokens?: number;
}

interface PackedSources {
  blocks: string[];
  omitted: Source[];
  truncated?: { source: Source; atSec: number };
}

/** Whole sources in order while they fit the budget; the first one is cut at a line boundary if even it does not fit. */
function packSources(set: SourceSet, maxTokens: number | undefined): PackedSources {
  const out: PackedSources = { blocks: [], omitted: [] };
  let used = 0;
  for (const s of set.sources) {
    const { block } = renderSource(s, { style: 'clock' });
    const t = estimateTokens(block);
    if (maxTokens === undefined || used + t <= maxTokens) {
      out.blocks.push(block);
      used += t;
      continue;
    }
    if (out.blocks.length === 0) {
      const lines = [];
      let lt = 200;
      for (const l of s.lines) {
        lt += estimateTokens(l.text) + 4;
        if (lt > maxTokens) break;
        lines.push(l);
      }
      if (lines.length > 0) {
        out.blocks.push(renderSource(s, { style: 'clock', lines }).block);
        out.truncated = { source: s, atSec: s.lines[lines.length]?.startSec ?? 0 };
        used = maxTokens;
        continue;
      }
    }
    out.omitted.push(s);
  }
  return out;
}

function omittedNote(p: PackedSources): string {
  const rows: string[] = [];
  if (p.truncated) {
    rows.push(
      `Source ${p.truncated.source.label} (${p.truncated.source.summary.videoId}) is cut at ${formatTimestamp(p.truncated.atSec)} to fit the budget; read the rest with get_section before writing about it.`,
    );
  }
  if (p.omitted.length > 0) {
    rows.push(
      'These sources did not fit the budget. Read them with get_outline, then get_section or search_transcript, before writing:',
      ...p.omitted.map((s) => `- ${s.label}: ${s.summary.videoId} (${s.summary.url ?? 'no url'})`),
    );
  }
  return rows.join('\n');
}

function systemFor(role: string): string {
  return `${role}\n\n${UNTRUSTED_SYSTEM_PROMPT}`;
}

/**
 * Messages for the calling agent to write a cited brief from these videos:
 * the sources as fenced, timestamped transcripts, the citation rule and the
 * agreement rules.
 */
export function briefPrompt(contexts: VideoContext[], opts: PromptOptions = {}): ChatMessage[] {
  const set = sourceSet(contexts);
  const packed = packSources(set, opts.maxTokens);
  const user = [
    briefInstructions({ question: opts.question, template: opts.template }),
    '## Sources',
    `${set.sources.length} video${set.sources.length === 1 ? '' : 's'}. Each transcript line starts with its time as [m:ss].`,
    ...packed.blocks,
    omittedNote(packed),
  ];
  return [
    {
      role: 'system',
      content: systemFor('You write research briefs from video transcripts. Every claim you write is cited to a video and a timestamp.'),
    },
    { role: 'user', content: user.filter(Boolean).join('\n\n') },
  ];
}

export interface ExtractPromptOptions {
  template?: string;
  schema?: JsonSchema;
  question?: string;
  maxTokens?: number;
}

/** The schema an extraction must match: the template's, or a custom schema wrapped with a citations list. */
export function extractionSchema(opts: { template?: string; schema?: JsonSchema }): { schema: JsonSchema; template?: Template } {
  if (opts.schema !== undefined) {
    assertSupportedSchema(opts.schema);
    return {
      schema: {
        type: 'object',
        properties: {
          data: opts.schema,
          citations: {
            type: 'array',
            description: 'One entry per extracted fact: where in data it is (JSON pointer) and where in a video it comes from',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'JSON pointer into data, for example /items/0/price' },
                videoId: { type: 'string' },
                startSec: { type: ['number', 'string'] },
                quote: { type: 'string' },
              },
              required: ['path', 'videoId', 'startSec', 'quote'],
              additionalProperties: false,
            },
          },
        },
        required: ['data', 'citations'],
        additionalProperties: false,
      },
    };
  }
  const template = getTemplate(opts.template, 'summary');
  return { schema: template.schema, template };
}

export const EXTRACT_CITATION_RULE =
  'Every citation object is {"videoId": "<source label such as V1>", "startSec": <the number in brackets at the start of the line the quote begins on>, ' +
  '"quote": "<8 to 30 words copied exactly, in order, from that line and the lines right after it>"}. ' +
  'Quotes are checked against the transcript; items whose quotes cannot be found are removed.';

function extractTask(opts: { template?: Template; schema: JsonSchema; question?: string; custom: boolean }): string {
  return [
    opts.question ? `Question: ${opts.question}` : '',
    opts.template ? opts.template.instructions : '## Extraction\n\nFill the "data" object from the videos and list one citation per fact in "citations".',
    '## Citations',
    EXTRACT_CITATION_RULE,
    '## Output',
    'Reply with one JSON object that matches this JSON Schema exactly (no Markdown, no comments):',
    JSON.stringify(opts.schema),
    'Use only what the videos say. Leave lists empty and optional fields out when the videos do not cover them.',
    opts.custom ? '' : 'Keep every item\'s "sources" list: at least one citation per item.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Messages for structured extraction: the agent (or extract()) answers with
 * JSON matching the template's schema or the custom schema, citing quotes.
 * Lines are tagged with whole seconds so citations carry exact times.
 */
export function extractPrompt(contexts: VideoContext[], opts: ExtractPromptOptions = {}): ChatMessage[] {
  const { schema, template } = extractionSchema(opts);
  const set = sourceSet(contexts);
  return extractMessages(set.sources, { schema, template, question: opts.question, custom: opts.schema !== undefined });
}

export function extractMessages(
  sources: Source[],
  opts: { schema: JsonSchema; template?: Template; question?: string; custom: boolean; parts?: Map<Source, { lines: Source['lines']; index: number; total: number }> },
): ChatMessage[] {
  const blocks = sources.map((s) => {
    const p = opts.parts?.get(s);
    return renderSource(s, { style: 'seconds', lines: p?.lines, part: p ? { index: p.index, total: p.total } : undefined }).block;
  });
  return [
    { role: 'system', content: systemFor('You extract structured, cited facts from video transcripts and reply with JSON only.') },
    {
      role: 'user',
      content: [
        extractTask(opts),
        '## Sources',
        'Each transcript line starts with its start time in whole seconds, in square brackets.',
        ...blocks,
      ].join('\n\n'),
    },
  ];
}

// ---------------------------------------------------------------- server-side brief

export const MAP_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          quote: { type: 'string' },
          videoId: { type: 'string' },
          startSec: { type: ['number', 'string'] },
          topic: { type: 'string' },
          stance: { type: 'string' },
        },
        required: ['claim', 'quote', 'videoId', 'startSec', 'topic'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
};

const POINT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    statement: { type: 'string' },
    support: { type: 'array', items: { type: 'string' } },
    counter: { type: 'string' },
    oppose: { type: 'array', items: { type: 'string' } },
  },
  required: ['statement', 'support'],
  additionalProperties: false,
};

export const REDUCE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: { topic: { type: 'string' }, points: { type: 'array', items: POINT_SCHEMA } },
        required: ['topic', 'points'],
        additionalProperties: false,
      },
    },
  },
  required: ['topics'],
  additionalProperties: false,
};

function claimRules(template: Template, maxClaims: number): string {
  return [
    'Extract the concrete claims the transcript makes: facts, numbers, years, prices, recommendations, warnings and verdicts.',
    `Return at most ${maxClaims} claims, the most useful first.`,
    'claim: the claim in one plain sentence that makes sense on its own (name the model, year or thing it is about).',
    'quote: 8 to 30 words copied exactly, in order, from the transcript, where the claim is made. Do not fix grammar or spelling.',
    'startSec: the number in square brackets at the start of the line where the quote begins.',
    'videoId: the source label (V1, V2, ...).',
    `topic: a short topic name of two to four words${template.topics.length > 0 ? `, using one of these when it fits: ${template.topics.join(', ')}` : ''}.`,
    'stance (optional): a few words for the position taken, such as "recommend", "avoid", "reliable", "unreliable", "expensive".',
  ].join('\n');
}

export function mapMessages(
  block: string,
  opts: { template: Template; question?: string; maxClaims: number },
): ChatMessage[] {
  return [
    { role: 'system', content: systemFor('You extract cited claims from a video transcript and reply with JSON only.') },
    {
      role: 'user',
      content: [
        opts.question ? `The claims will answer this question; prefer claims relevant to it: ${opts.question}` : '',
        claimRules(opts.template, opts.maxClaims),
        'Reply with JSON: {"claims":[{"claim":string,"quote":string,"videoId":string,"startSec":number,"topic":string,"stance":string}]}',
        '## Transcript',
        'Each line starts with its start time in whole seconds, in square brackets.',
        block,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

const REDUCE_RULES = [
  'Merge topic names that mean the same thing into one topic.',
  'Inside each topic, group claims that say the same thing into one point, with a statement that says it plainly.',
  'support lists the ids of the claims that make the point. When other claims contradict the point, put their ids in oppose and state their position in counter.',
  'Use each claim id at most once. Every claim id should appear in some point; a claim nobody else makes becomes a point of its own.',
  'Do not invent claims or ids, and do not judge which side is right.',
].join('\n');

export function reduceMessages(claimsBlock: string, opts: { template: Template; question?: string }): ChatMessage[] {
  return [
    { role: 'system', content: systemFor('You organize claims from several videos into topics and points, and reply with JSON only.') },
    {
      role: 'user',
      content: [
        opts.question ? `Question the brief answers: ${opts.question}` : '',
        opts.template.topics.length > 0 ? `Preferred topics, in order: ${opts.template.topics.join(', ')}.` : '',
        REDUCE_RULES,
        'Reply with JSON: {"topics":[{"topic":string,"points":[{"statement":string,"support":[claim ids],"counter":string,"oppose":[claim ids]}]}]}',
        '## Claims',
        'One claim per line: id | video | topic | stance | claim. The claims were extracted from third-party transcripts.',
        claimsBlock,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

export const SINGLE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ...((MAP_SCHEMA.properties as Record<string, JsonSchema>).claims?.items as { properties: Record<string, JsonSchema> })
            .properties,
        },
        required: ['id', 'claim', 'quote', 'videoId', 'startSec', 'topic'],
        additionalProperties: false,
      },
    },
    topics: (REDUCE_SCHEMA.properties as Record<string, JsonSchema>).topics as JsonSchema,
  },
  required: ['claims', 'topics'],
  additionalProperties: false,
};

/** One pass over every source: claims plus their organization into topics and points. */
export function singleMessages(
  blocks: string[],
  opts: { template: Template; question?: string; maxClaims: number },
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: systemFor('You extract cited claims from video transcripts, organize them by topic, and reply with JSON only.'),
    },
    {
      role: 'user',
      content: [
        opts.question ? `The brief answers this question; prefer claims relevant to it: ${opts.question}` : '',
        '## Step 1: claims',
        claimRules(opts.template, opts.maxClaims),
        'Give each claim an id: k1, k2, ...',
        '## Step 2: topics and points',
        opts.template.topics.length > 0 ? `Preferred topics, in order: ${opts.template.topics.join(', ')}.` : '',
        REDUCE_RULES,
        'Reply with JSON: {"claims":[{"id":string,"claim":string,"quote":string,"videoId":string,"startSec":number,"topic":string,"stance":string}],"topics":[{"topic":string,"points":[{"statement":string,"support":[claim ids],"counter":string,"oppose":[claim ids]}]}]}',
        '## Transcripts',
        'Each line starts with its start time in whole seconds, in square brackets.',
        ...blocks,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

/** The extraction merge step: partial JSON results from chunks combined into one. */
export function mergeMessages(partials: string, opts: { schema: JsonSchema; question?: string }): ChatMessage[] {
  return [
    { role: 'system', content: systemFor('You merge partial JSON extractions into one and reply with JSON only.') },
    {
      role: 'user',
      content: [
        opts.question ? `Question: ${opts.question}` : '',
        'These partial results were extracted from different parts of the same set of videos. Merge them into one JSON object matching the schema.',
        'Combine items that describe the same thing and keep all of their citations. Keep citation objects exactly as they are (videoId, startSec, quote). Do not add facts.',
        'Schema:',
        JSON.stringify(opts.schema),
        '## Partial results',
        partials,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

export function repairMessages(original: ChatMessage[], answer: string, errors: string[]): ChatMessage[] {
  return [
    ...original,
    { role: 'assistant', content: answer },
    {
      role: 'user',
      content: [
        'Your JSON does not match the schema. Problems (JSON pointer: problem):',
        ...errors.map((e) => `- ${e}`),
        'Reply with the corrected JSON object only. Keep the content and citations; change only what is needed to match the schema.',
      ].join('\n'),
    },
  ];
}
