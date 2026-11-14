/**
 * The button group under the video title. Lives in a shadow root so YouTube's
 * styles and ours never meet. Neutral colours come from YouTube's own CSS
 * variables (inherited through the shadow boundary), so it fits the light and
 * dark themes; the primary button uses the vid2context accent gradient.
 */
export const HOST_ID = 'vid2context-actions';

const CSS = `
:host { all: initial; display: block; margin: 10px 0 2px; font-family: Roboto, Arial, sans-serif; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
button {
  font: 500 14px/1 Roboto, Arial, sans-serif; height: 36px; padding: 0 16px; border-radius: 18px; cursor: pointer;
  border: 1px solid var(--yt-spec-10-percent-layer, rgba(127,127,127,.3));
  background: var(--yt-spec-badge-chip-background, rgba(127,127,127,.12));
  color: var(--yt-spec-text-primary, #0f0f0f);
}
button:hover { background: var(--yt-spec-button-chip-background-hover, rgba(127,127,127,.22)); }
button.primary { border-color: transparent; color: #fff; background: linear-gradient(135deg, #3b82f6 0%, #22d3ee 100%); }
button.primary:hover { filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
.status { margin-top: 6px; font: 400 13px/1.4 Roboto, Arial, sans-serif; color: var(--yt-spec-text-secondary, #606060); }
.status[data-kind="error"] { color: #ef4444; }
.status[data-kind="ok"] { color: #22c55e; }
.hint { display: block; color: var(--yt-spec-text-secondary, #606060); }
`;

export type StatusKind = 'info' | 'ok' | 'error';

export interface ActionsUi {
  host: HTMLElement;
  copy: HTMLButtonElement;
  zip: HTMLButtonElement;
  open: HTMLButtonElement;
  setStatus(kind: StatusKind, message: string, hint?: string): void;
  clearStatus(): void;
  setBusy(button: HTMLButtonElement, busy: boolean, busyLabel?: string): void;
  setCaptions(available: boolean): void;
}

function button(label: string, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.dataset.label = label;
  if (primary) b.className = 'primary';
  return b;
}

export function createActionsUi(opts: { zip: boolean }): ActionsUi {
  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'vid2context');
  const copy = button('Copy for AI', true);
  const zip = button('Download .zip');
  const open = button('Open in vid2context');
  row.append(copy, ...(opts.zip ? [zip] : []), open);
  const status = document.createElement('div');
  status.className = 'status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  root.append(style, row, status);

  return {
    host,
    copy,
    zip,
    open,
    setStatus(kind, message, hint) {
      status.dataset.kind = kind;
      status.textContent = message;
      if (hint) {
        const h = document.createElement('span');
        h.className = 'hint';
        h.textContent = hint;
        status.append(h);
      }
      status.hidden = false;
    },
    clearStatus() {
      status.hidden = true;
      status.textContent = '';
    },
    setBusy(b, busy, busyLabel) {
      b.disabled = busy;
      b.textContent = busy && busyLabel ? busyLabel : (b.dataset.label ?? '');
      b.setAttribute('aria-busy', String(busy));
    },
    setCaptions(available) {
      copy.disabled = !available;
      zip.disabled = !available;
    },
  };
}
