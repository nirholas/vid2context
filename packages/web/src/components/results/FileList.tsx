/** The bundle's files, each with its size. Selecting one shows it in the viewer. */
import { Braces, FileCode, FileText } from 'lucide-react';
import type { ViewFile } from '../../lib/bundle.ts';
import { formatBytes } from '../../lib/format.ts';

function iconFor(path: string) {
  if (path.endsWith('.json')) return Braces;
  if (/\.(srt|vtt|ass|ttml|sbv|lrc)$/.test(path)) return FileCode;
  return FileText;
}

export function FileList({
  files,
  selected,
  onSelect,
}: {
  files: ViewFile[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  return (
    <nav aria-label="Files">
      <ul className="space-y-1" data-testid="file-list">
        {files.map((f) => {
          const Icon = iconFor(f.path);
          const active = f.path === selected;
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => onSelect(f.path)}
                aria-current={active ? 'true' : undefined}
                title={f.description || undefined}
                className={`flex w-full items-center gap-2 rounded-v2c-sm px-2.5 py-2 text-left text-sm transition ${
                  active ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{f.path}</span>
                <span className="shrink-0 text-xs text-muted tabular-nums">{formatBytes(f.bytes.length)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
