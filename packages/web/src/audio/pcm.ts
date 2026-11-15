/**
 * Read 16 kHz 16-bit PCM WAV straight into float samples, without Web Audio.
 * The app converts every file to exactly that (prepare.ts, wav.ts) before
 * transcribing, and Web Workers have no OfflineAudioContext, so this is how
 * the speech-to-text worker gets its samples. Chunks are walked properly, so
 * WAV files from other tools (LIST chunks before data) read too.
 */
/** The rate the app converts every file to (decode.ts TARGET_RATE); kept here so the worker does not load decode.ts. */
const TARGET_RATE = 16_000;

function ascii(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

/** Mono float samples, or null when the bytes are not 16-bit PCM WAV at 16 kHz (then a full decoder is needed). */
export function decodePcmWav(bytes: Uint8Array): Float32Array | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0) !== 'RIFF' || ascii(view, 8) !== 'WAVE') return null;
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = ascii(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (fmt?.format !== 1 || fmt.bits !== 16 || fmt.rate !== TARGET_RATE || fmt.channels < 1) return null;
      // A streaming writer may leave the size at 0 or 0xffffffff: read to the end then.
      const end = size === 0 || size === 0xffffffff ? bytes.byteLength : Math.min(bytes.byteLength, body + size);
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const out = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += view.getInt16(body + (f * fmt.channels + c) * 2, true);
        out[f] = sum / fmt.channels / 0x8000;
      }
      return out;
    }
    at = body + size + (size % 2);
  }
  return null;
}
