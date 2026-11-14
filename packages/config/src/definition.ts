/**
 * The version 1 config file: TypeScript types and the schema definition the
 * validator and the committed JSON Schema are both built from.
 */
import type { Policy } from '@vid2context/core';
import { MODEL_KEYS } from './models.ts';
import { type SchemaNode, s } from './schema.ts';

export const STAGES = ['stt', 'llm', 'embed', 'video', 'visual'] as const;
export type Stage = (typeof STAGES)[number];

export const POLICIES: Policy[] = ['free', 'local-only', 'quality'];
export const MODES = ['auto', 'captions', 'stt', 'video'] as const;

/** A value for every stage, or a default plus per-stage overrides. */
export type PerStage<T> = T | ({ default?: T } & Partial<Record<Stage, T>>);

export interface ProfileDefaults {
  format?: string;
  timestamps?: boolean;
  mode?: (typeof MODES)[number];
  language?: string;
  comments?: boolean | number;
}

export interface ProfileLimits {
  maxPlaylistItems?: number;
  maxUploadMb?: number;
  maxAudioMb?: number;
}

export interface Profile {
  description?: string;
  extends?: string;
  policy?: PerStage<Policy>;
  allowPaid?: boolean;
  keyless?: boolean;
  prefer?: PerStage<string[]>;
  skip?: PerStage<string[]>;
  only?: PerStage<string[]>;
  models?: Record<string, string | string[]>;
  storage?: string;
  defaults?: ProfileDefaults;
  limits?: ProfileLimits;
  env?: Record<string, string>;
}

export interface Config {
  $schema?: string;
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

export const ENV_NAME = '^[A-Za-z_][A-Za-z0-9_]*$';
export const ENV_REF = '^env:[A-Za-z_][A-Za-z0-9_]*$';
const PROFILE_NAME = '^[A-Za-z0-9][A-Za-z0-9_.-]*$';
const ID = '^[a-z0-9][a-z0-9-]*$';

function perStage(value: SchemaNode, what: string): SchemaNode {
  const props: Record<string, SchemaNode> = {
    default: { ...value, description: `${what} for every stage without its own value.` },
  };
  for (const stage of STAGES) props[stage] = { ...value, description: `${what} for ${stage} rungs.` };
  return s.union([value, s.object(props)], `${what}: one value for every stage, or an object with default and per-stage values.`);
}

const rungList = s.array(
  s.string('A rung id (llm/groq/openai/gpt-oss-120b), a service (groq) or a provider (llm-openai-compatible).', { minLength: 1 }),
);

const modelValue = s.union(
  [
    s.string('One model id, a comma-separated list, or "env:NAME" to read it from env.', { minLength: 1 }),
    s.array(s.string(undefined, { minLength: 1 }), 'Model ids in order of preference.'),
  ],
  'Model override.',
);

export const profileSchema: SchemaNode = s.object(
  {
    description: s.string('What this profile is for. Shown by explain.'),
    extends: s.string('Another profile to start from. Settings here override it.', { pattern: PROFILE_NAME }),
    policy: perStage(
      s.enum(POLICIES, 'free: local, free, keyless, then paid. local-only: nothing leaves the machine. quality: best first.'),
      'Rung order policy',
    ),
    allowPaid: s.boolean('Allow paid rungs. They still run only when their key is set, and only after every free rung.'),
    keyless: s.boolean('Allow keyless hosted rungs (no account, but data goes to a third party).'),
    prefer: perStage(rungList, 'Rungs, services or providers to move to the front'),
    skip: perStage(rungList, 'Rungs, services or providers to drop'),
    only: perStage(rungList, 'Restrict to these rungs, services or providers'),
    models: s.object(
      Object.fromEntries(
        Object.entries(MODEL_KEYS).map(([key, envVar]) => [key, { ...modelValue, description: `Sets ${envVar}.` }]),
      ),
      { description: 'Model overrides per provider. "groq" sets chat models; "groq:stt" sets the speech-to-text model.' },
    ),
    storage: s.string('Storage backend id, e.g. memory, sqlite, postgres, cloudflare. Sets VID2CONTEXT_STORAGE.', {
      pattern: ID,
    }),
    defaults: s.object(
      {
        format: s.string('Default output format id (text, json, markdown, srt, vtt, pack, ...).', { pattern: ID }),
        timestamps: s.boolean('Include timestamps in text output by default.'),
        mode: s.enum([...MODES], 'Default transcript mode.'),
        language: s.string('Preferred transcript language (BCP-47, e.g. en, pt-BR).', {
          pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$',
        }),
        comments: s.union([s.boolean(), s.integer(undefined, 1)], 'Fetch comments: true, false, or a maximum count.'),
      },
      { description: 'Defaults for surfaces (CLI, MCP, HTTP) when a request does not say.' },
    ),
    limits: s.object(
      {
        maxPlaylistItems: s.integer('Most videos taken from one playlist, channel or feed.', 1),
        maxUploadMb: s.integer('Largest upload accepted, in MB.', 1),
        maxAudioMb: s.integer('Largest audio download, in MB.', 1),
      },
      { description: 'Size limits.' },
    ),
    env: s.object(
      {},
      {
        description: 'Extra non-secret env values. Secrets stay in .env; reference them as "env:NAME".',
        additional: s.string(),
        keyPattern: '^[A-Z_][A-Z0-9_]*$',
      },
    ),
  },
  { description: 'One named set of settings.' },
);

export const configSchema: SchemaNode = s.object(
  {
    $schema: s.string('Path or URL of the JSON Schema, for editors.'),
    version: s.literal(1, 'Config format version.'),
    defaultProfile: s.string('Profile used when none is chosen. Default: "default".', { pattern: PROFILE_NAME }),
    profiles: s.object({}, { description: 'Named profiles.', additional: profileSchema, keyPattern: PROFILE_NAME }),
  },
  { description: 'vid2context config file.', required: ['version', 'profiles'] },
);
