/**
 * Recovery: what to do next when a request fails. A failure is never a dead
 * end: every surface (web app, HTTP API, CLI, MCP) turns an error into a
 * ranked list of concrete ways to still get the result, best first, and
 * shows those before the technical details.
 *
 * `suggestRecoveries` is pure (no network, no env reads). The caller says
 * what its surface can do (`RecoveryContext`): whether yt-dlp downloads are
 * available, how keys reach the pipeline, whether transcripts can be
 * imported. Suggestions that need a capability the surface lacks are left out.
 *
 * The error's `hint` stays as it is; recoveries are added next to it.
 */
import { type ErrorStage, Vid2ContextError } from './errors.ts';
import type { Attempt } from './types.ts';

export type RecoveryAction =
  /** Download the video or its audio with yt-dlp where the request ran, then transcribe the file. */
  | 'download-media'
  /** Get the file yourself (any downloader, the original recording) and hand it over as an upload or a path. */
  | 'local-file'
  /** The vid2context browser extension reads the captions from the user's own browser and IP address. */
  | 'from-browser'
  /** Paste or upload a transcript or subtitle file. */
  | 'import-transcript'
  /** Add a provider key; `keys` lists which ones help, free ones first. */
  | 'add-key'
  /** Try again, after `retryAfterSec` when set. */
  | 'retry'
  /** Try again with another transcript mode (`mode`). */
  | 'switch-mode'
  /** Run vid2context on your own computer, whose home IP address is rarely blocked. */
  | 'run-locally'
  /** Install a local tool (yt-dlp) that adds a way to read the video. */
  | 'install'
  /** The input itself needs to change. */
  | 'fix-input';

export interface KeyOffer {
  /** Env var name, such as GROQ_API_KEY. */
  name: string;
  /** Service the key is for, such as Groq. */
  service: string;
  /** What adding it unlocks, in a few words. */
  unlocks: string;
  /** The free tier in a few words, when there is one. */
  free?: string;
  /** Where to create the key. */
  signupUrl: string;
}

export interface Recovery {
  action: RecoveryAction;
  /** Short imperative, such as "Download the audio and transcribe it". */
  title: string;
  /** One or two sentences on how, written for the surface that shows it. */
  detail: string;
  /** add-key: the keys that help, best first. */
  keys?: KeyOffer[];
  /** switch-mode: the mode to retry with. */
  mode?: RecoveryMode;
  /** retry: wait this long first. */
  retryAfterSec?: number;
  /** A shell command that does it (CLI, MCP and API surfaces). */
  command?: string;
}

export type RecoveryMode = 'auto' | 'captions' | 'stt' | 'video';

export type RecoverySurface = 'web' | 'api' | 'cli' | 'mcp';

export interface RecoveryContext {
  surface: RecoverySurface;
  /** The input the request was for. */
  input?: string;
  /** Platform of the input when the caller resolved it ('youtube', 'file', 'upload', ...). Guessed from `input` otherwise. */
  platform?: string;
  /** The transcript mode the request used. */
  mode?: RecoveryMode;
  /** yt-dlp downloads work where the request ran. */
  downloads?: boolean;
  /**
   * How a new key reaches the pipeline: 'request' (sent with the next
   * request, which the server accepts), 'env' (set where vid2context runs),
   * 'browser' (saved in the web app, used for work done in the browser),
   * 'none' (no way: add-key is left out).
   */
  keys?: 'request' | 'env' | 'browser' | 'none';
  /** keys = 'request': the names the server accepts. Offers outside the list are left out. */
  keyNames?: readonly string[];
  /** Transcripts can be imported (the web app, POST /imports). */
  imports?: boolean;
  /** The request ran on a remote server, so running locally is a real alternative. */
  remote?: boolean;
}

/** Keys worth suggesting, by what they unlock. Free tiers only; every one is optional. */
export const KEY_OFFERS = {
  transcript: [
    {
      name: 'SUPADATA_API_KEY',
      service: 'Supadata',
      unlocks: 'YouTube transcripts fetched from Supadata servers, not this one',
      free: '100 transcripts a month',
      signupUrl: 'https://supadata.ai',
    },
  ],
  stt: [
    {
      name: 'GROQ_API_KEY',
      service: 'Groq',
      unlocks: 'fast Whisper speech-to-text',
      free: 'free tier, about 2 hours of audio an hour',
      signupUrl: 'https://console.groq.com/keys',
    },
  ],
  llm: [
    {
      name: 'GROQ_API_KEY',
      service: 'Groq',
      unlocks: 'summaries, briefs, chapters and answers',
      free: 'free tier',
      signupUrl: 'https://console.groq.com/keys',
    },
    {
      name: 'GEMINI_API_KEY',
      service: 'Google AI Studio',
      unlocks: 'Gemini models for summaries, briefs and answers',
      free: 'free tier',
      signupUrl: 'https://aistudio.google.com/apikey',
    },
    {
      name: 'OPENROUTER_API_KEY',
      service: 'OpenRouter',
      unlocks: 'free open models for summaries and answers',
      free: 'free models',
      signupUrl: 'https://openrouter.ai/keys',
    },
  ],
  gemini: [
    {
      name: 'GEMINI_API_KEY',
      service: 'Google AI Studio',
      unlocks: 'Gemini video understanding, vision and embeddings',
      free: 'free tier',
      signupUrl: 'https://aistudio.google.com/apikey',
    },
  ],
} as const satisfies Record<string, readonly KeyOffer[]>;

/** Key offers for a failed stage. */
export function keyOffersForStage(stage: ErrorStage | undefined): readonly KeyOffer[] {
  switch (stage) {
    case 'stt':
    case 'audio':
      return KEY_OFFERS.stt;
    case 'llm':
      return KEY_OFFERS.llm;
    case 'video':
    case 'visual':
    case 'embed':
      return KEY_OFFERS.gemini;
    case 'captions':
    case 'metadata':
      return KEY_OFFERS.transcript;
    default:
      return [];
  }
}

const YOUTUBE = /^(https?:\/\/)?([a-z0-9-]+\.)*(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** 'youtube', 'upload', 'file', 'web' or undefined, from the input alone. */
export function guessPlatform(input: string | undefined): string | undefined {
  const s = input?.trim();
  if (!s) return undefined;
  if (YOUTUBE.test(s) || YOUTUBE_ID.test(s)) return 'youtube';
  if (s.startsWith('upload:')) return 'upload';
  if (s.startsWith('file:') || s.startsWith('/') || s.startsWith('./') || /^[A-Za-z]:\\/.test(s)) return 'file';
  if (/^https?:\/\//i.test(s)) return 'web';
  return undefined;
}

/** POSIX shell single-quoting, for commands shown to the user. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function hasAttempt(attempts: Attempt[], pred: (a: Attempt) => boolean): boolean {
  return attempts.some(pred);
}

const BLOCK_DETAIL = /LOGIN_REQUIRED|not a bot|sign in to confirm|blocked/i;

/**
 * Ranked ways to still get the result after `err`, best first. Empty only
 * for errors that are not failures of the request (an abort).
 */
export function suggestRecoveries(err: unknown, rc: RecoveryContext, attempts: Attempt[] = []): Recovery[] {
  if ((err as { name?: string } | null)?.name === 'AbortError') return [];
  const e = err instanceof Vid2ContextError ? err : undefined;
  const code = e?.code ?? 'upstream';
  const platform = rc.platform ?? guessPlatform(rc.input);
  const isMedia = platform === 'file' || platform === 'upload';
  const isYouTube = platform === 'youtube';
  // A link to a video page: a platform the caller resolved or one guessed from the input. Free text is not a link.
  const isVideoLink = !!rc.input && platform !== undefined && !isMedia;
  const out: Recovery[] = [];
  const add = (r: Recovery | undefined) => {
    if (r && !out.some((o) => o.action === r.action)) out.push(r);
  };
  const b = builders(rc);

  const blockedSomewhere =
    code === 'blocked' ||
    hasAttempt(attempts, (a) => a.reason === 'blocked' || (a.outcome === 'error' && BLOCK_DETAIL.test(a.detail ?? '')));
  const audioOk = hasAttempt(attempts, (a) => a.stage === 'audio' && a.outcome === 'ok');
  const sttFailed = hasAttempt(attempts, (a) => a.stage === 'stt' && a.outcome !== 'ok');

  switch (code) {
    case 'blocked':
      if (isVideoLink) {
        add(b.downloadMedia());
        if (isYouTube) add(b.fromBrowser());
        add(b.importTranscript());
        add(b.localFile());
        if (isYouTube) add(b.addKey(KEY_OFFERS.transcript, 'Add a transcript API key'));
        add(b.retry(e?.retryAfterSec, 'Try again later', 'Blocks like this usually clear after a while.'));
        add(b.runLocally());
        if (!rc.downloads) add(b.installYtDlp());
      }
      break;

    case 'no-transcript':
      if (rc.mode === 'captions') add(b.switchMode('auto', 'Transcribe the audio instead'));
      if (isMedia) {
        add(b.addKey(KEY_OFFERS.stt, 'Add a speech-to-text key'));
        if (hasAttempt(attempts, (a) => a.reason === 'too-large')) add(b.localFile('Send a smaller audio file'));
      } else {
        if (!audioOk) add(b.downloadMedia());
        if (audioOk || sttFailed) add(b.addKey(KEY_OFFERS.stt, 'Add a speech-to-text key'));
        if (isYouTube) add(b.fromBrowser());
        add(b.importTranscript());
        add(b.localFile());
        if (isYouTube && blockedSomewhere) add(b.addKey([...KEY_OFFERS.stt, ...KEY_OFFERS.transcript], 'Add a key'));
        if (blockedSomewhere) add(b.runLocally());
        if (!rc.downloads) add(b.installYtDlp());
      }
      break;

    case 'no-provider':
    case 'all-rungs-failed':
    case 'auth': {
      const offers = keyOffersForStage(e?.stage ?? stageFromAttempts(attempts));
      const title = code === 'auth' ? 'Use a different key' : 'Add a free key';
      add(b.addKey(offers, title));
      if (code === 'all-rungs-failed')
        add(b.retry(e?.retryAfterSec, 'Try again in a minute', 'Free tiers reset their limits every minute or so.'));
      if ((e?.stage === 'stt' || e?.stage === 'audio') && isVideoLink) {
        add(b.downloadMedia());
        add(b.importTranscript());
        add(b.localFile());
      }
      break;
    }

    case 'rate-limited':
      add(b.retry(e?.retryAfterSec ?? 60, 'Wait and try again', 'The limit resets on its own.'));
      if (e?.stage) add(b.addKey(keyOffersForStage(e.stage), 'Add your own key'));
      add(b.runLocally());
      break;

    case 'too-large':
      if (isVideoLink) add(b.downloadMedia('Download only the audio and transcribe it'));
      add(b.localFile('Send compressed audio instead'));
      if (isVideoLink) add(b.importTranscript());
      break;

    case 'timeout':
      add(b.retry(undefined, 'Try again', 'Long videos sometimes need a second try; finished steps are reused.'));
      if (isVideoLink) {
        add(b.downloadMedia());
        add(b.importTranscript());
      }
      add(b.runLocally());
      break;

    case 'unavailable':
      if (isYouTube) add(b.fromBrowser());
      add(b.localFile('Use your own copy of the video'));
      add(b.importTranscript());
      break;

    case 'not-found':
      // The video does not exist (removed, or a mistyped id): there is nothing to paste or download, only the link to fix.
      add(b.fixInput('Check the link', 'Open it in a browser to make sure it plays, then paste the address from there.'));
      break;

    case 'unsupported-input':
      add(
        b.fixInput(
          'Use a link to one video',
          'Paste the address of a single video page, a playlist or channel, a podcast feed, or drop a media file.',
        ),
      );
      if (!rc.downloads && isVideoLink) add(b.installYtDlp());
      if (isVideoLink) add(b.localFile('Download it yourself and use the file'));
      break;

    case 'bad-request':
      add(b.fixInput('Change the request', 'The hint above says which field to fix.'));
      break;

    default:
      // 'upstream' and anything unexpected: transient until shown otherwise.
      add(b.retry(e?.retryAfterSec, 'Try again', 'The service that failed is often back within a minute.'));
      if (isVideoLink && hasTranscriptStage(attempts)) {
        add(b.downloadMedia());
        if (isYouTube) add(b.fromBrowser());
        add(b.importTranscript());
        add(b.localFile());
      }
      break;
  }
  return out;
}

function stageFromAttempts(attempts: Attempt[]): ErrorStage | undefined {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i] as Attempt;
    if (a.outcome === 'error' && a.stage !== 'resolve') return a.stage;
  }
  return undefined;
}

function hasTranscriptStage(attempts: Attempt[]): boolean {
  return attempts.length === 0 || attempts.some((a) => ['metadata', 'captions', 'audio', 'stt'].includes(a.stage));
}

/** Builders for each action, worded for the surface. Each returns undefined when the surface cannot do it. */
function builders(rc: RecoveryContext) {
  const s = rc.surface;
  const url = rc.input?.trim() ?? '';
  const q = shellQuote(url || '<url>');

  return {
    downloadMedia(title = 'Download the audio and transcribe it'): Recovery | undefined {
      if (!rc.downloads) return undefined;
      const detail: Record<RecoverySurface, string> = {
        web: 'The server saves the audio with yt-dlp, which reads YouTube differently, then transcribes the file.',
        api: 'POST /downloads with kind "audio", wait for the job, then upload the file (POST /uploads) and read GET /context?url=upload:<sha256>.',
        cli: 'yt-dlp often gets through where the direct request did not. Transcribe the saved file afterwards.',
        mcp: 'Call download_media with kind "audio", then call get_transcript with the saved file path.',
      };
      return {
        action: 'download-media',
        title,
        detail: detail[s],
        ...(s === 'cli' ? { command: `vid2context download ${q} --audio mp3` } : {}),
      };
    },

    localFile(title = 'Download it yourself and use the file'): Recovery | undefined {
      // A remote MCP server cannot read a path on the user's machine.
      if (s === 'mcp' && rc.remote) return undefined;
      const detail: Record<RecoverySurface, string> = {
        web: 'Save the video or audio on your own computer (for example with yt-dlp), then drop the file here. It is transcribed in this browser for free, or on the server.',
        api: 'Upload the file with POST /uploads, then read GET /context?url=upload:<sha256>.',
        cli: 'Save the video or audio on this computer, then pass the file path instead of the link.',
        mcp: 'Save the video or audio on this computer, then pass the file path as url.',
      };
      return {
        action: 'local-file',
        title,
        detail: detail[s],
        ...(url && guessPlatform(url) !== 'file' && guessPlatform(url) !== 'upload'
          ? { command: `yt-dlp -x --audio-format mp3 -o audio.mp3 ${q}` }
          : {}),
      };
    },

    fromBrowser(): Recovery | undefined {
      if (s !== 'web') return undefined;
      return {
        action: 'from-browser',
        title: 'Get the transcript from your browser',
        detail: 'The vid2context extension reads the captions from YouTube in your own browser, from your own connection.',
      };
    },

    importTranscript(): Recovery | undefined {
      if (!rc.imports) return undefined;
      return {
        action: 'import-transcript',
        title: 'Paste or upload the transcript',
        detail:
          s === 'web'
            ? 'Copy the text from YouTube ("Show transcript" under the video), or upload a .vtt, .srt or .txt file.'
            : 'POST /imports with the transcript text or a subtitle file (.vtt, .srt, .txt); the result is a normal context.',
      };
    },

    addKey(offers: readonly KeyOffer[], title: string): Recovery | undefined {
      if (!rc.keys || rc.keys === 'none' || offers.length === 0) return undefined;
      const allowed = rc.keys === 'request' && rc.keyNames ? new Set(rc.keyNames) : undefined;
      const seen = new Set<string>();
      const keys = offers.filter((k) => !seen.has(k.name) && seen.add(k.name) && (!allowed || allowed.has(k.name)));
      if (keys.length === 0) return undefined;
      const names = keys.map((k) => k.name).join(' or ');
      const detail: Record<RecoveryContext['keys'] & string, string> = {
        request:
          s === 'web'
            ? 'Paste a free key below. It is saved in this browser and sent with your requests; the server never stores it.'
            : `Send ${names} with the request in the X-Vid2Context-Keys header (JSON object). The server uses it for that request only and never stores it.`,
        env: `Set ${names} in .env or the environment where vid2context runs, then try again.`,
        browser: 'Paste a free key below. It is saved in this browser and used for work done here.',
        none: '',
      };
      return { action: 'add-key', title, detail: detail[rc.keys], keys };
    },

    retry(retryAfterSec: number | undefined, title: string, detail: string): Recovery {
      const wait = retryAfterSec && retryAfterSec > 0 ? Math.ceil(retryAfterSec) : undefined;
      return { action: 'retry', title, detail, ...(wait ? { retryAfterSec: wait } : {}) };
    },

    switchMode(mode: RecoveryMode, title: string): Recovery {
      return {
        action: 'switch-mode',
        title,
        detail: 'This video has no captions to read, but its audio can be transcribed.',
        mode,
        ...(s === 'cli' ? { command: `vid2context ${q} --mode ${mode}` } : {}),
      };
    },

    runLocally(): Recovery | undefined {
      if (!rc.remote) return undefined;
      return {
        action: 'run-locally',
        title: 'Run vid2context on your own computer',
        detail:
          'Home connections are rarely blocked. It runs with Node 22 or newer; an operator can also route this server through a home network (docs/guides/cloudflare-tunnel.md).',
        command: `npx vid2context ${q}`,
      };
    },

    installYtDlp(): Recovery | undefined {
      if (s !== 'cli' && s !== 'mcp' && s !== 'api') return undefined;
      return {
        action: 'install',
        title: 'Install yt-dlp',
        detail:
          s === 'api'
            ? 'The server operator can install yt-dlp; it adds another way to read videos and enables server downloads.'
            : 'yt-dlp adds another way to read videos and supports more than a thousand sites. vid2context uses it when it is on PATH.',
        command: 'pipx install yt-dlp',
      };
    },

    fixInput(title: string, detail: string): Recovery {
      return { action: 'fix-input', title, detail };
    },
  };
}
