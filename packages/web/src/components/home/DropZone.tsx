/** "or drop a video or audio file": drag and drop, or click to pick. */
import { Upload } from 'lucide-react';
import { type DragEvent, useId, useRef, useState } from 'react';

export function DropZone({ onFile, note }: { onFile: (file: File) => void; note?: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <div>
      <input
        ref={input}
        id={id}
        type="file"
        accept="audio/*,video/*,.mp3,.m4a,.wav,.ogg,.opus,.flac,.webm,.mp4,.mov,.mkv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
        data-testid="file-input"
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`flex w-full flex-col items-center justify-center gap-1.5 rounded-v2c-lg border border-dashed px-4 py-6 text-center transition ${
          over ? 'border-accent bg-surface-2' : 'border-border-strong hover:border-accent hover:bg-surface'
        }`}
        data-testid="drop-zone"
      >
        <Upload className="size-5 text-muted" aria-hidden />
        <span className="text-sm text-fg">or drop a video or audio file</span>
        <span className="text-xs text-muted">
          {note ?? 'mp3, m4a, wav, ogg, webm, mp4, mov and more. Click to choose a file.'}
        </span>
      </button>
    </div>
  );
}
