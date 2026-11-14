/**
 * The model picker: a round button in the composer toolbar that opens a popover (above it) with
 * a search box (an ARIA combobox) over a listbox of models. "Auto" comes
 * first, then favorites, then tiers in free-first order (Local, Free,
 * Keyless, Paid) with models grouped by service. Each row shows the label,
 * the service, capability icons and a context-size badge; disabled rows say
 * what is missing and, when activated, open settings or the provider docs.
 *
 * Keyboard: arrows, Home and End move; Enter picks; Escape closes; Alt+S
 * stars the highlighted model. Focus stays in the search box throughout.
 */
import { ArrowRight, Box, Braces, Brain, Check, Eye, FileJson, Film, Search, Settings, Sparkles, Star, Wrench, Zap } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CAPABILITY_LABEL, filterModels, formatContextTokens, groupModels, serviceLabel, TIER_LABEL } from '../lib/models.ts';
import type { ChatErrorData, ModelChoice, ModelRow } from '../lib/types.ts';
import { cx, Spinner, Tip } from './ui.tsx';

export const AUTO_DESCRIPTION = 'Free-first: local, then free tiers, then keyless';

const TIER_DOT: Record<ModelRow['tier'], string> = {
  local: 'bg-tier-local',
  free: 'bg-tier-free',
  keyless: 'bg-tier-keyless',
  paid: 'bg-tier-paid',
};

const CAP_ICON: Record<string, ReactNode> = {
  vision: <Eye size={13} aria-hidden />,
  video: <Film size={13} aria-hidden />,
  tools: <Wrench size={13} aria-hidden />,
  json: <Braces size={13} aria-hidden />,
  'json-schema': <FileJson size={13} aria-hidden />,
  reasoning: <Brain size={13} aria-hidden />,
  stream: <Zap size={13} aria-hidden />,
};

export interface ModelPickerProps {
  /** null while loading. */
  rows: ModelRow[] | null;
  error?: ChatErrorData;
  choice: ModelChoice;
  strict: boolean;
  favorites: string[];
  mode: 'server' | 'client';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: ModelChoice) => void;
  onToggleFavorite: (rungId: string) => void;
  onStrictChange: (strict: boolean) => void;
  /** A disabled row was activated: open settings (client-only) or the provider docs (server). */
  onUnavailable: (row: ModelRow) => void;
  /** Shows a "Manage providers" row in the footer that opens the settings. */
  onManageProviders?: () => void;
}

type Item = { key: string; kind: 'auto' } | { key: string; kind: 'model'; row: ModelRow };

interface Section {
  id: string;
  label: string;
  tier?: ModelRow['tier'];
  services: { label?: string; items: Item[] }[];
}

const CHIP =
  'inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface-3 text-muted group-data-[active=true]:bg-border-strong/60';

const AUTO_TERMS = 'auto recommended free-first free first local keyless default';

export function ModelPicker(props: ModelPickerProps) {
  const { rows, open, onOpenChange } = props;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const baseId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { sections, items } = useMemo(() => {
    const filtered = filterModels(rows ?? [], query);
    const q = query.trim().toLowerCase();
    const showAuto = !q || q.split(/\s+/).every((t) => AUTO_TERMS.includes(t));
    const out: Section[] = [];
    const flat: Item[] = [];
    if (showAuto) {
      const auto: Item = { key: 'auto', kind: 'auto' };
      out.push({ id: 'auto', label: '', services: [{ items: [auto] }] });
      flat.push(auto);
    }
    const favs = filtered.filter((r) => props.favorites.includes(r.id));
    if (favs.length > 0) {
      const favItems: Item[] = favs.map((row) => ({ key: `fav:${row.id}`, kind: 'model', row }));
      out.push({ id: 'favorites', label: 'Favorites', services: [{ items: favItems }] });
      flat.push(...favItems);
    }
    for (const tier of groupModels(filtered)) {
      const services = tier.services.map((s) => ({
        label: s.label,
        items: s.models.map((row): Item => ({ key: `m:${row.id}`, kind: 'model', row })),
      }));
      out.push({ id: tier.tier, label: tier.label, tier: tier.tier, services });
      for (const s of services) flat.push(...s.items);
    }
    return { sections: out, items: flat };
  }, [rows, query, props.favorites]);

  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const listId = `${baseId}-list`;

  // Reset on open: clear the search and highlight the current choice.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    inputRef.current?.focus();
  }, [open]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const choiceRef = useRef(props.choice);
  choiceRef.current = props.choice;

  // On open, highlight the current choice; on every new search, the first match.
  useEffect(() => {
    if (!open) return;
    if (query) {
      setActive(0);
      return;
    }
    const choice = choiceRef.current;
    const current = itemsRef.current.findIndex((it) =>
      choice.kind === 'auto' ? it.kind === 'auto' : it.kind === 'model' && it.row.id === choice.rung,
    );
    setActive(Math.max(current, 0));
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(optionId(active));
    el?.scrollIntoView?.({ block: 'nearest' });
  });

  // Close on outside pointer down.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, onOpenChange]);

  const close = (restoreFocus = true) => {
    onOpenChange(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  const activate = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'auto') {
      props.onChoose({ kind: 'auto' });
      close();
      return;
    }
    if (!item.row.enabled) {
      props.onUnavailable(item.row);
      close(false);
      return;
    }
    props.onChoose({ kind: 'rung', rung: item.row.id, label: item.row.label });
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = items.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (n ? (a + 1) % n : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (n ? (a - 1 + n) % n : 0));
    } else if (e.key === 'Home' && (e.ctrlKey || !query)) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && (e.ctrlKey || !query)) {
      e.preventDefault();
      setActive(Math.max(0, n - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      const it = items[active];
      if (it?.kind === 'model') props.onToggleFavorite(it.row.id);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const chosenRow =
    props.choice.kind === 'rung' ? rows?.find((r) => r.id === (props.choice as { rung: string }).rung) : undefined;
  const buttonLabel = props.choice.kind === 'auto' ? 'Auto' : props.choice.label;

  let index = -1;
  const renderItem = (item: Item) => {
    index++;
    const i = index;
    const isActive = i === active;
    if (item.kind === 'auto') {
      const selected = props.choice.kind === 'auto';
      return (
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input, which keeps focus (aria-activedescendant).
        <div
          key={item.key}
          id={optionId(i)}
          role="option"
          aria-selected={selected}
          tabIndex={-1}
          className={cx('flex cursor-pointer items-start gap-3 rounded-v2c-sm px-3 py-2.5', isActive && 'bg-surface-3')}
          onMouseDown={(e) => e.preventDefault()}
          onMouseMove={() => setActive(i)}
          onClick={() => activate(item)}
        >
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-v2c-sm bg-accent text-accent-fg">
            <Sparkles size={15} aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="font-medium">Auto</span>
              <span className="rounded-md bg-surface-3 px-1.5 py-px text-[11px] font-medium text-fg">
                Recommended
              </span>
            </span>
            <span className="block text-xs text-muted">{AUTO_DESCRIPTION}</span>
          </span>
          {selected ? <Check size={16} className="mt-1 shrink-0 text-accent" aria-hidden /> : null}
        </div>
      );
    }
    const row = item.row;
    const selected = props.choice.kind === 'rung' && props.choice.rung === row.id && !item.key.startsWith('fav:');
    const fav = props.favorites.includes(row.id);
    const ctx = formatContextTokens(row.contextTokens);
    const caps = row.capabilities.filter((c) => CAP_ICON[c]);
    const capNames = caps.map((c) => (CAPABILITY_LABEL[c] ?? c).split(':')[0]).join(', ');
    const name = `${row.label}, ${serviceLabel(row.service)}${ctx ? `, ${ctx} context` : ''}${capNames ? `, ${capNames}` : ''}${fav ? ', starred' : ''}${
      row.disabledReason ? `, unavailable: ${row.disabledReason}` : ''
    }`;
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input, which keeps focus (aria-activedescendant).
      <div
        key={item.key}
        id={optionId(i)}
        role="option"
        aria-selected={selected}
        aria-disabled={!row.enabled || undefined}
        aria-label={name}
        tabIndex={-1}
        data-active={isActive}
        className={cx('group flex cursor-pointer items-start gap-3 rounded-v2c-sm px-3 py-2', isActive && 'bg-surface-3')}
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={() => setActive(i)}
        onClick={() => activate(item)}
        data-rung={row.id}
      >
        <span
          className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', TIER_DOT[row.tier], !row.enabled && 'opacity-40')}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cx('truncate font-medium', !row.enabled && 'text-muted')}>{row.label}</span>
            <span className="text-xs text-muted">{serviceLabel(row.service)}</span>
          </span>
          {row.disabledReason ? (
            <span className="mt-0.5 block text-xs text-muted">
              {row.disabledReason}
              <span className="ml-1.5 text-accent underline underline-offset-2">
                {props.mode === 'client' && /^Needs /.test(row.disabledReason) ? 'Open settings' : 'See providers'}
              </span>
            </span>
          ) : row.note ? (
            <span className="mt-0.5 block text-xs text-muted">{row.note}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-muted">
          {caps.map((c) => (
            <Tip key={c} text={CAPABILITY_LABEL[c] ?? c}>
              <span className={CHIP}>{CAP_ICON[c]}</span>
            </Tip>
          ))}
          {ctx ? <span className={cx(CHIP, 'w-auto px-1.5 font-mono text-[11px]')}>{ctx}</span> : null}
          <span
            aria-hidden
            title={fav ? 'Unstar' : 'Star'}
            className={cx(
              'inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-surface-2',
              fav ? 'text-fg' : 'text-subtle opacity-0 group-hover:opacity-100',
              isActive && 'opacity-100',
            )}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleFavorite(row.id);
            }}
          >
            <Star size={14} fill={fav ? 'currentColor' : 'none'} />
          </span>
          {selected ? <Check size={16} className="text-accent" aria-hidden /> : null}
        </span>
      </div>
    );
  };

  return (
    <div className="relative">
      <span className="group/tip relative inline-flex">
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Model: ${buttonLabel}${props.strict ? ', strict' : ''}. Change model`}
          aria-keyshortcuts="Alt+M"
          className={cx(
            'relative inline-flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-3 hover:text-fg',
            open && 'bg-surface-3 text-fg',
          )}
          onClick={() => onOpenChange(!open)}
        >
          {props.choice.kind === 'auto' ? (
            <Sparkles size={18} strokeWidth={1.75} aria-hidden />
          ) : (
            <Box size={18} strokeWidth={1.75} aria-hidden />
          )}
          {chosenRow ? (
            <span
              className={cx('absolute right-1.5 bottom-1.5 h-2 w-2 rounded-full ring-2 ring-surface', TIER_DOT[chosenRow.tier])}
              aria-hidden
            />
          ) : null}
        </button>
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-sm border border-border bg-surface-3 px-2 py-1 text-xs text-fg opacity-0 shadow-pop transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
        >
          {buttonLabel}
          {props.strict && props.choice.kind === 'rung' ? ' (strict)' : ''}
        </span>
      </span>

      {open ? (
        <div
          ref={popRef}
          role="dialog"
          aria-label="Choose a model"
          className="fixed inset-x-2 bottom-28 z-40 flex max-h-[min(62vh,540px)] flex-col overflow-hidden rounded-v2c-lg border border-border bg-surface-2 shadow-v2c sm:absolute sm:inset-x-auto sm:bottom-full sm:-left-1 sm:mb-3 sm:w-[min(34rem,calc(100vw-2rem))]"
        >
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
            <Search size={16} className="shrink-0 text-muted" aria-hidden />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={items.length ? optionId(active) : undefined}
              aria-label="Search models by name, service or capability"
              placeholder="Search models..."
              className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-subtle"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Models"
            className="v2c-scroll min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {sections.map((section) =>
              section.label ? (
                // biome-ignore lint/a11y/useSemanticElements: the ARIA listbox pattern groups options with role="group"; a fieldset is not allowed inside a listbox.
                <div key={section.id} role="group" aria-labelledby={`${baseId}-${section.id}`} className="mt-1.5">
                  <div
                    id={`${baseId}-${section.id}`}
                    className="flex items-center gap-2 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle"
                  >
                    {section.tier ? (
                      <span className={cx('h-1.5 w-1.5 rounded-full', TIER_DOT[section.tier])} aria-hidden />
                    ) : null}
                    {section.id === 'favorites' ? <Star size={12} aria-hidden /> : null}
                    {section.label}
                  </div>
                  {section.services.map((s) => (
                    <div key={s.label ?? 'all'} role="presentation">
                      {s.label && section.tier ? (
                        <div role="presentation" className="px-3 pb-1 pt-2 text-sm text-subtle">
                          {s.label}
                        </div>
                      ) : null}
                      {s.items.map(renderItem)}
                    </div>
                  ))}
                </div>
              ) : (
                <div key={section.id} role="presentation">
                  {section.services.flatMap((s) => s.items.map(renderItem))}
                </div>
              ),
            )}
            {rows === null && !props.error ? (
              <div className="px-3 py-3">
                <Spinner label="Loading models" />
              </div>
            ) : null}
            {props.error ? (
              <div className="px-3 py-3 text-sm" role="alert">
                <p className="text-fg">The model list is not available: {props.error.message}</p>
                {props.error.hint ? <p className="mt-1 text-muted">{props.error.hint}</p> : null}
                <p className="mt-1 text-muted">Auto still works: the server picks a model free-first.</p>
              </div>
            ) : null}
            {rows !== null && items.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted">No model matches "{query}".</p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-3.5 py-2 text-xs text-muted">
            <div className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                role="switch"
                checked={props.strict}
                aria-checked={props.strict}
                aria-label="Strict: only the chosen model answers, no fallback"
                onChange={(e) => props.onStrictChange(e.target.checked)}
                className="relative h-4 w-7 cursor-pointer appearance-none rounded-pill bg-surface-3 ring-1 ring-border-strong transition-colors before:absolute before:left-0.5 before:top-0.5 before:h-3 before:w-3 before:rounded-full before:bg-muted before:transition-transform before:content-[''] checked:bg-accent checked:ring-accent checked:before:translate-x-3 checked:before:bg-accent-fg"
              />
              <span>
                Strict <span className="text-subtle">(no fallback)</span>
              </span>
            </div>
            {props.onManageProviders ? (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-v2c-sm px-2 py-1 text-sm text-fg hover:bg-surface-3"
                onClick={() => {
                  close(false);
                  props.onManageProviders?.();
                }}
              >
                <Settings size={14} aria-hidden /> Manage providers <ArrowRight size={14} className="text-muted" aria-hidden />
              </button>
            ) : (
              <span className="hidden sm:inline">Alt+S stars the highlighted model</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { TIER_LABEL };
