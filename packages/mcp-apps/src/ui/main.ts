/**
 * Entry point of the viewer bundle. Connects to the MCP Apps host with the
 * official ext-apps `App` class (ui/initialize handshake over postMessage),
 * renders the tool result it receives and follows the host's theme, size
 * and display mode. Host features (open link, post a message, fullscreen)
 * are used only when the host's capabilities say it has them.
 */
import {
  App,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiDisplayMode,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { isViewerData } from '../data.ts';
import { createViewer, type ViewerHost } from './viewer.ts';

const mount = document.getElementById('app');
if (!mount) throw new Error('viewer mount point #app is missing');

const app = new App(
  { name: 'vid2context transcript viewer', version: '0.1.0' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
  { autoResize: true },
);

let connected = false;
let displayMode: McpUiDisplayMode = 'inline';

const host: ViewerHost = {
  async openLink(url) {
    if (!connected || !app.getHostCapabilities()?.openLinks) return false;
    const res = await app.openLink({ url });
    return !res.isError;
  },
  async sendMessage(text) {
    if (!connected || !app.getHostCapabilities()?.message) return false;
    const res = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    return !res.isError;
  },
  async toggleFullscreen() {
    const want: McpUiDisplayMode = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    const res = await app.requestDisplayMode({ mode: want });
    applyDisplayMode(res.mode);
  },
};

const viewer = createViewer(mount, host);
// Hidden until the host's capabilities are known.
viewer.setSendAvailable(false);

function applyDisplayMode(mode: McpUiDisplayMode | undefined): void {
  if (mode) displayMode = mode;
  const modes = app.getHostContext()?.availableDisplayModes ?? [];
  viewer.setFullscreenAvailable(modes.includes('fullscreen'), displayMode === 'fullscreen');
  viewer.refresh();
}

function applyContext(ctx: Partial<McpUiHostContext> | undefined): void {
  if (!ctx) return;
  const rootEl = document.documentElement;
  if (ctx.theme) rootEl.dataset.theme = ctx.theme;
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.locale) rootEl.lang = ctx.locale;
  const dims = ctx.containerDimensions;
  if (dims) {
    const fixed = 'height' in dims;
    viewer.root.classList.toggle('fill', fixed || displayMode === 'fullscreen');
    if (!fixed && 'maxHeight' in dims && dims.maxHeight) {
      // Keep the whole viewer inside the host's height limit: the list gets what the header leaves.
      const chrome = viewer.root.offsetHeight - (viewer.root.querySelector<HTMLElement>('.list')?.offsetHeight ?? 0);
      const listHeight = Math.max(200, Math.min(480, dims.maxHeight - chrome - 8));
      rootEl.style.setProperty('--list-h', `${listHeight}px`);
    }
  }
  if (ctx.displayMode || ctx.availableDisplayModes) applyDisplayMode(ctx.displayMode);
  else viewer.refresh();
}

// Handlers are registered before connect() so the one-shot notifications sent right after the handshake are never missed.
app.ontoolinput = (params) => {
  const url = params.arguments?.url;
  viewer.setLoading(typeof url === 'string' ? url : undefined);
};
app.ontoolresult = (result) => {
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
  else viewer.showError('The tool result did not include transcript data the viewer understands.');
};
app.ontoolcancelled = (params) => {
  viewer.showError(params.reason ? `The tool call was cancelled: ${params.reason}` : 'The tool call was cancelled.');
};
app.onhostcontextchanged = (ctx) => applyContext(ctx);
app.onteardown = async () => ({});

document.documentElement.dataset.theme = 'system';

app
  .connect()
  .then(() => {
    connected = true;
    applyContext(app.getHostContext());
    viewer.setSendAvailable(Boolean(app.getHostCapabilities()?.message));
  })
  .catch((err: unknown) => {
    viewer.showError(`Could not connect to the host: ${err instanceof Error ? err.message : String(err)}`);
  });
