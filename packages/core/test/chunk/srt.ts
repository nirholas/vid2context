/** Caption text of an SRT file, cue lines joined with spaces the way segmentsToText joins segments. */
export function srtText(srt: string): string {
  return srt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\d+$/.test(l) && !l.includes('-->'))
    .join(' ');
}
