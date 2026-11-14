/**
 * Public-mode input policy. A public server or remote MCP endpoint sets
 * VID2CONTEXT_PUBLIC=1; from then on inputs that would make the server read
 * its own files or reach its own network are refused before any provider runs.
 */
import { Vid2ContextError } from '../errors.ts';
import type { Ctx, Env } from '../types.ts';
import { limits } from './limits.ts';
import { checkUrl, checkUrlSync, getHostResolver } from './url.ts';

/** True when VID2CONTEXT_PUBLIC is set to 1, true or yes. */
export function isPublicMode(env: Env): boolean {
  const v = env.VID2CONTEXT_PUBLIC?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Schemes that never name a video and only ever reach local files or internal services. */
const DANGEROUS_SCHEMES = new Set([
  'file',
  'data',
  'javascript',
  'vbscript',
  'blob',
  'filesystem',
  'gopher',
  'dict',
  'ftp',
  'ftps',
  'sftp',
  'tftp',
  'ldap',
  'ldaps',
  'smb',
  'nfs',
  'jar',
  'netdoc',
  'php',
  'phar',
  'expect',
  'ssh',
  'telnet',
  'unix',
  'ws',
  'wss',
  'chrome',
  'about',
]);

/** Media extensions a local-file provider would accept as a bare file name. */
const MEDIA_EXT = /\.(mp3|mpga|mpeg|m4a|aac|wav|flac|ogg|oga|opus|weba|webm|mp4|m4v|mov|mkv|avi|3gp|ts|wma|aiff?)$/i;

function refuse(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('unsupported-input', message, { hint });
}

const PATH_HINT = 'This server is public, so it does not read local files. Upload the file instead, or pass a public video URL.';
const URL_HINT = 'This server is public and only fetches public http(s) URLs. Pass the public URL of the video.';

/** The URL a schemeless input like `youtu.be/abc` or `127.0.0.1/x` would be fetched as, or null when it does not start with a host. */
function schemelessHostUrl(input: string): string | null {
  const first = input.split(/[/?#\\]/, 1)[0] ?? '';
  if (first.startsWith('[')) return `http://${input}`;
  if (/^[^\s:@]+(:\d+)?$/.test(first) && (first.includes('.') || /:\d+$/.test(first) || first.toLowerCase() === 'localhost')) {
    return `http://${input}`;
  }
  return null;
}

/**
 * Check one input against the public-mode policy. Returns the error to throw
 * when refused, or undefined when allowed. Outside public mode every input is
 * allowed (local use reads local files by design). Static checks only; use
 * `enforceInputPolicy` to also check DNS answers.
 */
export function checkInput(input: string, env: Env): Vid2ContextError | undefined {
  if (!isPublicMode(env)) return undefined;
  const max = limits(env).maxInputChars;
  if (input.length > max) {
    return refuse(`The input is ${input.length} characters long; the limit is ${max}.`, 'Pass a shorter URL or video id.');
  }
  const s = input.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(s)) return refuse('The input contains control characters.', 'Pass a plain URL or video id.');
  if (s === '') return refuse('The input is empty.', 'Pass a video URL or id.');

  // Local paths: absolute, home, relative, Windows drive and UNC paths, and bare media file names.
  if (/^(\/|~|\.{1,2}([/\\]|$)|\\|[a-z]:([/\\]|$))/i.test(s)) {
    return refuse(`Local file paths are not accepted here: "${s.slice(0, 80)}".`, PATH_HINT);
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  if (scheme === 'file') return refuse('file:// inputs are not accepted here.', PATH_HINT);
  if (scheme && /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const check = checkUrlSync(s);
    return check.ok ? undefined : refuse(`Refused URL: ${check.reason}.`, URL_HINT);
  }
  if (scheme && DANGEROUS_SCHEMES.has(scheme)) return refuse(`${scheme}: inputs are not accepted here.`, URL_HINT);
  if (MEDIA_EXT.test(s) && !/[/?#]/.test(s)) {
    return refuse(`"${s.slice(0, 80)}" looks like a local file name; local files are not accepted here.`, PATH_HINT);
  }
  const hostUrl = schemelessHostUrl(s);
  if (hostUrl) {
    const check = checkUrlSync(hostUrl);
    return check.ok ? undefined : refuse(`Refused URL: ${check.reason}.`, URL_HINT);
  }
  if (/[/\\]/.test(s)) return refuse(`"${s.slice(0, 80)}" looks like a local file path.`, PATH_HINT);
  return undefined;
}

/**
 * Throw when the input is refused by the public-mode policy. Also checks the
 * DNS answers for URL inputs when a resolver was registered with
 * `setHostResolver`, so names like `127.0.0.1.nip.io` are refused too.
 */
export async function enforceInputPolicy(input: string, ctx: Ctx): Promise<void> {
  const refused = checkInput(input, ctx.env);
  if (refused) throw refused;
  if (!isPublicMode(ctx.env) || !getHostResolver()) return;
  const s = input.trim();
  const url = /^https?:\/\//i.test(s) ? s : schemelessHostUrl(s);
  if (!url) return;
  const check = await checkUrl(url);
  if (!check.ok) throw refuse(`Refused URL: ${check.reason}.`, URL_HINT);
}
