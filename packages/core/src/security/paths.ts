/**
 * Argument and path safety. Pure string functions with no `node:` imports, so
 * the core can use them and Node packages can apply them before touching the
 * filesystem or spawning yt-dlp and ffmpeg.
 */
import { Vid2ContextError } from '../errors.ts';

/**
 * Throw unless `value` is safe as a positional argument to a binary: it must
 * not start with `-` (it would be read as an option, for example
 * `--exec=...` for yt-dlp) and must not contain NUL or line breaks.
 * Returns the value so it can be used inline.
 */
export function assertSafeArg(value: string, label: string): string {
  if (value.startsWith('-')) {
    throw new Vid2ContextError('unsupported-input', `${label} must not start with "-".`, {
      hint: `A ${label} starting with "-" would be read as a command-line option. Pass a full URL or a path starting with "./".`,
    });
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Vid2ContextError('unsupported-input', `${label} contains a NUL or line break.`, {
      hint: `Remove control characters from the ${label}.`,
    });
  }
  return value;
}

/**
 * Join a base directory and an untrusted relative name. Rejects absolute
 * paths (POSIX, Windows drive letters, UNC), `..` segments and NUL. Returns
 * the joined path using the base's separator style.
 */
export function safeJoin(base: string, name: string): string {
  const fail = (why: string) =>
    new Vid2ContextError('bad-request', `Unsafe path "${name.slice(0, 120)}": ${why}.`, {
      hint: 'Use a plain relative name inside the target directory.',
    });
  if (name.includes('\0')) throw fail('contains NUL');
  if (name.trim() === '') throw fail('empty name');
  if (/^[/\\]/.test(name)) throw fail('absolute path');
  if (/^[a-z]:/i.test(name)) throw fail('drive letter');
  const segments = name.split(/[/\\]+/).filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..' || /^\.\.+$/.test(s.trim()))) throw fail('".." segment');
  if (segments.some((s) => /:/.test(s))) throw fail('":" is not allowed (Windows streams and drives)');
  if (segments.length === 0) throw fail('empty name');
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const trimmed = base.replace(/[/\\]+$/, '');
  return `${trimmed}${sep}${segments.join(sep)}`;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i;

/**
 * Make an untrusted string (a video title, an upload name) safe as one file
 * name on POSIX and Windows: no control or bidi-override characters, no path
 * separators or reserved punctuation, no reserved device names, no leading
 * dots, no trailing dots or spaces, at most `maxLength` characters with the
 * extension kept. Never returns an empty string.
 */
export function safeFilename(name: string, maxLength = 120): string {
  let s = name
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we strip.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  const chars = Array.from(s);
  if (chars.length > maxLength) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 ? Array.from(s.slice(dot)) : [];
    const keepExt = ext.length > 0 && ext.length <= 16 && ext.length < maxLength;
    const stem = Array.from(keepExt ? s.slice(0, dot) : s).slice(0, maxLength - (keepExt ? ext.length : 0));
    s = (stem.join('').replace(/[.\s]+$/, '') + (keepExt ? ext.join('') : '')).trim();
  }
  return s === '' ? 'file' : s;
}
