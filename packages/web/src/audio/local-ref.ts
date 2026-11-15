/** The ref a file transcribed in the browser is stored under. Tiny on purpose: the page imports it without loading Whisper. */
import type { VideoRef } from '@vid2context/core';

export function localRefOf(audio: { sha256: string; name: string }): VideoRef {
  return {
    input: audio.name,
    platform: 'file',
    kind: 'video',
    id: `file:${audio.sha256}`,
    nativeId: audio.sha256,
  };
}
