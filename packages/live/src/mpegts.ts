/**
 * MPEG-TS clean-up before decoding. Live HLS segments packaged by ffmpeg (and
 * broadcast transport streams) carry a Service Description Table on PID 0x11
 * with the service and provider names. Audio decoding never needs it, and
 * some static ffmpeg builds crash (SIGSEGV) converting its text: observed on
 * 2026-11-14 with the johnvansickle.com 7.0.2 build, which segfaults on every
 * transport stream ffmpeg itself writes. Dropping those packets avoids that.
 */
const PACKET = 188;
const SYNC = 0x47;
const SDT_PID = 0x11;

/** True when the bytes look like whole MPEG-TS packets (sync bytes where they belong). */
export function isMpegTs(data: Uint8Array): boolean {
  if (data.byteLength < PACKET || data.byteLength % PACKET !== 0) return false;
  for (let i = 0; i < Math.min(data.byteLength, PACKET * 4); i += PACKET) if (data[i] !== SYNC) return false;
  return true;
}

/** Remove SDT/BAT packets (PID 0x11) from a transport stream. Anything that is not whole TS packets is returned unchanged. */
export function stripServiceTables(data: Uint8Array): Uint8Array {
  if (!isMpegTs(data)) return data;
  const out = new Uint8Array(data.byteLength);
  let n = 0;
  for (let i = 0; i < data.byteLength; i += PACKET) {
    const pid = (((data[i + 1] ?? 0) & 0x1f) << 8) | (data[i + 2] ?? 0);
    if (pid === SDT_PID) continue;
    out.set(data.subarray(i, i + PACKET), n);
    n += PACKET;
  }
  return n === data.byteLength ? data : out.slice(0, n);
}
