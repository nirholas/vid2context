/**
 * Exit codes. Every ErrorCode maps to its own stable number, so scripts can
 * branch on why a run failed without parsing stderr. The Record type makes a
 * new ErrorCode a compile error here until it gets a number. Never renumber:
 * add new codes at the end. docs/cli.md documents this table.
 */
import { type ErrorCode, Vid2ContextError } from '@vid2context/core';

export const EXIT_OK = 0;
/** An unexpected error that carries no Vid2ContextError code, or a doctor check that failed. */
export const EXIT_FAILURE = 1;
/** Bad command line: unknown command or flag, missing or extra arguments, invalid flag value. */
export const EXIT_USAGE = 2;
/** Interrupted with Ctrl-C (128 + SIGINT). */
export const EXIT_INTERRUPTED = 130;

export const EXIT_BY_CODE: Record<ErrorCode, number> = {
  'unsupported-input': 3,
  'not-found': 4,
  unavailable: 5,
  'no-transcript': 6,
  'no-provider': 7,
  'all-rungs-failed': 8,
  'rate-limited': 9,
  auth: 10,
  blocked: 11,
  'too-large': 12,
  timeout: 13,
  upstream: 14,
  'bad-request': 15,
};

/** What each code means, for --help and docs. */
export const EXIT_MEANINGS: Record<ErrorCode, string> = {
  'unsupported-input': 'no source understands the input, or it is a list where a video was needed',
  'not-found': 'the video, collection or library item does not exist',
  unavailable: 'the video exists but cannot be read (private, removed, members-only, age-restricted, live)',
  'no-transcript': 'every way of getting a transcript failed; see the attempts list',
  'no-provider': 'no provider or rung is installed or enabled for the step',
  'all-rungs-failed': 'every rung in a fallback chain failed',
  'rate-limited': 'an upstream service rate-limited the request',
  auth: 'a key was rejected or its account is out of credits',
  blocked: 'the platform blocked this machine (for example a datacenter IP)',
  'too-large': 'the media or request is larger than allowed',
  timeout: 'an upstream call timed out',
  upstream: 'an upstream service returned an error',
  'bad-request': 'the request is invalid (unknown format, bad option value)',
};

/** Thrown for command line mistakes. Exits with EXIT_USAGE. */
export class UsageError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof UsageError) return EXIT_USAGE;
  if (err instanceof Vid2ContextError) return EXIT_BY_CODE[err.code] ?? EXIT_FAILURE;
  if (err instanceof Error && err.name === 'AbortError') return EXIT_INTERRUPTED;
  return EXIT_FAILURE;
}

/** Rows for the docs and `vid2context --help exit-codes`. */
export function exitCodeTable(): { code: number; name: string; meaning: string }[] {
  return [
    { code: EXIT_OK, name: 'ok', meaning: 'success' },
    { code: EXIT_FAILURE, name: 'failure', meaning: 'unexpected error, or a doctor check failed' },
    { code: EXIT_USAGE, name: 'usage', meaning: 'bad command line (unknown command or flag, wrong arguments)' },
    ...(Object.keys(EXIT_BY_CODE) as ErrorCode[]).map((name) => ({
      code: EXIT_BY_CODE[name],
      name,
      meaning: EXIT_MEANINGS[name],
    })),
    { code: EXIT_INTERRUPTED, name: 'interrupted', meaning: 'stopped with Ctrl-C' },
  ];
}
