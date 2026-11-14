/**
 * @vid2context/config: versioned config files with profiles. Runtime-neutral
 * (no node: imports). A profile compiles to an env overlay plus per-stage
 * chain options, so providers keep reading ctx.env and need no changes.
 * File loading lives in `@vid2context/config/node`.
 */
export {
  applyPrefer,
  chainOptionsFor,
  compileProfile,
  type EnvEntry,
  type MissingRef,
  mergeEnv,
  type StageChainOptions,
  toEnv,
} from './compile.ts';
export {
  type Config,
  configSchema,
  MODES,
  type PerStage,
  POLICIES,
  type Profile,
  type ProfileDefaults,
  type ProfileLimits,
  profileSchema,
  STAGES,
  type Stage,
} from './definition.ts';
export { explain, MASK, type TraceEntry, trace } from './explain.ts';
export { JsoncError, parseJsonc, stripJsonc } from './jsonc.ts';
export { MODEL_ENV_VARS, MODEL_KEYS, type ModelKind } from './models.ts';
export { type ResolvedProfile, resolveProfile, type StageKey, type StageMap } from './resolve.ts';
export { check, type SchemaError, type SchemaNode, toJsonSchema } from './schema.ts';
export { CONTROLLED_ENV, DOCS_HINT, isSecretName, looksLikeKey, parseConfig, validateConfig } from './validate.ts';

import { configSchema } from './definition.ts';
import { toJsonSchema } from './schema.ts';

/** The JSON Schema for config files, as committed in schema/config.schema.json. */
export function configJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'vid2context config',
    ...toJsonSchema(configSchema),
  };
}
