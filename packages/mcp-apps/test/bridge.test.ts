/**
 * Checks the viewer's MCP Apps client against AppBridge, the host side that
 * ships in @modelcontextprotocol/ext-apps. AppBridge validates every message
 * against the specification's schemas, so a wrong method name, payload or
 * handshake step fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { toViewerData } from '../src/data.ts';
import { type BridgeChannel, type BridgeHandlers, PROTOCOL_VERSION, ViewBridge } from '../src/ui/bridge.ts';

const context = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;

/** Connect a ViewBridge and an AppBridge through a linked in-memory transport pair. */
async function connect(handlers: BridgeHandlers = {}) {
  const [hostSide, viewSide] = InMemoryTransport.createLinkedPair();
  const host = new AppBridge(
    null,
    { name: 'ext-apps AppBridge', version: '1.7.5' },
    { openLinks: {}, message: { text: {} } },
    { hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], locale: 'en-US' } },
  );
  const initialized = new Promise<void>((resolve) => {
    host.oninitialized = () => resolve();
  });
  await host.connect(hostSide);

  let listener: ((m: unknown) => void) | undefined;
  viewSide.onmessage = (m) => listener?.(m);
  await viewSide.start();
  const channel: BridgeChannel = {
    post: (m) => void viewSide.send(m as JSONRPCMessage),
    listen: (h) => {
      listener = h;
      return () => {
        listener = undefined;
      };
    },
  };
  const view = new ViewBridge(channel, {
    appInfo: { name: 'vid2context transcript viewer', version: '0.1.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    handlers,
  });
  const result = await view.connect();
  await initialized;
  return { host, view, result };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ViewBridge against the ext-apps AppBridge host', () => {
  it('completes the ui/initialize handshake and receives host capabilities and context', async () => {
    const { host, view, result } = await connect();
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(view.connected).toBe(true);
    expect(view.hostCapabilities?.openLinks).toEqual({});
    expect(view.hostContext.theme).toBe('light');
    expect(view.hostContext.availableDisplayModes).toEqual(['inline', 'fullscreen']);
    expect(host.getAppCapabilities()).toEqual({ availableDisplayModes: ['inline', 'fullscreen'] });
    expect(host.getAppVersion()).toEqual({ name: 'vid2context transcript viewer', version: '0.1.0' });
  });

  it('receives tool input and the tool result with the real viewer data', async () => {
    const inputs: unknown[] = [];
    const results: unknown[] = [];
    const { host } = await connect({
      onToolInput: (a) => inputs.push(a),
      onToolResult: (r) => results.push(r.structuredContent),
    });
    const data = toViewerData(context);
    await host.sendToolInput({ arguments: { url: 'https://www.youtube.com/watch?v=cCPsdFdlshc' } });
    await host.sendToolResult({ content: [{ type: 'text', text: 'header' }], structuredContent: { ...data } });
    await tick();
    expect(inputs).toEqual([{ url: 'https://www.youtube.com/watch?v=cCPsdFdlshc' }]);
    expect(results).toEqual([data]);
  });

  it('opens links, posts messages and changes display mode through the host', async () => {
    const { host, view } = await connect();
    const opened: string[] = [];
    const messages: unknown[] = [];
    host.onopenlink = async ({ url }) => {
      opened.push(url);
      return {};
    };
    host.onmessage = async (params) => {
      messages.push(params);
      return {};
    };
    host.onrequestdisplaymode = async ({ mode }) => ({ mode });
    const url = 'https://www.youtube.com/watch?v=cCPsdFdlshc&t=83s';
    expect(await view.openLink(url)).toBe(true);
    expect(opened).toEqual([url]);
    expect(await view.sendMessage('From "x", 1:23:\n\n[1:23] text')).toBe(true);
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'From "x", 1:23:\n\n[1:23] text' }] }]);
    expect(await view.requestDisplayMode('fullscreen')).toBe('fullscreen');
  });

  it('reports a denied link as not opened', async () => {
    const { host, view } = await connect();
    host.onopenlink = async () => ({ isError: true });
    expect(await view.openLink('https://www.youtube.com/watch?v=cCPsdFdlshc&t=1s')).toBe(false);
  });

  it('follows host context changes, size reports and teardown', async () => {
    const contexts: unknown[] = [];
    let tornDown = false;
    const { host, view } = await connect({
      onHostContextChanged: (c) => contexts.push(c.theme),
      onTeardown: () => {
        tornDown = true;
      },
    });
    const sizes: unknown[] = [];
    host.onsizechange = (s) => sizes.push(s);
    await host.sendHostContextChange({ theme: 'dark' });
    await tick();
    expect(contexts).toEqual(['dark']);
    expect(view.hostContext.displayMode).toBe('inline');
    view.sendSizeChanged({ width: 360, height: 610 });
    await tick();
    expect(sizes).toEqual([{ width: 360, height: 610 }]);
    await host.teardownResource({});
    expect(tornDown).toBe(true);
  });
});
