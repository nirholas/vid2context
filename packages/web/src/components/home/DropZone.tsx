/**
 * "or drop a video or audio file": the strip under the composer. Click to
 * pick a file, or drop one on it (home also accepts a drop anywhere).
 */
import { Upload } from 'lucide-react';
import { type DragEvent, useState } from 'react';

/** File types the file picker offers. */
export const ACCEPT = 'audio/*,video/*,.mp3,.m4a,.wav,.ogg,.opus,.flac,.webm,.mp4,.mov,.mkv';

export function DropZone({ onFile, onPick, note }: { onFile: (file: File) => void; onPick: () => void; note?: string }) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <button
      type="button"
      onClick={onPick}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-b-[21px] px-5 py-3 text-left transition ${
        over ? 'bg-surface-3' : 'hover:bg-surface-2'
      }`}
      data-testid="drop-zone"
    >
      <Upload className="size-[18px] shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
      <span className="text-sm text-fg">or drop a video or audio file</span>
      <span className="text-xs text-muted sm:ml-auto">
        {note ?? 'mp3, m4a, wav, ogg, webm, mp4, mov and more. Click to choose a file.'}
      </span>
    </button>
  );
}
