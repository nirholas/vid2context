/**
 * User settings, kept in `storage.sync` so they follow the browser profile.
 */
export interface Settings {
  /** Where the web app lives. "Open in vid2context" opens `<appBase>/app/?url=`. */
  appBase: string;
  /** The HTTP API, used by "Copy transcript (via API)". */
  apiBase: string;
  /** `agent` for the agent prompt, or any formatter id from the core `formatters` map. */
  copyFormat: string;
  /** Wraps the copied text. Placeholders: {{content}}, {{title}}, {{url}}, {{channel}}. */
  copyTemplate: string;
  /** Timestamps for formats that make them optional (text). The agent prompt always cites with timestamps. */
  timestamps: boolean;
}

export const AGENT_FORMAT = 'agent';

export const DEFAULT_SETTINGS: Settings = {
  appBase: 'https://vid2context.com',
  apiBase: 'http://localhost:8787/api/v1',
  copyFormat: AGENT_FORMAT,
  copyTemplate: '{{content}}',
  timestamps: true,
};

const SETTINGS_KEY = 'settings';

/** A base URL without a trailing slash, or null when it is not an http(s) URL. */
export function cleanBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

/** Fill in defaults and drop anything malformed, so stored values can never break a surface. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    appBase: cleanBase(r.appBase) ?? DEFAULT_SETTINGS.appBase,
    apiBase: cleanBase(r.apiBase) ?? DEFAULT_SETTINGS.apiBase,
    copyFormat: typeof r.copyFormat === 'string' && r.copyFormat ? r.copyFormat : DEFAULT_SETTINGS.copyFormat,
    copyTemplate:
      typeof r.copyTemplate === 'string' && r.copyTemplate.includes('{{content}}') ? r.copyTemplate : DEFAULT_SETTINGS.copyTemplate,
    timestamps: typeof r.timestamps === 'boolean' ? r.timestamps : DEFAULT_SETTINGS.timestamps,
  };
}

type SyncArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export async function loadSettings(area: SyncArea): Promise<Settings> {
  const got = await area.get(SETTINGS_KEY);
  return normalizeSettings(got[SETTINGS_KEY]);
}

export async function saveSettings(area: SyncArea, settings: Settings): Promise<Settings> {
  const clean = normalizeSettings(settings);
  await area.set({ [SETTINGS_KEY]: clean });
  return clean;
}

/** Replace {{name}} placeholders. Unknown placeholders are left as written. */
export function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
}
