/** The endpoint navigator: a filterable, grouped list on wide screens and a select on narrow ones. */
import { Search } from 'lucide-react';
import { useId, useMemo } from 'react';
import { type Endpoint, GROUPS } from '../../lib/api-catalog.ts';
import type { Outcome } from '../../lib/playground-send.ts';
import { Spinner } from '../ui.tsx';

export function MethodBadge({ method, className = '' }: { method: string; className?: string }) {
  const tone = method === 'GET' ? 'text-muted' : method === 'DELETE' ? 'text-danger' : 'text-fg';
  return (
    <span className={`inline-block w-[3.25rem] shrink-0 font-mono text-[11px] font-semibold tracking-wide ${tone} ${className}`}>
      {method}
    </span>
  );
}

function OutcomeMark({ outcome }: { outcome?: Outcome }) {
  if (!outcome) return null;
  if (outcome.state === 'sending') return <Spinner className="size-3.5 text-muted" />;
  if (outcome.state === 'done') {
    const ok = outcome.answer.ok;
    return (
      <span
        className={`size-2 shrink-0 rounded-full ${ok ? 'bg-success' : 'bg-danger'}`}
        title={`${outcome.answer.status}`}
        aria-label={`Last answer ${outcome.answer.status}`}
        role="img"
      />
    );
  }
  if (outcome.state === 'failed')
    return <span className="size-2 shrink-0 rounded-full bg-danger" role="img" aria-label="No response" />;
  return null;
}

function matches(ep: Endpoint, q: string): boolean {
  if (!q) return true;
  const hay = `${ep.method} ${ep.path} ${ep.summary} ${ep.group}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

export function groupEndpoints(list: Endpoint[]): [string, Endpoint[]][] {
  const order = new Map<string, number>(GROUPS.map((g, i) => [g, i]));
  const by = new Map<string, Endpoint[]>();
  for (const ep of list) by.set(ep.group, [...(by.get(ep.group) ?? []), ep]);
  return [...by.entries()].sort(([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

export function EndpointList({
  endpoints,
  selected,
  onSelect,
  filter,
  onFilter,
  outcomes,
  missing,
}: {
  endpoints: Endpoint[];
  selected: string;
  onSelect: (id: string) => void;
  filter: string;
  onFilter: (q: string) => void;
  outcomes: Record<string, Outcome>;
  missing: (ep: Endpoint) => boolean;
}) {
  const filterId = useId();
  const selectId = useId();
  const groups = useMemo(() => groupEndpoints(endpoints.filter((e) => matches(e, filter.trim()))), [endpoints, filter]);
  const allGroups = useMemo(() => groupEndpoints(endpoints), [endpoints]);

  return (
    <>
      {/* Narrow screens: one select with every endpoint. */}
      <div className="lg:hidden">
        <label htmlFor={selectId} className="mb-1 block text-sm font-medium text-fg">
          Endpoint
        </label>
        <select
          id={selectId}
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          className="w-full rounded-v2c-sm border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-fg"
        >
          {allGroups.map(([group, eps]) => (
            <optgroup key={group} label={group}>
              {eps.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.method} {ep.path}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Wide screens: a filterable list. */}
      <nav aria-label="Endpoints" className="max-lg:hidden">
        <div className="relative mb-3">
          <label htmlFor={filterId} className="sr-only">
            Filter endpoints
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <input
            id={filterId}
            type="search"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            placeholder={`Filter ${endpoints.length} endpoints`}
            className="w-full rounded-v2c-sm border border-border bg-surface-2 py-2 pl-9 pr-3 text-sm text-fg placeholder:text-muted"
          />
        </div>
        {groups.length === 0 && <p className="px-2 text-sm text-subtle">No endpoint matches.</p>}
        <div className="space-y-4" data-testid="api-endpoint-list">
          {groups.map(([group, eps]) => (
            <section key={group} aria-label={group}>
              <h3 className="px-2 pb-1 text-xs font-medium text-subtle">{group}</h3>
              <ul className="space-y-0.5">
                {eps.map((ep) => {
                  const active = ep.id === selected;
                  const absent = missing(ep);
                  return (
                    <li key={ep.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(ep.id)}
                        aria-current={active ? 'true' : undefined}
                        title={absent ? `${ep.path}: not served by this server` : ep.path}
                        className={`flex w-full items-center gap-2 rounded-v2c-sm px-2 py-1.5 text-left text-sm transition ${
                          active
                            ? 'bg-surface-2 text-fg shadow-[inset_2px_0_0_var(--v2c-accent)]'
                            : 'text-muted hover:bg-surface-2 hover:text-fg'
                        } ${absent ? 'opacity-50' : ''}`}
                      >
                        <MethodBadge method={ep.method} />
                        <span className="min-w-0 flex-1 truncate">{ep.summary}</span>
                        <OutcomeMark outcome={outcomes[ep.id]} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </nav>
    </>
  );
}
