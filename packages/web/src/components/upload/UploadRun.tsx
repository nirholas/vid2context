/**
 * A dropped file, step by step: read, decode, convert to 16 kHz mono, then
 * either upload it to the API (POST /uploads, then run upload:<sha256>) or,
 * in client-only mode, transcribe it here in the browser. Loaded on demand.
 */
import { CircleCheck, CircleDashed } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Prepared, PrepareStage } from '../../audio/prepare.ts';
import { prepareFile } from '../../audio/prepare.ts';
import { uploadFile } from '../../lib/api.ts';
import { resultBundle } from '../../lib/bundle.ts';
import { isAbort } from '../../lib/errors.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { putEntry, summarize } from '../../lib/history.ts';
import { navigate, runSearch } from '../../lib/route.ts';
import { loadProviderKeys } from '../../lib/settings.ts';
import { ErrorPanel } from '../ErrorPanel.tsx';
import type { RunOptions } from '../home/Options.tsx';
import { Button, Card, ProgressBar, Spinner } from '../ui.tsx';

type StepId = 'read' | 'decode' | 'encode' | 'upload' | 'model' | 'transcribe';

const LABELS: Record<StepId, string> = {
  read: 'Read the file',
  decode: 'Decode the audio',
  encode: 'Convert to 16 kHz mono',
  upload: 'Upload',
  model: 'Load the speech model',
  transcribe: 'Transcribe in this browser',
};

export function UploadRun({
  file,
  options,
  clientOnly,
  onCancel,
}: {
  file: File;
  options: RunOptions;
  clientOnly: boolean;
  onCancel: () => void;
}) {
  const steps: StepId[] = clientOnly
    ? ['read', 'decode', 'encode', 'model', 'transcribe']
    : ['read', 'decode', 'encode', 'upload'];
  const [step, setStep] = useState<StepId>('read');
  const [percent, setPercent] = useState<number | undefined>(0);
  const [prepared, setPrepared] = useState<Prepared>();
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const go = useCallback(
    async (signal: AbortSignal) => {
      setError(undefined);
      setPrepared(undefined);
      const t0 = performance.now();
      const p = await prepareFile(
        file,
        (s: PrepareStage) => {
          if (s.stage === 'reading') {
            setStep('read');
            setPercent(s.total ? (s.loaded / s.total) * 100 : undefined);
          } else {
            setStep(s.stage === 'decoding' ? 'decode' : 'encode');
            setPercent(undefined);
          }
        },
        signal,
      );
      const decodeMs = Math.round(performance.now() - t0);
      setPrepared(p);

      if (!clientOnly) {
        setStep('upload');
        setPercent(0);
        const res = await uploadFile(
          p.upload.blob,
          p.upload.filename,
          (loaded, total) => setPercent((loaded / total) * 100),
          signal,
        );
        navigate(runSearch({ ...options, url: res.input }));
        return;
      }

      setStep('model');
      setPercent(undefined);
      const [{ transcribeInBrowser, localInput }, keys] = await Promise.all([
        import('../../audio/local.ts'),
        loadProviderKeys().catch(() => ({})),
      ]);
      const context = await transcribeInBrowser(
        p,
        {
          lang: options.lang || undefined,
          keys,
          decodeMs,
          onModel: (m) => {
            if (m.status === 'ready') {
              setStep('transcribe');
              setPercent(undefined);
            } else {
              setStep('model');
              setPercent(m.percent);
            }
          },
        },
        signal,
      );
      const input = localInput(p.sha256);
      const bundle = await resultBundle([context], { timestamps: options.timestamps });
      await putEntry(summarize(context, { input, mode: options.mode, lang: options.lang }, bundle.files.length));
      navigate(runSearch({ ...options, url: input }));
    },
    [file, options, clientOnly],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt restarts the run on "Try again"
  useEffect(() => {
    const ac = new AbortController();
    abort.current = ac;
    go(ac.signal).catch((err) => {
      if (!isAbort(err)) setError(err);
    });
    return () => ac.abort();
  }, [go, attempt]);

  const current = steps.indexOf(step);

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-fg">
              {clientOnly ? 'Transcribing in your browser' : 'Preparing your file'}
            </h2>
            <p className="truncate font-mono text-sm text-muted">
              {file.name} ({formatBytes(file.size)})
            </p>
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              abort.current?.abort();
              onCancel();
            }}
          >
            {error ? 'Choose another file' : 'Cancel'}
          </Button>
        </div>
        <ol className="mt-4 space-y-2.5" aria-label="Steps">
          {steps.map((s, i) => {
            const done = i < current;
            const active = i === current && !error;
            return (
              <li key={s} className="space-y-1.5" aria-current={active ? 'step' : undefined}>
                <div className="flex items-center gap-2 text-sm">
                  {done ? (
                    <CircleCheck className="size-4 text-success" aria-hidden />
                  ) : active ? (
                    <Spinner className="text-accent" />
                  ) : (
                    <CircleDashed className="size-4 text-subtle" aria-hidden />
                  )}
                  <span className={done || active ? 'text-fg' : 'text-muted'}>{LABELS[s]}</span>
                  <span className="sr-only">{done ? '(done)' : active ? '(in progress)' : '(waiting)'}</span>
                  {active && percent !== undefined && (
                    <span className="text-xs text-muted tabular-nums">{Math.round(percent)}%</span>
                  )}
                </div>
                {active && (s === 'read' || s === 'upload' || s === 'model') && <ProgressBar value={percent} label={LABELS[s]} />}
              </li>
            );
          })}
        </ol>
        <p className="sr-only" role="status" aria-live="polite">
          {error ? 'Stopped with an error.' : `${LABELS[step]}${percent !== undefined ? `, ${Math.round(percent)} percent` : ''}`}
        </p>
        {prepared && (
          <p
            className="mt-4 text-sm text-muted"
            data-testid="decode-info"
            data-sample-rate={prepared.sampleRate}
            data-duration-sec={prepared.durationSec.toFixed(3)}
            data-channels={1}
            data-upload-kind={prepared.upload.kind}
          >
            Converted {formatDuration(prepared.durationSec)} of audio (
            {prepared.sourceChannels === 1 ? 'mono' : `${prepared.sourceChannels} channels`}) to {prepared.sampleRate / 1000} kHz
            mono, {formatBytes(prepared.wav.length)} as WAV.{' '}
            {clientOnly
              ? 'The audio stays on this device.'
              : prepared.upload.kind === 'original'
                ? `Uploading the original file (${formatBytes(prepared.upload.bytes)}) because it is smaller.`
                : `Uploading the WAV instead of the ${formatBytes(file.size)} original.`}
          </p>
        )}
        {clientOnly && step === 'model' && !error && (
          <p className="mt-2 text-xs text-muted">
            The first run downloads the Whisper model from huggingface.co and keeps it in this browser for next time.
          </p>
        )}
      </Card>
      {error !== undefined && (
        <ErrorPanel
          title={
            step === 'upload'
              ? 'The upload failed'
              : clientOnly && current >= 3
                ? 'Transcription failed'
                : 'This file could not be used'
          }
          error={error}
          onRetry={() => setAttempt((n) => n + 1)}
          showSettings={step === 'upload' || step === 'model' || step === 'transcribe'}
        />
      )}
    </div>
  );
}

export default UploadRun;
