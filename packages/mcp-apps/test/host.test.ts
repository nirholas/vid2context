/**
 * End to end: the committed viewer HTML runs in an iframe of a happy-dom
 * page, and the ext-apps AppBridge (the SDK's host implementation) drives it
 * over postMessage, as a real MCP Apps host does: handshake, tool input,
 * tool result with real data, theme change, and a timestamp click that must
 * arrive at the host as ui/open-link.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { VideoContext } from '@vid2context/core';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { toViewerData } from '../src/data.ts';
import { VIEWER_HTML } from '../src/ui/viewer.html.ts';

const context = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;

/** A host-side postMessage transport for one iframe (what a host such as basic-host wires up). */
function iframeTransport(page: Window, frame: { contentWindow: { postMessage(m: unknown, o: string): void } | null }): Transport {
  const t: Transport = {
    async start() {
      page.addEventListener('message', (ev) => {
        const data = (ev as unknown as MessageEvent).data as JSONRPCMessage | undefined;
        if (data && (data as { jsonrpc?: string }).jsonrpc === '2.0') t.onmessage?.(data);
      });
    },
    async send(message) {
      frame.contentWindow?.postMessage(message, '*');
    },
    async close() {
      t.onclose?.();
    },
  };
  return t;
}

async function until<T>(read: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for the viewer');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let page: Window | undefined;
afterEach(async () => {
  await page?.happyDOM.close();
  page = undefined;
});

describe('viewer HTML in an iframe driven by the ext-apps AppBridge', () => {
  it('renders the tool result, follows the theme and opens timestamps through the host', async () => {
    page = new Window({
      settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
    });
    const doc = page.document;
    const iframe = doc.createElement('iframe');

    const host = new AppBridge(
      null,
      { name: 'ext-apps AppBridge', version: '1.7.5' },
      { openLinks: {}, message: { text: {} } },
      { hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } },
    );
    const opened: string[] = [];
    const sizes: unknown[] = [];
    host.onopenlink = async ({ url }) => {
      opened.push(url);
      return {};
    };
    host.onsizechange = (s) => sizes.push(s);
    let initialized = false;
    host.oninitialized = () => {
      initialized = true;
    };
    await host.connect(iframeTransport(page, iframe as unknown as Parameters<typeof iframeTransport>[1]));

    iframe.srcdoc = VIEWER_HTML;
    doc.body.append(iframe);
    await until(() => initialized);

    const view = (iframe as unknown as { contentWindow: Window }).contentWindow.document;
    expect(view.documentElement.dataset.theme).toBe('light');

    await host.sendToolInput({ arguments: { url: 'https://www.youtube.com/watch?v=cCPsdFdlshc' } });
    const data = toViewerData(context);
    await host.sendToolResult({ content: [{ type: 'text', text: 'header' }], structuredContent: { ...data } });

    const title = await until(() => view.querySelector('h1')?.textContent === data.metadata.title && view.querySelector('h1'));
    expect(title.textContent).toBe('Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!');
    const rows = view.querySelectorAll('.row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);

    await host.sendHostContextChange({ theme: 'dark' });
    await until(() => view.documentElement.dataset.theme === 'dark');

    const link = view.querySelector('.row a.ts') as unknown as HTMLAnchorElement;
    link.click();
    await until(() => opened.length > 0);
    expect(opened).toEqual(['https://www.youtube.com/watch?v=cCPsdFdlshc&t=0s']);
    expect(sizes.length).toBeGreaterThan(0);
  });
});
