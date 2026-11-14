/** Accessible tabs (WAI-ARIA tabs pattern): arrow keys, Home and End move between tabs. */
import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';

export interface TabDef {
  id: string;
  label: string;
  /** Shown after the label, such as a count. */
  badge?: string | number;
  render: () => ReactNode;
}

export function Tabs({ tabs, active, onChange, label }: { tabs: TabDef[]; active: string; onChange: (id: string) => void; label: string }) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    tabs.findIndex((t) => t.id === active),
  );
  const current = tabs[index];
  const move = (to: number) => {
    const n = (to + tabs.length) % tabs.length;
    const t = tabs[n];
    if (!t) return;
    onChange(t.id);
    refs.current[n]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight') move(index + 1);
    else if (e.key === 'ArrowLeft') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(tabs.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t, i) => {
          const selected = i === index;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              onKeyDown={onKeyDown}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition ${
                selected ? 'border-accent text-fg font-medium' : 'border-transparent text-muted hover:text-fg'
              }`}
            >
              {t.label}
              {t.badge !== undefined && <span className="ml-1.5 rounded-full bg-surface-3 px-1.5 text-xs text-muted">{t.badge}</span>}
            </button>
          );
        })}
      </div>
      {current && (
        <div role="tabpanel" id={`${base}-panel-${current.id}`} aria-labelledby={`${base}-tab-${current.id}`} className="pt-5">
          {current.render()}
        </div>
      )}
    </div>
  );
}
