import { describe, expect, it } from 'vitest';
import { ICON_SIZES, iconPng } from '../scripts/icons.ts';
import { manifestFor } from '../src/manifest.ts';

const chrome = manifestFor({ browser: 'chrome', version: '0.1.0' });
const firefox = manifestFor({ browser: 'firefox', version: '0.1.0' });

describe.each([
  ['chrome', chrome],
  ['firefox', firefox],
])('%s manifest', (_name, m) => {
  it('is Manifest V3 with the required keys', () => {
    expect(m.manifest_version).toBe(3);
    expect(m.name).toBe('vid2context');
    expect(m.version).toBe('0.1.0');
    expect(m.action).toMatchObject({ default_popup: 'popup/index.html' });
    expect(m.options_ui).toEqual({ page: 'options/index.html', open_in_tab: true });
    expect(Object.keys(m.icons as object)).toEqual(ICON_SIZES.map(String));
  });

  it('asks for exactly the listed permissions', () => {
    expect(m.permissions).toEqual(['activeTab', 'contextMenus', 'storage', 'scripting', 'declarativeNetRequestWithHostAccess']);
    expect(m.host_permissions).toEqual(['https://www.youtube.com/*', 'https://m.youtube.com/*']);
    expect(m.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  });

  it('runs the page script in the main world before the content script, and the bridge on the web app', () => {
    expect(m.content_scripts).toEqual([
      {
        matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
        js: ['page.js'],
        run_at: 'document_start',
        world: 'MAIN',
      },
      { matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*'], js: ['content.js'], run_at: 'document_idle' },
      {
        matches: ['https://vid2context.com/*', 'https://*.vid2context.com/*', 'http://localhost/*', 'http://127.0.0.1/*'],
        js: ['bridge.js'],
        run_at: 'document_idle',
      },
    ]);
  });

  it('allows no remote code', () => {
    expect(m.content_security_policy).toEqual({ extension_pages: "script-src 'self'; object-src 'self'" });
    expect(JSON.stringify(m)).not.toMatch(/unsafe-eval|web_accessible_resources/);
  });
});

describe('per-browser differences', () => {
  it('uses a service worker on Chrome and an event page with a gecko id on Firefox', () => {
    expect(chrome.background).toEqual({ service_worker: 'background.js' });
    expect(chrome.minimum_chrome_version).toBe('111');
    expect(chrome.browser_specific_settings).toBeUndefined();
    expect(firefox.background).toEqual({ scripts: ['background.js'] });
    expect(firefox.browser_specific_settings).toEqual({
      gecko: {
        id: 'extension@vid2context.com',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    });
    expect(firefox.minimum_chrome_version).toBeUndefined();
  });
});

describe('icons', () => {
  it('writes a PNG of each size', () => {
    for (const size of ICON_SIZES) {
      const png = iconPng(size);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });
});
