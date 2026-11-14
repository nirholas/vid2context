/** One response on the API page: status line, error summary, body (streamed, pretty JSON or a .zip) and headers. */
import { Download } from 'lucide-react';
import { useState } from 'react';
import { saveBlob } from '../../lib/download.ts';
import { type Answer, displayText, errorOf, formatBytes, formatMs, type Outcome } from '../../lib/playground-send.ts';
import { Tabs } from '../Tabs.tsx';
import { Button, CopyButton, Spinner } from '../ui.tsx';

/** Bodies longer than this are cut until the user asks for all of it, so a long transcript does not stall the page. */
const SHOW_CHARS = 120_000;

export function StatusDot({ status }: { status: number }) {
  const color = status >= 200 && status < 300 ? 'bg-success' : status >= 300 && status < 400 ? 'bg-subtle' : 'bg-danger';
  return <span className={`size-2 shrink-0 rounded-full ${color}`} aria-hidden />;
}

function Body({ text, streaming }: { text: string; streaming?: boolean }) {
  const [all, setAll] = useState(false);
  const cut = !all && text.length > SHOW_CHARS;
  return (
    <div className="space-y-2">
      <pre
        className="max-h-[60vh] overflow-auto rounded-v2c border border-border bg-surface-2 p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-fg"
        data-testid="api-response-body"
        aria-busy={streaming || undefined}
      >
        {cut ? text.slice(0, SHOW_CHARS) : text || (streaming ? '' : '(empty body)')}
      </pre>
      {cut && (
        <Button variant="ghost" className="text-xs" onClick={() => setAll(true)}>
          Show all {formatBytes(new Blob([text]).size)}
        </Button>
      )}
    </div>
  );
}

function Headers({ headers }: { headers: [string, string][] }) {
  return (
    <div className="overflow-x-auto rounded-v2c border border-border">
      <table className="w-full text-left text-[12.5px]">
        <tbody>
          {headers.map(([k, v]) => (
            <tr key={k} className="border-b border-border last:border-0">
              <th scope="row" className="whitespace-nowrap px-3 py-1.5 align-top font-mono font-normal text-muted">
                {k}
              </th>
              <td className="px-3 py-1.5 font-mono break-all text-fg">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Meta({ a }: { a: Partial<Answer> }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {a.firstByteMs !== undefined && <span title="Time to the response headers">first byte {formatMs(a.firstByteMs)}</span>}
      {a.ms !== undefined && <span title="Time to the last byte">total {formatMs(a.ms)}</span>}
      {a.bytes !== undefined && <span>{formatBytes(a.bytes)}</span>}
      {a.contentType && <span className="font-mono">{a.contentType.split(';')[0]}</span>}
    </span>
  );
}

export function ResponseView({ outcome }: { outcome: Outcome }) {
  const [tab, setTab] = useState('body');

  if (outcome.state === 'failed') {
    return (
      <div role="alert" className="rounded-v2c border border-danger/60 bg-surface p-4 text-sm">
        <p className="font-medium text-fg">No response</p>
        <p className="mt-1 text-muted">{outcome.message}</p>
      </div>
    );
  }

  if (outcome.state === 'sending' || outcome.state === 'canceled') {
    const p = outcome.partial;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm" role="status">
          {outcome.state === 'sending' ? <Spinner /> : null}
          {p?.status !== undefined ? (
            <span className="flex items-center gap-2 font-medium text-fg">
              <StatusDot status={p.status} />
              {p.status} {p.statusText}
            </span>
          ) : null}
          <span className="text-muted">
            {outcome.state === 'canceled' ? 'Canceled' : p?.status !== undefined ? 'Receiving' : 'Waiting for the server'}
          </span>
          {p && <Meta a={p} />}
        </div>
        {p?.text !== undefined && <Body text={p.text} streaming={outcome.state === 'sending'} />}
      </div>
    );
  }

  const a = outcome.answer;
  const err = errorOf(a);
  const text = displayText(a);
  return (
    <div className="space-y-3" data-testid="api-response" data-status={a.status}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2 text-sm font-medium text-fg" role="status">
          <StatusDot status={a.status} />
          {a.status} {a.statusText}
        </span>
        <Meta a={a} />
        {!a.blob && (
          <span className="ml-auto">
            <CopyButton getText={() => text} label="Copy body" variant="ghost" className="text-xs" />
          </span>
        )}
      </div>

      {err && (
        <div className="rounded-v2c border border-danger/60 bg-surface p-4 text-sm">
          <p className="text-fg">
            <code className="mr-2 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-xs">{err.code}</code>
            {err.message}
          </p>
          {err.hint && <p className="mt-2 text-muted">{err.hint}</p>}
        </div>
      )}

      <Tabs
        label="Response"
        active={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'body',
            label: 'Body',
            render: () =>
              a.blob ? (
                <div className="flex flex-wrap items-center gap-3 rounded-v2c border border-border bg-surface-2 p-4 text-sm">
                  <span className="text-fg">
                    {a.filename ?? 'response'} ({formatBytes(a.blob.size)})
                  </span>
                  <Button variant="accent" onClick={() => a.blob && saveBlob(a.blob, a.filename ?? 'vid2context.zip')}>
                    <Download className="size-4" aria-hidden /> Download
                  </Button>
                </div>
              ) : (
                <Body text={text} />
              ),
          },
          { id: 'headers', label: 'Headers', badge: a.headers.length, render: () => <Headers headers={a.headers} /> },
        ]}
      />
    </div>
  );
}
