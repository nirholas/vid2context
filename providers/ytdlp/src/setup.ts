/**
 * Install (or find) yt-dlp and print what vid2context will use:
 *
 *   npx tsx providers/ytdlp/src/setup.ts
 *
 * An entry point, so it reads process.env (after loading .env files when the
 * registry loads) and
 * prints the result as JSON on stdout. Logs go to stderr.
 */
import { createContext } from '@vid2context/core';
import { ensureYtDlp } from './binary.ts';

// The registry module imports every provider; a broken one elsewhere must not stop yt-dlp setup.
try {
  const { loadEnvFiles } = await import('@vid2context/registry/node');
  loadEnvFiles();
} catch (err) {
  console.error(
    `Could not load .env files through the registry (${(err as Error).message.split('\n')[0]}); using the shell environment.`,
  );
}
const ctx = createContext({ runtime: 'node', env: { VID2CONTEXT_LOG_LEVEL: 'info', ...process.env } });
try {
  const info = await ensureYtDlp(ctx);
  process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  if (!info.ffmpeg)
    console.error('ffmpeg was not found: metadata and captions work, audio extraction needs ffmpeg (or FFMPEG_PATH).');
} catch (err) {
  const e = err as { message?: string; hint?: string };
  console.error(`yt-dlp setup failed: ${e.message ?? String(err)}`);
  if (e.hint) console.error(e.hint);
  process.exitCode = 1;
}
