/** Display helpers: sizes, durations, dates, relative times and the transcript origin in plain words. */
import { formatTimestamp, type Transcript } from '@vid2context/core';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 19 -> "0:19", 1093 -> "18:13", 3723 -> "1:02:03". */
export function formatDuration(sec: number | undefined): string {
  return sec === undefined ? '' : formatTimestamp(sec);
}

/** "19 seconds", "18 minutes", "1 hour 2 minutes", for screen readers and summaries. */
export function spokenDuration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  const mins = `${m} minute${m === 1 ? '' : 's'}`;
  if (!h) return mins;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${mins}` : ''}`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "just now", "5 minutes ago", "yesterday". */
export function timeAgo(epochMs: number, now = Date.now()): string {
  const diff = Math.round((epochMs - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (abs >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return rtf.format(Math.round(diff / 60), 'minute');
}

export interface OriginBadge {
  label: string;
  /** Longer explanation for a tooltip and screen readers. */
  title: string;
  tone: 'good' | 'ok' | 'warn';
}

/** How the transcript was made, in plain words, plus a machine-translation badge when it applies. */
export function originBadges(t: Transcript): OriginBadge[] {
  const out: OriginBadge[] = [];
  switch (t.origin) {
    case 'creator-captions':
      out.push({ label: 'Creator captions', title: 'Captions uploaded by the creator: the most accurate source.', tone: 'good' });
      break;
    case 'auto-captions':
      out.push({ label: 'Auto-captions', title: "The platform's automatic speech recognition. Names and terms may be misheard.", tone: 'ok' });
      break;
    case 'native-transcript':
      out.push({ label: 'Published transcript', title: 'A transcript the platform or publisher provides with the media.', tone: 'good' });
      break;
    case 'stt':
      out.push({
        label: `Transcribed by ${t.producer}`,
        title: `No captions were available, so the audio was transcribed by ${t.producer}${t.model ? ` (${t.model})` : ''}.`,
        tone: 'ok',
      });
      break;
    case 'video-model':
      out.push({
        label: `Watched by ${t.producer}`,
        title: `A multimodal model (${t.producer}) watched the video and wrote the transcript and on-screen notes.`,
        tone: 'ok',
      });
      break;
  }
  if (t.translated) {
    out.push({ label: 'Machine-translated', title: `Translated into ${t.language} by a machine, not by a person.`, tone: 'warn' });
  }
  return out;
}

/** "jNQXAC9IVRw" style ids and short URLs, shortened for narrow lists. */
export function shortInput(input: string, max = 64): string {
  const s = input.replace(/^https?:\/\/(www\.)?/, '');
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
