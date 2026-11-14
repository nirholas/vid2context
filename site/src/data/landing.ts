/**
 * Copy for the landing page. The page and its Markdown twin (/index.md) both
 * render from this file, so they never say different things. Numbers are
 * computed from the generated data, never written here.
 */
import { allRungs, data, rungsByTier, serviceCount } from './site.ts';

const tiers = rungsByTier();
const videoRungs = allRungs().filter((r) => r.kind === 'video').length;
const nativeSources = data.sources.filter((s) => !s.catchAll);
const ytdlpSources = data.sources.filter((s) => s.catchAll);

/** How a source name reads inside a sentence. */
const SENTENCE_NAME: Record<string, string> = {
  Podcasts: 'podcast feeds',
  'Google Drive, Dropbox and OneDrive links': 'Google Drive, Dropbox and OneDrive',
};

export const hero = {
  title: 'Turn any video into context for AI agents',
  sub: 'Paste a link or drop a file. Get the transcript, chapters and metadata as Markdown, a .zip, or straight into your agent over MCP.',
  placeholder: 'Paste a video or podcast link',
  button: 'Get context',
  chips: [
    { label: 'G-Wagon buyer’s guide', url: 'https://www.youtube.com/watch?v=cCPsdFdlshc' },
    { label: 'Me at the zoo', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
    {
      label: 'NASA podcast episode',
      url: 'https://traffic.megaphone.fm/NATIONALAERONAUTICSANDSPACEADMINISTRATION1369565567.mp3',
    },
    { label: 'Vimeo video', url: 'https://vimeo.com/76979871' },
  ],
  badges: ['Free and open source', 'No key needed', 'Runs locally'],
};

export interface Step {
  n: string;
  title: string;
  body: string;
}

export const steps: Step[] = [
  {
    n: '01',
    title: 'Paste a link or upload a file',
    body: `A link from ${nativeSources
      .filter((s) => s.name !== 'Local files')
      .map((s) => SENTENCE_NAME[s.name] ?? s.name)
      .join(', ')}${ytdlpSources.length ? ' or any other site yt-dlp supports' : ''}, or an audio or video file from your machine.`,
  },
  {
    n: '02',
    title: 'Captions first, then free speech-to-text',
    body: 'Existing captions are used when the video has them. Otherwise the audio goes through a chain of speech-to-text rungs, local first, then free tiers, then keyless hosts. Every attempt is recorded, so you can see what ran and why.',
  },
  {
    n: '03',
    title: 'Copy it, download it, or hand it to your agent',
    body: 'Copy Markdown with timestamps, download a .zip with every format, or let Claude, Cursor, VS Code and other agents fetch it themselves over MCP.',
  },
];

/** The transcript chain, in the order the pipeline tries it. The video-model step shows only when a video rung exists. */
export const chain = [
  { title: 'Creator captions', body: 'Uploaded by the creator, when the video has them.' },
  { title: 'Auto-captions', body: 'The platform’s automatic captions, in your language.' },
  {
    title: 'Speech-to-text',
    body: `Download the audio and transcribe it through ${allRungs().filter((r) => r.kind === 'stt').length} Whisper-class rungs.`,
  },
  ...(videoRungs > 0
    ? [{ title: 'Video model', body: `A multimodal model watches the video (${videoRungs} rungs), so slides and on-screen text are captured.` }]
    : []),
];

export const sourcesCopy = {
  title: 'Works where your videos are',
  sub:
    data.ytdlpExtractors && ytdlpSources.length
      ? `Platform providers handle the big sites directly. Everything else goes through yt-dlp, which knows ${data.ytdlpExtractors.toLocaleString('en-US')} sites.`
      : 'Platform providers handle the big sites directly. Everything else goes through the yt-dlp provider.',
};

export const modelsCopy = {
  title: 'Bring any model',
  sub: `${allRungs().length} rungs across ${serviceCount()} services, tried in free-first order. A rung is one provider, one model and one credential. When one fails, rate-limits or is down, the chain moves to the next.`,
  counts: {
    local: tiers.local.length,
    free: tiers.free.length,
    keyless: tiers.keyless.length,
    paid: tiers.paid.length,
  },
};

export interface UseCase {
  title: string;
  body: string;
  /** Real output from a fixture, shown under the text. */
  example?: { caption: string; lang: string; text: string };
}

export const useCases: UseCase[] = [
  {
    title: 'Research a buying decision across a playlist',
    body: 'A buyer’s series on the Mercedes G-Wagon spans several long episodes. Load the episodes into your agent and ask which model, year and mileage to buy. Every transcript line carries its timestamp, so each claim in the answer can cite the episode and the moment that said it.',
    example: {
      caption: `The first lines of "${data.gwagon.title}" (${data.gwagon.duration}, ${data.gwagon.segments} caption lines), as the agent receives them`,
      lang: 'text',
      text: `${data.gwagon.header}\n\n${data.gwagon.textExcerpt}`,
    },
  },
  {
    title: 'Learn from tutorials',
    body: 'Chapters become sections. For a long course video, your agent reads the outline first and pulls only the section it needs, instead of the whole transcript.',
  },
  {
    title: 'Notes from podcasts',
    body: 'Podcast episodes have no captions, so the audio goes through speech-to-text. You get Markdown notes with a timestamp on every paragraph, ready for Obsidian, Notion or your agent.',
  },
];

export interface Faq {
  q: string;
  a: string;
}

const siteNames = data.sources.map((s) => s.name).join(', ');

export const faq: Faq[] = [
  {
    q: 'What does it cost?',
    a: 'Nothing. vid2context is free and open source under the Apache-2.0 license. With no keys it uses captions and keyless hosts. Paid services run only when you set their key, and VID2CONTEXT_ALLOW_PAID=0 turns them off entirely.',
  },
  {
    q: 'Do I need an API key?',
    a: `No. Captions need no key, and speech-to-text falls back to keyless Whisper hosts. Free keys (Groq, Gemini, Mistral and others) unlock ${tiers.free.length} more free-tier rungs that are faster and have higher limits.`,
  },
  {
    q: 'Where does my data go?',
    a: 'When you run vid2context yourself, captions are fetched straight from the platform and your files stay on your machine unless a hosted rung transcribes them. Keyless rungs send audio to third-party hosts without an account. Set VID2CONTEXT_POLICY=local-only to keep everything on your machine, or VID2CONTEXT_KEYLESS=0 to skip keyless hosts.',
  },
  {
    q: 'Which sites work?',
    a:
      `${siteNames}.` +
      (data.ytdlpExtractors ? ` Anything else that yt-dlp supports (${data.ytdlpExtractors.toLocaleString('en-US')} sites) works through the yt-dlp provider.` : ''),
  },
  {
    q: 'Why does a YouTube video fail on the hosted demo?',
    a: 'YouTube often blocks requests from cloud servers, so the demo on this site can fail for videos that work fine on your own machine. Run the CLI or the MCP server locally, where requests come from your own connection.',
  },
  {
    q: 'Which agents does it work with?',
    a: 'Any MCP client: Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI, Windsurf, Cline, LM Studio and Goose. ChatGPT gets a context pack file you upload to a Project.',
  },
];
