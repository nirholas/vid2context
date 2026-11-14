/**
 * Install (or find) yt-dlp and print what vid2context will use:
 *
 *   npx tsx providers/ytdlp/src/setup.ts
 *
 * An entry point, so it reads process.env (after loading .env files) and
 * prints the result as JSON on stdout. Logs go to stderr.
 */
import { createContext } from '@vid2context/core';
import { loadEnvFiles } from '@vid2context/registry/node';
import { ensureYtDlp } from './binary.ts';

loadEnvFiles();
const ctx = createContext({ runtime: 'node', env: { VID2CONTEXT_LOG_LEVEL: 'info', ...process.env } });
try {
  const info = await ensureYtDlp(ctx);
  process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  if (!info.ffmpeg) console.error('ffmpeg was not found: metadata and captions work, audio extraction needs ffmpeg (or FFMPEG_PATH).');
} catch (err) {
  const e = err as { message?: string; hint?: string };
  console.error(`yt-dlp setup failed: ${e.message ?? String(err)}`);
  if (e.hint) console.error(e.hint);
  process.exitCode = 1;
}
