/**
 * The result viewer: the files of a real bundle on the left, the selected
 * file on the right. Files are highlighted at build time and passed in as HTML.
 */
import { type KeyboardEvent, useId, useRef, useState } from 'react';

export interface ViewerFile {
  path: string;
  size: string;
  html: string;
}

interface Props {
  files: ViewerFile[];
  initial: string;
  zipName: string;
  zipSize: string;
}

export default function DemoViewer({ files, initial, zipName, zipSize }: Props) {
  const [active, setActive] = useState(Math.max(0, files.findIndex((f) => f.path === initial)));
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const base = useId();
  const file = files[active] ?? files[0];

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const keys: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    let next = active;
    if (e.key in keys) next = (active + (keys[e.key] ?? 0) + files.length) % files.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = files.length - 1;
    else return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  }

  return (
    <div className="viewer">
      <div className="viewer-files">
        <p className="viewer-zip">
          <span className="font-mono">{zipName}</span>
          <span>{zipSize}</span>
        </p>
        <div role="tablist" aria-label="Files in the bundle" aria-orientation="vertical" onKeyDown={onKey}>
          {files.map((f, n) => (
            <button
              key={f.path}
              ref={(el) => {
                tabs.current[n] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${n}`}
              aria-selected={n === active}
              aria-controls={`${base}-panel`}
              tabIndex={n === active ? 0 : -1}
              onClick={() => setActive(n)}
              className="viewer-tab"
            >
              <span className="font-mono">{f.path}</span>
              <span className="viewer-size">{f.size}</span>
            </button>
          ))}
        </div>
      </div>
      {file && (
        <div
          className="viewer-panel"
          role="tabpanel"
          id={`${base}-panel`}
          aria-labelledby={`${base}-tab-${active}`}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time shiki output of a repo fixture
          dangerouslySetInnerHTML={{ __html: file.html }}
        />
      )}
    </div>
  );
}
