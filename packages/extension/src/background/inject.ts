/**
 * Injected into the tab with `scripting.executeScript({ func })` after a
 * context-menu action, so it must not reference anything outside its own
 * body. It copies `text` when given and shows a small notice; when the
 * browser refuses the copy (no recent click in the page), the notice offers a
 * Copy button instead.
 */
export interface PageNotice {
  text?: string;
  message: string;
  hint?: string;
  kind: 'ok' | 'error';
}

export function showPageNotice(notice: PageNotice): Promise<boolean> {
  const ID = 'vid2context-notice';
  document.getElementById(ID)?.remove();
  const host = document.createElement('div');
  host.id = ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .box { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; max-width: 380px; padding: 14px 16px;
      background: #0b0b0d; color: #fafafa; border: 1px solid #26262b; border-radius: 12px;
      box-shadow: 0 1px 2px rgb(0 0 0 / .4), 0 8px 24px rgb(0 0 0 / .35);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .title { font-weight: 600; margin: 0 0 2px; }
    .title.error { color: #ef4444; }
    .hint { color: #a1a1aa; margin: 4px 0 0; }
    .row { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
    button { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 999px; cursor: pointer;
      border: 1px solid #3a3a42; background: #141417; color: #fafafa; }
    button.primary { border-color: transparent; background: linear-gradient(135deg, #3b82f6 0%, #22d3ee 100%); color: #fff; }`;
  const box = document.createElement('div');
  box.className = 'box';
  box.setAttribute('role', 'status');
  const title = document.createElement('p');
  title.className = notice.kind === 'error' ? 'title error' : 'title';
  title.textContent = notice.message;
  box.append(title);
  if (notice.hint) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = notice.hint;
    box.append(hint);
  }
  const row = document.createElement('div');
  row.className = 'row';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => host.remove());
  row.append(close);
  box.append(row);
  root.append(style, box);
  document.documentElement.append(host);
  const autoClose = (ms: number) => setTimeout(() => host.remove(), ms);

  const text = notice.text;
  if (text === undefined) {
    autoClose(15_000);
    return Promise.resolve(false);
  }
  return navigator.clipboard.writeText(text).then(
    () => {
      autoClose(5000);
      return true;
    },
    () => {
      title.textContent = 'Transcript ready';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'primary';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(text).then(() => {
          title.textContent = 'Copied';
          autoClose(2000);
        });
      });
      row.prepend(copy);
      return false;
    },
  );
}
