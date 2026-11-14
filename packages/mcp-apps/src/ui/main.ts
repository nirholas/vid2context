/**
 * Entry point of the viewer bundle. Runs the MCP Apps handshake with the
 * host, renders the tool result it receives and follows the host's theme,
 * style variables, size limits and display mode. Host features (open a
 * link, post a message, fullscreen) are used only when the host's
 * capabilities or context say it has them.
 */
import type { McpUiDisplayMode, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { isViewerData } from '../data.ts';
import { ViewBridge, windowChannel } from './bridge.ts';
import { createViewer, type ViewerHost } from './viewer.ts';

const mount = document.getElementById('app');
if (!mount) throw new Error('viewer mount point #app is missing');

let displayMode: McpUiDisplayMode = 'inline';
let fontsApplied = false;

// Created first so its handlers exist before the handshake; `viewer` is assigned right below.
const bridge = new ViewBridge(windowChannel(window), {
  appInfo: { name: 'vid2context transcript viewer', version: '0.1.0' },
  appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
  handlers: {
    onToolInput(args) {
      const url = args?.url;
      viewer.setLoading(typeof url === 'string' ? url : undefined);
    },
    onToolResult(result) {
      if (result.isError) {
        const first = result.content?.find((c) => c.type === 'text');
        let message = 'The transcript could not be loaded.';
        if (first && first.type === 'text') {
          try {
            const err = JSON.parse(first.text) as { message?: string; hint?: string };
            message = [err.message, err.hint].filter(Boolean).join(' ') || message;
          } catch {
            message = first.text;
          }
        }
        viewer.showError(message);
        return;
      }
      if (isViewerData(result.structuredContent)) viewer.setData(result.structuredContent);
      else viewer.showError('The tool result did not include transcript data this viewer understands.');
    },
    onToolCancelled(reason) {
      viewer.showError(reason ? `The tool call was cancelled: ${reason}` : 'The tool call was cancelled.');
    },
    onHostContextChanged(ctx) {
      applyContext(ctx);
    },
  },
});

const host: ViewerHost = {
  async openLink(url) {
    if (!bridge.connected || !bridge.hostCapabilities?.openLinks) return false;
    return bridge.openLink(url);
  },
  async sendMessage(text) {
    if (!bridge.connected || !bridge.hostCapabilities?.message) return false;
    return bridge.sendMessage(text);
  },
  async toggleFullscreen() {
    const want: McpUiDisplayMode = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    applyDisplayMode(await bridge.requestDisplayMode(want));
  },
};

const viewer = createViewer(mount, host);
// Hidden until the host's capabilities are known.
viewer.setSendAvailable(false);

function applyDisplayMode(mode: McpUiDisplayMode | undefined): void {
  if (mode) displayMode = mode;
  const modes = bridge.hostContext.availableDisplayModes ?? [];
  viewer.setFullscreenAvailable(modes.includes('fullscreen'), displayMode === 'fullscreen');
  viewer.refresh();
}

function applyContext(ctx: McpUiHostContext): void {
  const html = document.documentElement;
  if (ctx.theme === 'light' || ctx.theme === 'dark') html.dataset.theme = ctx.theme;
  for (const [name, value] of Object.entries(ctx.styles?.variables ?? {})) {
    if (typeof value === 'string' && name.startsWith('--')) html.style.setProperty(name, value);
  }
  const fonts = ctx.styles?.css?.fonts;
  if (fonts && !fontsApplied) {
    const style = document.createElement('style');
    style.textContent = fonts;
    document.head.append(style);
    fontsApplied = true;
  }
  if (ctx.locale) html.lang = ctx.locale;
  const dims = ctx.containerDimensions;
  if (dims && !('height' in dims) && 'maxHeight' in dims && dims.maxHeight) {
    // Keep the whole viewer inside the host's height limit: the list gets what the header leaves.
    const list = viewer.root.querySelector<HTMLElement>('.list');
    const chrome = viewer.root.offsetHeight - (list?.offsetHeight ?? 0);
    html.style.setProperty('--list-h', `${Math.max(200, Math.min(480, dims.maxHeight - chrome - 8))}px`);
  }
  if (ctx.displayMode) displayMode = ctx.displayMode;
  const fixedHeight = Boolean(dims && 'height' in dims);
  applyDisplayMode(undefined);
  if (fixedHeight) viewer.root.classList.add('fill');
}

// Follow the OS setting until the host says which theme it uses.
document.documentElement.dataset.theme = 'system';

bridge
  .connect()
  .then(() => {
    applyContext(bridge.hostContext);
    viewer.setSendAvailable(Boolean(bridge.hostCapabilities?.message));
    bridge.autoResize(window);
  })
  .catch((err: unknown) => {
    viewer.showError(
      `Could not connect to an MCP Apps host (${err instanceof Error ? err.message : String(err)}). Open this viewer through the open_transcript_viewer tool.`,
    );
  });
