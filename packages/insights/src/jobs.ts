/**
 * Job kinds for @vid2context/jobs (item 42): `brief` and `extract`. The HTTP
 * routes enqueue them and answer 202 Job; every runner of a deployment
 * (in-process, Cloudflare Queues, Cloud Tasks) must register them with
 * registerInsightsJobs(queue) so it can execute them.
 *
 * Input is the request body (see parse.ts). Each run loads the contexts
 * (saved ones are cache hits), runs the LLM steps and returns the Brief or
 * ExtractionResult as the job result. A rerun after a crash starts over.
 */
import type { JobHandler, JobQueue } from '@vid2context/jobs';
import { buildBrief } from './brief.ts';
import { extract } from './extract.ts';
import { loadContexts } from './load.ts';
import { parseBriefRequest, parseExtractRequest } from './parse.ts';

export const BRIEF_JOB = 'brief';
export const EXTRACT_JOB = 'extract';

/** LLM work is slow and rate-limited; one retry is enough (the chain already falls through rungs). */
const KIND_OPTIONS = { maxAttempts: 2 };

export const briefJob: JobHandler = async ({ input, registry, storage, ctx, progress }) => {
  const req = parseBriefRequest(input);
  progress({ done: 0, message: 'Loading videos' });
  const contexts = await loadContexts(req, { registry, ctx, storage });
  return buildBrief(
    contexts,
    { question: req.question, template: req.template, onProgress: (p) => progress(p) },
    { registry, ctx },
  );
};

export const extractJob: JobHandler = async ({ input, registry, storage, ctx, progress }) => {
  const req = parseExtractRequest(input);
  progress({ done: 0, message: 'Loading videos' });
  const contexts = await loadContexts(req, { registry, ctx, storage });
  progress({ done: 0, total: 1, message: 'Extracting' });
  return extract(contexts, { template: req.template, schema: req.schema, question: req.question }, { registry, ctx });
};

/** Register the brief and extract kinds on a queue (idempotent: registering again replaces the handler). */
export function registerInsightsJobs(queue: Pick<JobQueue, 'registerKind'>): void {
  queue.registerKind(BRIEF_JOB, briefJob, KIND_OPTIONS);
  queue.registerKind(EXTRACT_JOB, extractJob, KIND_OPTIONS);
}
