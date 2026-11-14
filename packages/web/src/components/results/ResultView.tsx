/**
 * The result page, modeled on llm.energy: every generated file on the left
 * with Copy and Download, the selected file in a viewer, a .zip of all of
 * them, "Copy for agents", and tabs for the transcript and everything else.
 * Loaded on demand, so the formatters and zip code stay out of the initial JS.
 */
import { agentPrompt, type Bundle, estimateTokens, type VideoContext } from '@vid2context/core';
import { Bot, Clock, FileArchive, MessageSquare, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { resultBundle, type ViewFile, viewFiles } from '../../lib/bundle.ts';
import { saveBlob, streamToBlob } from '../../lib/download.ts';
import { timeAgo } from '../../lib/format.ts';
import { chatHref } from '../../lib/links.ts';
import type { RunParams } from '../../lib/route.ts';
import { AttemptsTimeline } from '../AttemptsTimeline.tsx';
import { Tabs } from '../Tabs.tsx';
import { Button, buttonClass, CopyButton, Spinner } from '../ui.tsx';
import { ChaptersTab, CommentsTab, MetadataTab, VisualTab } from './DetailTabs.tsx';
import { FileList } from './FileList.tsx';
import { FileViewer } from './FileViewer.tsx';
import { ResultHeader } from './ResultHeader.tsx';
import { TranscriptTab } from './TranscriptTab.tsx';

/** The input the chat page and the server can resolve again, or undefined for results that exist only in this browser. */
export function shareableInput(context: VideoContext, params?: RunParams): string | undefined {
  const requested = params?.url ?? context.metadata.ref.input;
  // file:<sha256> results were transcribed in this browser; no server can resolve them.
  if (requested.startsWith('file:')) return undefined;
  return context.metadata.ref.url ?? requested;
}

export interface ResultViewProps {
  context: VideoContext;
  params?: RunParams;
  /** Set when the result came from this browser's history. */
  cachedAt?: number;
  onRefresh?: () => void;
  /** Called once the bundle is built (the run view saves the result to history then). */
  onBundle?: (bundle: Bundle) => void;
  notices?: ReactNode;
  /** Fixed bundle time, for reproducible output in tests. */
  createdAt?: Date;
}

export function ResultView({ context, params, cachedAt, onRefresh, onBundle, notices, createdAt }: ResultViewProps) {
  const [bundle, setBundle] = useState<Bundle>();
  const [bundleError, setBundleError] = useState<unknown>();
  const [selected, setSelected] = useState('context.md');
  const [tab, setTab] = useState('transcript');
  const [zipping, setZipping] = useState(false);
  const timestamps = params?.timestamps ?? false;
  // The latest callback, without rebuilding the bundle when its identity changes.
  const onBundleRef = useRef(onBundle);
  onBundleRef.current = onBundle;

  useEffect(() => {
    let live = true;
    setBundle(undefined);
    resultBundle([context], { timestamps, createdAt }).then(
      (b) => {
        if (!live) return;
        setBundle(b);
        onBundleRef.current?.(b);
      },
      (err) => live && setBundleError(err),
    );
    return () => {
      live = false;
    };
  }, [context, timestamps, createdAt]);

  const files: ViewFile[] = useMemo(() => (bundle ? viewFiles(bundle) : []), [bundle]);
  const file = files.find((f) => f.path === selected) ?? files[0];
  const agentText = useMemo(() => agentPrompt([context]), [context]);
  const agentTokens = useMemo(() => estimateTokens(agentText), [agentText]);
  const shareable = shareableInput(context, params);

  const downloadZip = async () => {
    if (!bundle) return;
    setZipping(true);
    try {
      saveBlob(await streamToBlob(bundle.zip(), 'application/zip'), bundle.filename);
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="space-y-6">
      <ResultHeader context={context} />

      <div className="flex flex-wrap items-center gap-2">
        <CopyButton
          variant="accent"
          getText={() => agentText}
          label="Copy for agents"
          copiedLabel="Copied for agents"
          icon={<Bot className="size-4" aria-hidden />}
          describedBy="agent-copy-note"
        />
        <span id="agent-copy-note" className="text-xs text-muted">
          About {agentTokens.toLocaleString('en-US')} tokens, with citation instructions
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {shareable && (
            <a href={chatHref(shareable)} className={buttonClass('secondary')}>
              <MessageSquare className="size-4" aria-hidden /> Open in chat
            </a>
          )}
          <Button variant="secondary" onClick={downloadZip} disabled={!bundle || zipping} data-testid="download-zip">
            {zipping ? <Spinner /> : <FileArchive className="size-4" aria-hidden />}
            {bundle ? `Download .zip (${bundle.files.length} files)` : 'Preparing files'}
          </Button>
        </div>
      </div>

      {cachedAt !== undefined && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <Clock className="size-4" aria-hidden /> Saved in this browser {timeAgo(cachedAt)}.
          {onRefresh && (
            <Button variant="ghost" className="px-2 py-1" onClick={onRefresh}>
              <RefreshCw className="size-3.5" aria-hidden /> Fetch again
            </Button>
          )}
        </p>
      )}
      {notices}

      <section aria-labelledby="files-title" className="space-y-3">
        <h2 id="files-title" className="text-sm font-semibold uppercase tracking-wide text-muted">
          Files
        </h2>
        {bundleError ? (
          <p className="text-sm text-fg" role="alert">
            The files could not be generated: {bundleError instanceof Error ? bundleError.message : String(bundleError)}
          </p>
        ) : !bundle || !file ? (
          <p className="flex items-center gap-2 text-sm text-muted" role="status">
            <Spinner /> Generating files
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <div className="lg:max-h-[38rem] lg:overflow-y-auto">
              <FileList files={files} selected={file.path} onSelect={setSelected} />
            </div>
            <FileViewer file={file} />
          </div>
        )}
      </section>

      <section aria-label="Details">
        <Tabs
          label="Result details"
          active={tab}
          onChange={setTab}
          tabs={[
            {
              id: 'transcript',
              label: 'Transcript',
              badge: context.transcript.segments.length,
              render: () => <TranscriptTab context={context} />,
            },
            {
              id: 'chapters',
              label: 'Chapters',
              badge: context.metadata.chapters.length || undefined,
              render: () => <ChaptersTab context={context} />,
            },
            { id: 'metadata', label: 'Metadata', render: () => <MetadataTab context={context} /> },
            {
              id: 'comments',
              label: 'Comments',
              badge: context.comments?.length || undefined,
              render: () => <CommentsTab context={context} params={params} />,
            },
            {
              id: 'visual',
              label: 'On screen',
              badge: context.visual?.length || undefined,
              render: () => <VisualTab context={context} params={params} />,
            },
            {
              id: 'attempts',
              label: 'How we got this',
              render: () => (
                <div className="space-y-3">
                  <p className="text-sm text-muted">
                    Every provider and model that ran for this result, in order. Free and local options are tried first.
                  </p>
                  <AttemptsTimeline attempts={context.attempts} />
                </div>
              ),
            },
          ]}
        />
      </section>
    </div>
  );
}

export default ResultView;
