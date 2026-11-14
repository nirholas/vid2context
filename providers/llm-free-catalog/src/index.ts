/**
 * Free LLM catalog: more free tiers and keyless lanes on top of the
 * foundation's OpenAI-compatible lanes. See lanes.ts for the services and
 * check.ts for the logic behind `npm run check:llm`.
 */
import { defineProvider, type LlmProvider } from '@vid2context/core';
import { catalogRungs, PROVIDER_ID } from './lanes.ts';

export {
  CHECK_EXPECTED,
  CHECK_REQUEST,
  type CheckOptions,
  type CheckRow,
  type CheckSelection,
  exitCodeFor,
  formatTable,
  isCorrect,
  runChecks,
  selectRungs,
} from './check.ts';
export { type CatalogEndpoint, chatVia, type LaneLimits, limitRequest, retryAfterFromHeaders } from './client.ts';
export { CATALOG_LANES, type CatalogLane, type CatalogModel, catalogRungs, laneRungs, modelsFor } from './lanes.ts';

const provider: LlmProvider = defineProvider({
  id: PROVIDER_ID,
  kind: 'llm',
  name: 'Free LLM catalog (Kilo, NVIDIA, SambaNova, Cloudflare, Zhipu, SiliconFlow)',
  runtimes: ['node', 'workers', 'browser'],
  rungs: catalogRungs,
});

export default provider;
