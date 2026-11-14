/**
 * The transcript viewer: plain DOM, no framework, so the whole bundle stays
 * small and works under the strict CSP MCP Apps hosts apply.
 *
 * Long transcripts (an hour is about 1,500 lines) are windowed: only the
 * lines near the visible area exist in the DOM. Line heights vary because
 * lines wrap, so each height starts as an estimate from the text length and
 * is replaced by the measured height once the line has been rendered.
 *
 * Everything the host provides (open a link, post to the chat, copy) comes
 * through `ViewerHost`, so this file never talks to the host protocol itself
 * and can be tested in a DOM environment without one.
 */
import { formatTimestamp } from '@vid2context/core';
import { citation, type SegmentTuple, timestampLink, type ViewerData } from '../data.ts';

export interface ViewerHost {
  /** Ask the host to open a URL. Resolve true when it did. Absent: the plain link opens it. */
  openLink?(url: string): Promise<boolean>;
  /** Post a user message into the chat. Resolve true when the host accepted it. Absent: the button is hidden. */
  sendMessage?(text: string): Promise<boolean>;
  /** Copy text. Default: the Clipboard API, then a hidden textarea with execCommand('copy'). */
  copyText?(text: string): Promise<boolean>;
  /** Ask the host for fullscreen (or back to inline). Absent: the button is hidden. */
  toggleFullscreen?(): Promise<void>;
}

export interface Viewer {
  setData(data: ViewerData): void;
  setLoading(url?: string): void;
  showError(message: string): void;
  /** Run a search and jump to the first hit. Returns the number of hits. */
  search(query: string): number;
  nextMatch(): void;
  prevMatch(): void;
  /** Scroll to the chapter at `index` and focus its first line. */
  jumpToChapter(index: number): void;
  /** Scroll to the line at `index` and focus it. */
  focusLine(index: number): void;
  /** Select lines `from` to `to` (inclusive). */
  selectRange(from: number, to: number): void;
  clearSelection(): void;
  citationFor(index: number): string;
  /** The message "send to chat" posts for the current selection. */
  selectionMessage(): string;
  /** Re-read the container size and re-render (call after layout changes). */
  refresh(): void;
  setFullscreenAvailable(available: boolean, active: boolean): void;
  setSendAvailable(available: boolean): void;
  readonly root: HTMLElement;
}

/** Lines kept above and below the visible area. */
const OVERSCAN = 8;
/** Upper bound on rendered lines, whatever the estimates say. */
export const MAX_RENDERED_LINES = 90;
/** Viewport height used before the container has a layout (and in DOM test environments). */
const FALLBACK_VIEW_HEIGHT = 420;
const FALLBACK_WIDTH = 600;
const LINE_HEIGHT = 20;
const ROW_PADDING = 12;

type Match = { line: number; start: number; end: number };

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

async function defaultCopy(doc: Document, text: string): Promise<boolean> {
  const nav = doc.defaultView?.navigator;
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API refused (no permission in the sandbox); try the textarea route.
  }
  const ta = el(doc, 'textarea', { 'aria-hidden': 'true', readonly: '' });
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  doc.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function originLabel(origin: string): string {
  return origin.replace(/-/g, ' ');
}

export function createViewer(mount: HTMLElement, host: ViewerHost = {}): Viewer {
  const doc = mount.ownerDocument;
  const win = doc.defaultView;

  // ------------------------------------------------------------ static DOM
  const root = el(doc, 'div', { class: 'v2c' });
  const header = el(doc, 'header', { class: 'head' });
  const titleRow = el(doc, 'div', { class: 'title-row' });
  const title = el(doc, 'h1', { class: 'title', id: 'v2c-title' }, 'Transcript viewer');
  const fsBtn = el(doc, 'button', { type: 'button', class: 'btn ghost', 'aria-pressed': 'false' }, 'Expand');
  fsBtn.hidden = true;
  titleRow.append(title, fsBtn);
  const meta = el(doc, 'p', { class: 'meta' });
  header.append(titleRow, meta);

  const chaptersNav = el(doc, 'nav', { class: 'chapters', 'aria-label': 'Chapters' });
  const chaptersList = el(doc, 'ol');
  chaptersNav.append(chaptersList);
  chaptersNav.hidden = true;

  const searchBox = el(doc, 'div', { class: 'search', role: 'search' });
  const searchInput = el(doc, 'input', {
    type: 'search',
    class: 'search-input',
    placeholder: 'Search transcript',
    'aria-label': 'Search transcript',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-keyshortcuts': '/',
  });
  const searchCount = el(doc, 'span', { class: 'count', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const prevBtn = el(doc, 'button', { type: 'button', class: 'btn', 'aria-label': 'Previous match', title: 'Previous match (Shift+Enter)' }, 'Prev');
  const nextBtn = el(doc, 'button', { type: 'button', class: 'btn', 'aria-label': 'Next match', title: 'Next match (Enter)' }, 'Next');
  searchBox.append(searchInput, searchCount, prevBtn, nextBtn);

  const selBar = el(doc, 'div', { class: 'selbar', role: 'region', 'aria-label': 'Selected lines' });
  const selLabel = el(doc, 'span', { class: 'sel-label', 'aria-live': 'polite' });
  const selCopy = el(doc, 'button', { type: 'button', class: 'btn' }, 'Copy citation');
  const selSend = el(doc, 'button', { type: 'button', class: 'btn primary' }, 'Send to chat');
  const selClear = el(doc, 'button', { type: 'button', class: 'btn ghost' }, 'Clear');
  selSend.hidden = !host.sendMessage;
  selBar.append(selLabel, selCopy, selSend, selClear);
  selBar.hidden = true;

  const list = el(doc, 'div', { class: 'list', role: 'list', 'aria-labelledby': 'v2c-title', 'aria-describedby': 'v2c-keys' });
  const spacer = el(doc, 'div', { class: 'spacer' });
  list.append(spacer);

  const keys = el(
    doc,
    'p',
    { class: 'sr-only', id: 'v2c-keys' },
    'Arrow keys move between lines. Enter opens the video at that moment. C copies a citation. Space selects a line, Shift with arrows extends the selection. Slash jumps to search.',
  );
  const notice = el(doc, 'div', { class: 'notice', role: 'status', 'aria-live': 'polite' }, 'Waiting for the transcript.');
  const toast = el(doc, 'div', { class: 'toast', role: 'status', 'aria-live': 'polite' });

  root.append(header, chaptersNav, searchBox, selBar, list, notice, keys, toast);
  mount.replaceChildren(root);
  searchBox.hidden = true;
  list.hidden = true;

  // ------------------------------------------------------------ state
  let data: ViewerData | null = null;
  let segs: SegmentTuple[] = [];
  let lower: string[] = [];
  let heights = new Float64Array(0);
  let offsets = new Float64Array(1);
  let matches: Match[] = [];
  let matchesByLine = new Map<number, Match[]>();
  let current = -1;
  let active = 0;
  let selFrom = -1;
  let selTo = -1;
  let anchor = -1;
  let lastWidth = 0;
  let rafPending = false;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const rows = new Map<number, HTMLElement>();
  const copy = (text: string) => (host.copyText ? host.copyText(text) : defaultCopy(doc, text));

  // ------------------------------------------------------------ geometry
  const viewHeight = () => list.clientHeight || FALLBACK_VIEW_HEIGHT;

  function estimate(text: string, width: number): number {
    const charsPerLine = Math.max(16, Math.floor((width - 140) / 7.5));
    return ROW_PADDING + LINE_HEIGHT * Math.max(1, Math.ceil(text.length / charsPerLine));
  }

  function reestimate(): void {
    const width = list.clientWidth || FALLBACK_WIDTH;
    lastWidth = width;
    for (let i = 0; i < segs.length; i++) {
      heights[i] = estimate(segs[i]?.[2] ?? '', width);
    }
    recomputeOffsets();
  }

  function recomputeOffsets(): void {
    offsets = new Float64Array(segs.length + 1);
    for (let i = 0; i < segs.length; i++) offsets[i + 1] = (offsets[i] ?? 0) + (heights[i] ?? 0);
    spacer.style.height = `${offsets[segs.length] ?? 0}px`;
  }

  /** Index of the line covering vertical position `y`. */
  function lineAt(y: number): number {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid] ?? 0) <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  // ------------------------------------------------------------ rendering
  function fillText(span: HTMLElement, line: number): void {
    const text = segs[line]?.[2] ?? '';
    const hits = matchesByLine.get(line);
    span.replaceChildren();
    if (!hits) {
      span.textContent = text;
      return;
    }
    let pos = 0;
    for (const h of hits) {
      if (h.start > pos) span.append(doc.createTextNode(text.slice(pos, h.start)));
      const mark = el(doc, 'mark', {}, text.slice(h.start, h.end));
      if (matches[current] === h) {
        mark.className = 'current';
        mark.setAttribute('aria-current', 'true');
      }
      span.append(mark);
      pos = h.end;
    }
    if (pos < text.length) span.append(doc.createTextNode(text.slice(pos)));
  }

  function buildRow(i: number): HTMLElement {
    const seg = segs[i] as SegmentTuple;
    const ts = formatTimestamp(seg[0]);
    const row = el(doc, 'div', {
      class: 'row',
      role: 'listitem',
      'data-i': String(i),
      'aria-posinset': String(i + 1),
      'aria-setsize': String(segs.length),
    });
    const sel = el(doc, 'input', { type: 'checkbox', class: 'sel', 'aria-label': `Select line at ${ts}` });
    const url = timestampLink(data?.timestampBase ?? null, seg[0]);
    const link = url
      ? el(doc, 'a', { class: 'ts', href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open video at ${ts}` }, `[${ts}]`)
      : el(doc, 'span', { class: 'ts' }, `[${ts}]`);
    const text = el(doc, 'span', { class: 'text' });
    const cite = el(doc, 'button', { type: 'button', class: 'cite', 'aria-label': `Copy citation for ${ts}`, title: 'Copy citation' }, 'Cite');
    row.append(sel, link, text, cite);
    return row;
  }

  function updateRow(row: HTMLElement, i: number): void {
    row.style.transform = `translateY(${offsets[i] ?? 0}px)`;
    const isActive = i === active;
    row.tabIndex = isActive ? 0 : -1;
    for (const c of row.querySelectorAll<HTMLElement>('a, button, input')) c.tabIndex = isActive ? 0 : -1;
    const selected = selFrom >= 0 && i >= selFrom && i <= selTo;
    row.classList.toggle('selected', selected);
    const box = row.querySelector<HTMLInputElement>('input.sel');
    if (box) box.checked = selected;
    const hit = matchesByLine.has(i);
    row.classList.toggle('hit', hit);
    row.classList.toggle('current-hit', current >= 0 && matches[current]?.line === i);
    const span = row.querySelector<HTMLElement>('.text');
    if (span) fillText(span, i);
  }

  function render(): void {
    if (!data || segs.length === 0) return;
    if ((list.clientWidth || FALLBACK_WIDTH) !== lastWidth) reestimate();
    const top = list.scrollTop;
    const first = lineAt(top);
    const last = lineAt(top + viewHeight());
    let start = Math.max(0, first - OVERSCAN);
    let end = Math.min(segs.length - 1, last + OVERSCAN);
    if (end - start + 1 > MAX_RENDERED_LINES) {
      start = Math.max(0, first - 2);
      end = Math.min(segs.length - 1, start + MAX_RENDERED_LINES - 1);
    }
    // The focused line stays mounted so keyboard focus is never lost to windowing.
    const keep = doc.activeElement?.closest?.('.row') as HTMLElement | null;
    const keepIndex = keep ? Number(keep.dataset.i) : -1;
    for (const [i, row] of rows) {
      if ((i < start || i > end) && i !== keepIndex) {
        row.remove();
        rows.delete(i);
      }
    }
    for (let i = start; i <= end; i++) {
      let row = rows.get(i);
      if (!row) {
        row = buildRow(i);
        rows.set(i, row);
        spacer.append(row);
      }
      updateRow(row, i);
    }
    measure(first);
    updateChapterMarker(first);
  }

  /** Replace estimates with real heights; keep the line at the top of the view steady. */
  function measure(topLine: number): void {
    let changed = false;
    let shiftAbove = 0;
    for (const [i, row] of rows) {
      const h = row.offsetHeight;
      if (h > 0 && Math.abs(h - (heights[i] ?? 0)) > 0.5) {
        if (i < topLine) shiftAbove += h - (heights[i] ?? 0);
        heights[i] = h;
        changed = true;
      }
    }
    if (!changed) return;
    recomputeOffsets();
    if (shiftAbove !== 0) list.scrollTop += shiftAbove;
    for (const [i, row] of rows) row.style.transform = `translateY(${offsets[i] ?? 0}px)`;
  }

  function schedule(): void {
    if (rafPending) return;
    rafPending = true;
    const run = () => {
      rafPending = false;
      render();
    };
    if (win?.requestAnimationFrame) win.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function scrollToLine(i: number, align: 'center' | 'start' = 'center'): void {
    const target = () => {
      const h = heights[i] ?? 0;
      const y = offsets[i] ?? 0;
      return align === 'start' ? y : y - (viewHeight() - h) / 2;
    };
    list.scrollTop = Math.max(0, target());
    render();
    // Measuring may have moved the line; settle once more.
    list.scrollTop = Math.max(0, target());
    render();
  }

  function setActive(i: number, focus: boolean): void {
    const prev = active;
    active = Math.max(0, Math.min(segs.length - 1, i));
    const prevRow = rows.get(prev);
    if (prevRow) updateRow(prevRow, prev);
    const row = rows.get(active);
    if (row) {
      updateRow(row, active);
      if (focus) row.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------ chapters
  function chapterLine(sec: number): number {
    const idx = segs.findIndex((s) => s[1] > sec);
    return idx === -1 ? Math.max(0, segs.length - 1) : idx;
  }

  function renderChapters(): void {
    chaptersList.replaceChildren();
    const chapters = data?.chapters ?? [];
    chaptersNav.hidden = chapters.length === 0;
    chapters.forEach((c, n) => {
      const li = el(doc, 'li');
      const b = el(doc, 'button', { type: 'button', class: 'chap', 'data-n': String(n) });
      b.append(el(doc, 'span', { class: 'chap-ts' }, formatTimestamp(c.startSec)), el(doc, 'span', { class: 'chap-title' }, c.title));
      b.setAttribute('aria-label', `Chapter ${n + 1}: ${c.title}, at ${formatTimestamp(c.startSec)}`);
      li.append(b);
      chaptersList.append(li);
    });
  }

  function updateChapterMarker(topLine: number): void {
    const chapters = data?.chapters ?? [];
    if (chapters.length === 0) return;
    const sec = segs[topLine]?.[0] ?? 0;
    let cur = 0;
    for (let n = 0; n < chapters.length; n++) if ((chapters[n]?.startSec ?? 0) <= sec + 0.01) cur = n;
    for (const b of chaptersList.querySelectorAll<HTMLElement>('.chap')) {
      if (Number(b.dataset.n) === cur) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
  }

  function jumpToChapter(n: number): void {
    const c = data?.chapters[n];
    if (!c) return;
    const line = chapterLine(c.startSec);
    scrollToLine(line, 'start');
    setActive(line, true);
    updateChapterMarker(line);
  }

  // ------------------------------------------------------------ search
  function search(query: string): number {
    const q = query.trim().toLowerCase();
    matches = [];
    matchesByLine = new Map();
    current = -1;
    if (q) {
      for (let i = 0; i < lower.length && matches.length < 10_000; i++) {
        const text = lower[i] ?? '';
        let at = text.indexOf(q);
        while (at !== -1) {
          const m = { line: i, start: at, end: at + q.length };
          matches.push(m);
          const arr = matchesByLine.get(i);
          if (arr) arr.push(m);
          else matchesByLine.set(i, [m]);
          at = text.indexOf(q, at + q.length);
        }
      }
    }
    if (matches.length > 0) goToMatch(0);
    else {
      for (const [i, row] of rows) updateRow(row, i);
      updateCount();
    }
    return matches.length;
  }

  function updateCount(): void {
    const q = searchInput.value.trim();
    searchCount.textContent = !q ? '' : matches.length === 0 ? 'No matches' : `${current + 1} of ${matches.length}`;
    prevBtn.disabled = matches.length === 0;
    nextBtn.disabled = matches.length === 0;
  }

  function goToMatch(n: number): void {
    if (matches.length === 0) return;
    current = ((n % matches.length) + matches.length) % matches.length;
    const line = matches[current]?.line ?? 0;
    active = line;
    scrollToLine(line);
    for (const [i, row] of rows) updateRow(row, i);
    updateCount();
  }

  // ------------------------------------------------------------ selection and citations
  function selectRange(from: number, to: number): void {
    if (segs.length === 0) return;
    selFrom = Math.max(0, Math.min(from, to));
    selTo = Math.min(segs.length - 1, Math.max(from, to));
    updateSelection();
  }

  function clearSelection(): void {
    selFrom = -1;
    selTo = -1;
    anchor = -1;
    updateSelection();
  }

  function updateSelection(): void {
    for (const [i, row] of rows) updateRow(row, i);
    if (selFrom < 0) {
      selBar.hidden = true;
      return;
    }
    const count = selTo - selFrom + 1;
    const from = formatTimestamp(segs[selFrom]?.[0] ?? 0);
    const to = formatTimestamp(segs[selTo]?.[0] ?? 0);
    selLabel.textContent = count === 1 ? `1 line at ${from}` : `${count} lines, ${from} to ${to}`;
    selBar.hidden = false;
  }

  function toggleLine(i: number, extend: boolean): void {
    if (extend && anchor >= 0) {
      selectRange(anchor, i);
      return;
    }
    if (selFrom >= 0 && i >= selFrom && i <= selTo) {
      if (selFrom === selTo) clearSelection();
      else if (i === selFrom) selectRange(selFrom + 1, selTo);
      else if (i === selTo) selectRange(selFrom, selTo - 1);
      else selectRange(i, i);
      return;
    }
    anchor = i;
    selectRange(i, i);
  }

  function citationFor(i: number): string {
    const seg = segs[i];
    if (!data || !seg) return '';
    return citation(data.metadata.title, seg[0], data.timestampBase);
  }

  function selectionMessage(): string {
    if (!data || selFrom < 0) return '';
    const m = data.metadata;
    const lines = segs.slice(selFrom, selTo + 1).map((s) => `[${formatTimestamp(s[0])}] ${s[2].trim()}`);
    const from = formatTimestamp(segs[selFrom]?.[0] ?? 0);
    const to = formatTimestamp(segs[selTo]?.[0] ?? 0);
    const range = from === to ? from : `${from} to ${to}`;
    const by = m.channel ? ` (${m.channel})` : '';
    return `From "${m.title}"${by}, ${range}:\n\n${lines.join('\n')}\n\nSource: ${citationFor(selFrom)}`;
  }

  function flash(message: string): void {
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  async function copyCitation(text: string): Promise<void> {
    const ok = await copy(text);
    flash(ok ? 'Citation copied' : `Copy blocked by the host. Citation: ${text}`);
  }

  async function openAt(url: string): Promise<void> {
    if (host.openLink) {
      const ok = await host.openLink(url).catch(() => false);
      if (ok) return;
    }
    win?.open(url, '_blank', 'noopener,noreferrer');
  }

  // ------------------------------------------------------------ events
  list.addEventListener('scroll', schedule, { passive: true });
  win?.addEventListener('resize', schedule);

  list.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const row = target.closest<HTMLElement>('.row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (target.closest('a.ts')) {
      if (host.openLink) {
        ev.preventDefault();
        void openAt((target.closest('a.ts') as HTMLAnchorElement).href);
      }
      setActive(i, false);
      return;
    }
    if (target.closest('button.cite')) {
      setActive(i, false);
      void copyCitation(citationFor(i));
      return;
    }
    if (target.closest('input.sel')) {
      toggleLine(i, (ev as MouseEvent).shiftKey);
      setActive(i, false);
      return;
    }
    setActive(i, false);
  });

  list.addEventListener('keydown', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.row');
    if (!row || segs.length === 0) return;
    const onRow = ev.target === row;
    const i = Number(row.dataset.i);
    const page = Math.max(1, Math.floor(viewHeight() / (LINE_HEIGHT + ROW_PADDING)) - 1);
    let next = -1;
    switch (ev.key) {
      case 'ArrowDown':
        next = i + 1;
        break;
      case 'ArrowUp':
        next = i - 1;
        break;
      case 'PageDown':
        next = i + page;
        break;
      case 'PageUp':
        next = i - page;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = segs.length - 1;
        break;
      case 'Enter': {
        if (!onRow) return;
        const url = timestampLink(data?.timestampBase ?? null, segs[i]?.[0] ?? 0);
        if (url) void openAt(url);
        ev.preventDefault();
        return;
      }
      case ' ':
        if (!onRow) return;
        ev.preventDefault();
        toggleLine(i, ev.shiftKey);
        return;
      case 'c':
      case 'C':
        if (!onRow || ev.ctrlKey || ev.metaKey) return;
        ev.preventDefault();
        void copyCitation(citationFor(i));
        return;
      case 'Escape':
        if (selFrom >= 0) {
          ev.preventDefault();
          clearSelection();
        }
        return;
      default:
        return;
    }
    ev.preventDefault();
    next = Math.max(0, Math.min(segs.length - 1, next));
    if (ev.shiftKey && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      if (anchor < 0) anchor = i;
      selectRange(anchor, next);
    }
    const top = list.scrollTop;
    const y = offsets[next] ?? 0;
    const h = heights[next] ?? 0;
    if (y < top || y + h > top + viewHeight()) scrollToLine(next, y < top ? 'start' : 'center');
    else render();
    setActive(next, true);
  });

  chaptersList.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('.chap');
    if (b) jumpToChapter(Number(b.dataset.n));
  });

  searchInput.addEventListener('input', () => {
    search(searchInput.value);
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      goToMatch(ev.shiftKey ? current - 1 : current + 1);
    } else if (ev.key === 'Escape' && searchInput.value) {
      ev.preventDefault();
      searchInput.value = '';
      search('');
    }
  });
  prevBtn.addEventListener('click', () => goToMatch(current - 1));
  nextBtn.addEventListener('click', () => goToMatch(current + 1));

  doc.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement | null;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && (t as HTMLInputElement).type !== 'checkbox';
    if (ev.key === '/' && !typing && !searchBox.hidden) {
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  selCopy.addEventListener('click', () => {
    if (selFrom >= 0) void copyCitation(citationFor(selFrom));
  });
  selClear.addEventListener('click', clearSelection);
  selSend.addEventListener('click', async () => {
    if (!host.sendMessage || selFrom < 0) return;
    const ok = await host.sendMessage(selectionMessage()).catch(() => false);
    flash(ok ? 'Sent to chat' : 'The host did not accept the message');
  });
  fsBtn.addEventListener('click', () => {
    void host.toggleFullscreen?.();
  });

  // ------------------------------------------------------------ public API
  function setData(d: ViewerData): void {
    data = d;
    segs = d.segments;
    lower = segs.map((s) => s[2].toLowerCase());
    heights = new Float64Array(segs.length);
    for (const row of rows.values()) row.remove();
    rows.clear();
    matches = [];
    matchesByLine = new Map();
    current = -1;
    active = 0;
    selFrom = selTo = anchor = -1;
    selBar.hidden = true;

    const m = d.metadata;
    title.textContent = m.title;
    const parts = [
      m.channel,
      m.durationSec !== undefined ? formatTimestamp(m.durationSec) : undefined,
      `${originLabel(m.origin)}, ${m.language}${m.translated ? ', machine-translated' : ''}`,
      `${segs.length} lines`,
    ].filter(Boolean);
    meta.textContent = parts.join(' · ');
    list.setAttribute('aria-label', `Transcript of ${m.title}, ${segs.length} lines`);
    list.removeAttribute('aria-labelledby');
    renderChapters();

    const empty = segs.length === 0;
    notice.textContent = empty ? 'This video has no transcript lines.' : '';
    notice.hidden = !empty;
    searchBox.hidden = empty;
    list.hidden = empty;
    searchInput.value = '';
    updateCount();
    list.scrollTop = 0;
    reestimate();
    render();
  }

  function setLoading(url?: string): void {
    if (data) return;
    notice.hidden = false;
    notice.textContent = url ? `Loading the transcript for ${url}` : 'Loading the transcript.';
  }

  function showError(message: string): void {
    notice.hidden = false;
    notice.textContent = message;
    notice.classList.add('error');
  }

  return {
    root,
    setData,
    setLoading,
    showError,
    search: (q: string) => {
      searchInput.value = q;
      return search(q);
    },
    nextMatch: () => goToMatch(current + 1),
    prevMatch: () => goToMatch(current - 1),
    jumpToChapter,
    focusLine: (i: number) => {
      scrollToLine(i);
      setActive(i, true);
    },
    selectRange: (from: number, to: number) => {
      anchor = from;
      selectRange(from, to);
    },
    clearSelection,
    citationFor,
    selectionMessage,
    refresh: () => {
      lastWidth = -1;
      render();
    },
    setFullscreenAvailable: (available: boolean, isActive: boolean) => {
      fsBtn.hidden = !available;
      fsBtn.textContent = isActive ? 'Exit full screen' : 'Expand';
      fsBtn.setAttribute('aria-pressed', String(isActive));
      root.classList.toggle('fill', isActive);
    },
    setSendAvailable: (available: boolean) => {
      selSend.hidden = !available || !host.sendMessage;
    },
  };
}
