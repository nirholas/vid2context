import { AlertCircle, Check, Copy, Download, ExternalLink, FileText, Loader2, Settings as SettingsIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { PageNotice } from '../background/inject.ts';
import { describeError, transcriptViaApi } from '../lib/api.ts';
import { ext } from '../lib/browser.ts';
import { addHistory, getHistory, type HistoryAction, type HistoryItem } from '../lib/history.ts';
import { appLink, isWebUrl, originPattern, youtubeWatchId } from '../lib/links.ts';
import { type BackgroundRequest, LAST_RESULT_KEY } from '../lib/messages.ts';
import { DEFAULT_SETTINGS, loadSettings, type Settings } from '../lib/settings.ts';
import { Button } from '../ui/Button.tsx';
import { Logo } from '../ui/Logo.tsx';
import { type ActiveTab, activeTab, sendToContent } from './tab.ts';

type Status = { kind: 'busy' | 'ok' | 'error'; message: string; hint?: string } | null;
type YouTubeState = { state: 'loading' } | { state: 'ready'; hasCaptions: boolean; title?: string } | { state: 'unreachable' };
type LastResult = PageNotice & { at: string };

const ACTION_LABEL: Record<HistoryAction, string> = {
  copy: 'Copied for AI',
  zip: 'Downloaded .zip',
  open: 'Opened in vid2context',
  'api-copy': 'Copied via API',
};

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function Popup() {
  const [tab, setTab] = useState<ActiveTab>({});
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [yt, setYt] = useState<YouTubeState | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [readyText, setReadyText] = useState<string | null>(null);
  const [last, setLast] = useState<LastResult | null>(null);

  const videoId = youtubeWatchId(tab.url);
  const webPage = isWebUrl(tab.url);

  useEffect(() => {
    void (async () => {
      const [t, s, h, stored] = await Promise.all([
        activeTab(),
        loadSettings(ext.storage.sync),
        getHistory(ext.storage.local),
        ext.storage.local.get(LAST_RESULT_KEY),
      ]);
      setTab(t);
      setSettings(s);
      setHistory(h);
      setLast((stored[LAST_RESULT_KEY] as LastResult | undefined) ?? null);
      if (youtubeWatchId(t.url) && t.id !== undefined) {
        setYt({ state: 'loading' });
        try {
          const res = await sendToContent(t.id, { type: 'v2c:status' });
          setYt(res.ok ? { state: 'ready', hasCaptions: res.hasCaptions !== false, title: res.title } : { state: 'unreachable' });
        } catch {
          setYt({ state: 'unreachable' });
        }
      }
    })();
  }, []);

  const refreshHistory = () => void getHistory(ext.storage.local).then(setHistory);

  const writeClipboard = async (text: string, okMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setReadyText(null);
      setStatus({ kind: 'ok', message: okMessage });
    } catch {
      setReadyText(text);
      setStatus({ kind: 'ok', message: 'Ready. Press Copy to put it on the clipboard.' });
    }
  };

  const copyForAi = async () => {
    if (tab.id === undefined) return;
    setStatus({ kind: 'busy', message: 'Reading captions from the page...' });
    try {
      const res = await sendToContent(tab.id, { type: 'v2c:build-copy' });
      if (!res.ok) return setStatus({ kind: 'error', message: res.message, hint: res.hint });
      await writeClipboard(res.text ?? '', res.via === 'agentPrompt' ? 'Copied the agent prompt.' : `Copied as ${res.via}.`);
      refreshHistory();
    } catch (err) {
      setStatus({ kind: 'error', ...describeError(err) });
    }
  };

  const downloadZip = async () => {
    if (tab.id === undefined) return;
    setStatus({ kind: 'busy', message: 'Building the bundle...' });
    try {
      const res = await sendToContent(tab.id, { type: 'v2c:download-zip' });
      if (!res.ok) return setStatus({ kind: 'error', message: res.message, hint: res.hint });
      setStatus({ kind: 'ok', message: 'Download started.' });
      refreshHistory();
    } catch (err) {
      setStatus({ kind: 'error', ...describeError(err) });
    }
  };

  const openInApp = async () => {
    if (!tab.url) return;
    const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : tab.url;
    const msg: BackgroundRequest = { type: 'v2c:open-app', url, title: yt?.state === 'ready' ? (yt.title ?? url) : (tab.title ?? url) };
    await ext.runtime.sendMessage(msg).catch(() => ext.tabs.create({ url: appLink(settings.appBase, url) }));
    window.close();
  };

  const copyViaApi = () => {
    const url = tab.url;
    if (!url) return;
    // Request the API host inside the click, before any await, so the browser treats it as a user action.
    const permission = ext.permissions.request({ origins: [originPattern(settings.apiBase)] });
    setStatus({ kind: 'busy', message: `Asking ${new URL(settings.apiBase).host}...` });
    void (async () => {
      try {
        if (!(await permission)) {
          return setStatus({ kind: 'error', message: 'Permission to reach the API was not granted.', hint: 'Allow it, or change the API base in Options.' });
        }
        const text = await transcriptViaApi(url, settings, fetch);
        await writeClipboard(text, 'Transcript copied.');
        await addHistory(ext.storage.local, { url, title: tab.title ?? url, action: 'api-copy', at: new Date().toISOString() });
        refreshHistory();
      } catch (err) {
        setStatus({ kind: 'error', ...describeError(err) });
      }
    })();
  };

  const dismissLast = async () => {
    setLast(null);
    await ext.storage.local.remove(LAST_RESULT_KEY);
    await ext.action.setBadgeText({ text: '' });
  };

  return (
    <div className="flex w-[360px] flex-col gap-4 bg-bg p-4 text-text">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="text-base font-semibold tracking-tight">vid2context</span>
        </div>
        <button
          type="button"
          onClick={() => void ext.runtime.openOptionsPage()}
          className="rounded-pill p-2 text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Options"
          title="Options"
        >
          <SettingsIcon size={16} />
        </button>
      </header>

      <section className="rounded-lg border border-border bg-surface p-4">
        <p className="mb-1 text-xs uppercase tracking-wide text-subtle">
          {videoId ? 'YouTube video' : webPage ? 'This page' : 'This tab'}
        </p>
        <p className="line-clamp-2 text-sm font-medium" title={tab.title}>
          {(yt?.state === 'ready' && yt.title) || tab.title || 'No page'}
        </p>
        {tab.url && webPage && <p className="mt-0.5 truncate text-xs text-subtle">{hostOf(tab.url)}</p>}

        <div className="mt-4 flex flex-col gap-2">
          {videoId && (
            <>
              {yt?.state === 'ready' && !yt.hasCaptions && (
                <Notice kind="info" message="This video has no captions." hint="Open it in vid2context to transcribe the audio." />
              )}
              {yt?.state === 'unreachable' && (
                <Notice kind="info" message="Could not reach the page." hint="Reload the YouTube tab, then open this popup again." />
              )}
              <Button
                variant="primary"
                icon={<Copy size={16} />}
                onClick={() => void copyForAi()}
                disabled={yt?.state !== 'ready' || !yt.hasCaptions || status?.kind === 'busy'}
              >
                Copy for AI
              </Button>
              <Button
                icon={<Download size={16} />}
                onClick={() => void downloadZip()}
                disabled={yt?.state !== 'ready' || !yt.hasCaptions || status?.kind === 'busy'}
              >
                Download .zip
              </Button>
              <Button icon={<ExternalLink size={16} />} onClick={() => void openInApp()}>
                Open in vid2context
              </Button>
            </>
          )}
          {!videoId && webPage && (
            <>
              <Button variant="primary" icon={<ExternalLink size={16} />} onClick={() => void openInApp()}>
                Get context with vid2context
              </Button>
              <Button icon={<FileText size={16} />} onClick={copyViaApi} disabled={status?.kind === 'busy'}>
                Copy transcript (via API)
              </Button>
            </>
          )}
          {!webPage && <p className="text-sm text-muted">Open a page with a video to use vid2context here.</p>}
        </div>

        {status && <StatusLine status={status} />}
        {readyText !== null && (
          <Button className="mt-2 w-full" variant="primary" icon={<Copy size={16} />} onClick={() => void writeClipboard(readyText, 'Copied.')}>
            Copy
          </Button>
        )}
      </section>

      {last && (
        <section className="rounded-lg border border-border bg-surface p-4">
          <Notice kind={last.kind === 'error' ? 'error' : 'info'} message={last.message} hint={last.hint} />
          <div className="mt-3 flex justify-end gap-2">
            {last.text !== undefined && (
              <Button variant="primary" icon={<Copy size={16} />} onClick={() => void writeClipboard(last.text ?? '', 'Copied.').then(dismissLast)}>
                Copy
              </Button>
            )}
            <Button variant="ghost" onClick={() => void dismissLast()}>
              Dismiss
            </Button>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-subtle">Recent</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet. Items you copy, download or open show up here.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {history.map((item) => (
              <li key={item.url} className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => void ext.tabs.create({ url: item.url })}
                  title={item.url}
                >
                  <span className="block truncate text-sm">{item.title}</span>
                  <span className="block truncate text-xs text-subtle">
                    {ACTION_LABEL[item.action]} · {ago(item.at)}
                  </span>
                </button>
                <button
                  type="button"
                  className="rounded-pill p-1.5 text-muted hover:bg-surface-2 hover:text-text"
                  onClick={() => void ext.tabs.create({ url: appLink(settings.appBase, item.url) })}
                  aria-label={`Open ${item.title} in vid2context`}
                  title="Open in vid2context"
                >
                  <ExternalLink size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Notice({ kind, message, hint }: { kind: 'info' | 'error'; message: string; hint?: string }) {
  return (
    <div className={`flex gap-2 text-sm ${kind === 'error' ? 'text-danger' : 'text-muted'}`}>
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      <div>
        <p className={kind === 'error' ? 'text-danger' : 'text-text'}>{message}</p>
        {hint && <p className="text-muted">{hint}</p>}
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: NonNullable<Status> }): ReactNode {
  if (status.kind === 'error') return <div className="mt-3"><Notice kind="error" message={status.message} hint={status.hint} /></div>;
  return (
    <p className={`mt-3 flex items-center gap-2 text-sm ${status.kind === 'ok' ? 'text-success' : 'text-muted'}`} role="status">
      {status.kind === 'busy' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
      {status.message}
    </p>
  );
}
