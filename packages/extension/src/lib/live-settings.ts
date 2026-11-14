/** Settings kept current in memory: loaded once, then updated whenever the options page saves. */
import { ext } from './browser.ts';
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, type Settings } from './settings.ts';

let current: Settings = DEFAULT_SETTINGS;
const ready = loadSettings(ext.storage.sync).then(
  (s) => {
    current = s;
    return s;
  },
  () => current,
);

ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) current = normalizeSettings(changes.settings.newValue);
});

/** The latest settings, or the defaults until the first load finishes. */
export function settingsNow(): Settings {
  return current;
}

export function settingsReady(): Promise<Settings> {
  return ready;
}
