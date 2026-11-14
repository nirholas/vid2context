/**
 * One manifest source for every browser. Chrome and Edge run the background
 * as a service worker; Firefox runs it as an event page (`background.scripts`)
 * and needs a gecko id. Permissions are the same everywhere.
 */
export type TargetBrowser = 'chrome' | 'firefox';

export const YOUTUBE_MATCHES = ['https://www.youtube.com/*', 'https://m.youtube.com/*'];
export const PERMISSIONS = ['activeTab', 'contextMenus', 'storage', 'scripting'];
/** Requested only when "Copy transcript (via API)" first needs the API's host. */
export const OPTIONAL_HOSTS = ['https://*/*', 'http://*/*'];
export const GECKO_ID = 'extension@vid2context.com';

const ICONS = { '16': 'icons/16.png', '32': 'icons/32.png', '48': 'icons/48.png', '128': 'icons/128.png' };

export interface ManifestInput {
  browser: TargetBrowser;
  version: string;
}

export function manifestFor({ browser, version }: ManifestInput): Record<string, unknown> {
  const background = browser === 'firefox' ? { scripts: ['background.js'] } : { service_worker: 'background.js' };
  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: 'vid2context',
    short_name: 'vid2context',
    version,
    description:
      'Turn any video into context for AI agents. On YouTube: copy an agent-ready transcript or download a .zip, right in the page.',
    homepage_url: 'https://vid2context.com',
    icons: ICONS,
    action: { default_title: 'vid2context', default_popup: 'popup.html', default_icon: ICONS },
    options_ui: { page: 'options.html', open_in_tab: true },
    background,
    permissions: [...PERMISSIONS],
    host_permissions: [...YOUTUBE_MATCHES],
    optional_host_permissions: [...OPTIONAL_HOSTS],
    content_scripts: [
      // Main world first, at document_start, so it sees the player's earliest caption request.
      { matches: [...YOUTUBE_MATCHES], js: ['page.js'], run_at: 'document_start', world: 'MAIN' },
      { matches: [...YOUTUBE_MATCHES], js: ['content.js'], run_at: 'document_idle' },
    ],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  };
  if (browser === 'chrome') {
    // world: "MAIN" in the manifest needs Chrome 111.
    manifest.minimum_chrome_version = '111';
  } else {
    manifest.browser_specific_settings = {
      gecko: {
        id: GECKO_ID,
        // world: "MAIN" content scripts need Firefox 128.
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] },
      },
    };
  }
  return manifest;
}
