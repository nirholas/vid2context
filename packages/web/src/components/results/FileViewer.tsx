/** The selected file in a monospace viewer, with Copy and Download. */
import { Download } from 'lucide-react';
import { useMemo } from 'react';
import { fileText, type ViewFile } from '../../lib/bundle.ts';
import { saveBlob, toBlob } from '../../lib/download.ts';
import { formatBytes } from '../../lib/format.ts';
import { Button, CopyButton } from '../ui.tsx';

/** Very large files are shown in part; Copy and Download always use the whole file. */
export const VIEW_LIMIT = 400_000;

export function FileViewer({ file }: { file: ViewFile }) {
  const text = useMemo(() => fileText(file), [file]);
  const shown = text.length > VIEW_LIMIT ? text.slice(0, VIEW_LIMIT) : text;
  const name = file.path.split('/').at(-1) ?? file.path;
  return (
    <section
      aria-labelledby="viewer-title"
      className="flex min-w-0 flex-col overflow-hidden rounded-v2c border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 id="viewer-title" className="truncate font-mono text-sm text-fg">
            {file.path}
          </h3>
          <p className="truncate text-xs text-muted">
            {formatBytes(file.bytes.length)}
            {file.description ? ` · ${file.description}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton getText={() => text} label="Copy" copiedLabel={`Copied ${name}`} />
          <Button onClick={() => saveBlob(toBlob(file.bytes, file.mimeType), name)} aria-label={`Download ${name}`}>
            <Download className="size-4" aria-hidden /> Download
          </Button>
        </div>
      </div>
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
        tabIndex={0}
        aria-label={`Contents of ${file.path}`}
        className="max-h-[34rem] min-h-64 overflow-auto"
      >
        <pre
          className="whitespace-pre-wrap break-words p-4 font-mono text-[0.8125rem] leading-relaxed text-fg"
          data-testid="file-content"
        >
          {shown}
        </pre>
      </section>
      {shown.length < text.length && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted">
          Showing the first {VIEW_LIMIT.toLocaleString('en-US')} of {text.length.toLocaleString('en-US')} characters. Copy and
          Download use the whole file.
        </p>
      )}
    </section>
  );
}
