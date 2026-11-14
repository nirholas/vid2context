/**
 * 16-bit PCM WAV, mono. At 16 kHz that is exactly 32,000 bytes per second
 * (1,920,000 bytes, about 1.83 MB, per minute) plus a 44-byte header.
 */

export const WAV_HEADER_BYTES = 44;

export function wavBytesFor(samples: number): number {
  return WAV_HEADER_BYTES + samples * 2;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(wavBytesFor(samples.length));
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  const dataBytes = samples.length * 2;
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let o = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(o, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    o += 2;
  }
  return out;
}

/** Read back the format of a WAV produced by encodeWav. */
export function readWavHeader(bytes: Uint8Array): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  samples: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const bitsPerSample = view.getUint16(34, true);
  return {
    sampleRate: view.getUint32(24, true),
    channels,
    bitsPerSample,
    samples: view.getUint32(40, true) / (channels * (bitsPerSample / 8)),
  };
}
