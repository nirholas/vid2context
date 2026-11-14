/**
 * Calls the public HTTP API (GET /api/v1/transcript) from the browser and
 * shows the transcript, or the error with its hint and every attempt.
 */
import { type FormEvent, useId, useState } from 'react';

interface Attempt {
  stage: string;
  id: string;
  outcome: string;
  reason?: string;
  detail?: string;
}

interface ErrorBody {
  error?: { code: string; message: string; hint?: string };
  attempts?: Attempt[];
}

type Result =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; body: string; ms: number }
  | { kind: 'error'; message: string; hint?: string; attempts: Attempt[] };

interface Props {
  endpoint: string;
  initialUrl: string;
}

export default function LiveDemo({ endpoint, initialUrl }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [timestamps, setTimestamps] = useState(true);
  const [format, setFormat] = useState('text');
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const id = useId();

  async function run(e: FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams({ url: url.trim(), format });
    if (timestamps) params.set('timestamps', '1');
    setResult({ kind: 'loading' });
    const started = performance.now();
    try {
      const res = await fetch(`${endpoint}?${params}`);
      const text = await res.text();
      if (res.ok) {
        const body = format === 'json' ? JSON.stringify(JSON.parse(text), null, 2) : text;
        setResult({ kind: 'ok', body, ms: Math.round(performance.now() - started) });
        return;
      }
      let parsed: ErrorBody | null = null;
      try {
        parsed = JSON.parse(text) as ErrorBody;
      } catch {
        parsed = null;
      }
      setResult({
        kind: 'error',
        message: parsed?.error ? `${parsed.error.code}: ${parsed.error.message}` : `HTTP ${res.status}`,
        hint: parsed?.error?.hint,
        attempts: parsed?.attempts ?? [],
      });
    } catch (err) {
      setResult({ kind: 'error', message: `Request failed: ${(err as Error).message}`, attempts: [] });
    }
  }

  return (
    <div className="live">
      <form onSubmit={run} className="live-form">
        <label htmlFor={`${id}-url`} className="sr-only">
          Video URL
        </label>
        <input
          id={`${id}-url`}
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="live-input"
          spellCheck={false}
        />
        <button type="submit" className="btn btn-primary" disabled={result.kind === 'loading'}>
          {result.kind === 'loading' ? 'Fetching' : 'Get transcript'}
        </button>
      </form>
      <div className="live-opts">
        <label>
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> Timestamps
        </label>
        <label>
          Format{' '}
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="text">text</option>
            <option value="markdown">markdown</option>
            <option value="srt">srt</option>
            <option value="json">json</option>
          </select>
        </label>
      </div>
      <div aria-live="polite" className="live-out">
        {result.kind === 'ok' && (
          <>
            <p className="live-msg ok">Done in {(result.ms / 1000).toFixed(1)} s.</p>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
            <pre tabIndex={0}>{result.body}</pre>
          </>
        )}
        {result.kind === 'error' && (
          <>
            <p className="live-msg err">{result.message}</p>
            {result.hint && <p className="live-hint">{result.hint}</p>}
            {result.attempts.length > 0 && (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1)
              <pre tabIndex={0}>
                {`Attempts:\n${result.attempts
                  .map(
                    (a) =>
                      `  ${a.stage.padEnd(9)}${a.outcome.padEnd(8)}${a.id}${a.reason ? `  ${a.reason}` : ''}${a.detail ? `  ${a.detail}` : ''}`,
                  )
                  .join('\n')}`}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
