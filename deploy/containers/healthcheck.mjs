#!/usr/bin/env node
/**
 * Container health check: exits 0 when GET /api/v1/health answers 200 on
 * this container's PORT. The image ships no curl or wget, so Node does it.
 */
const port = Number(process.env.PORT) || 8787;
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  console.error(`healthcheck: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
