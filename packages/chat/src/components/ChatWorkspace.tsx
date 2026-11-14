/**
 * The chat workspace: sidebar, thread header (model picker, token meter,
 * export, settings), thread, composer, and the source panel. It owns the
 * conversation state, streams answers from the backend (server or
 * client-only), persists everything through the ChatStore, and handles the
 * keyboard shortcuts and the ?input= / ?collection= hand-off.
 */
import type { VideoContext, VideoSummary } from '@vid2context/core';
import { Download, Menu, PanelLeftClose, PanelLeftOpen, Paperclip, Settings, Sparkles, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toErrorData } from '../lib/api.ts';
import { type Backend, requestContext } from '../lib/backend.ts';
import { conversationToMarkdown, exportFileName, NEW_CHAT_TITLE, newId, preview, titleFrom } from '../lib/conversations.ts';
import { browserCorsFor } from '../lib/cors.ts';
import { readMeter } from '../lib/meter.ts';
import { autoPick, serviceLabel } from '../lib/models.ts';
import { applyTheme, getTheme, type Theme } from '../lib/settings.ts';
import { type ChatStore, DEFAULT_PREFS, type Prefs } from '../lib/store.ts';
import type { AttachedContext, ChatApiRequest, ChatSource, Conversation, MessageRecord, ModelChoice, ModelRow } from '../lib/types.ts';
import { AttachDialog } from './AttachDialog.tsx';
import { Composer } from './Composer.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { type KeyField, SettingsDialog } from './SettingsDialog.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Thread } from './Thread.tsx';
import { TokenMeter } from './TokenMeter.tsx';
import { Button, cx, IconButton, Spinner } from './ui.tsx';

const SourcePanel = lazy(() => import('./SourcePanel.tsx'));

export const PROVIDERS_DOC_URL = 'https://github.com/nirholas/vid2context/blob/main/docs/providers.md';

export interface ChatWorkspaceProps {
  backend: Backend;
  store: ChatStore;
  apiBase: string;
  /** Hand-off from the web app: open a new chat with this input or collection attached. */
  initialInput?: string;
  initialCollection?: string;
  onReconnect: (apiBase: string, serverApiKey: string) => Promise<void>;
  onKeysSaved: (keys: Record<string, string>) => Promise<void>;
}

function blankConversation(prefs: Prefs): Conversation {
  const now = Date.now();
  return { id: newId(), title: NEW_CHAT_TITLE, createdAt: now, updatedAt: now, pinned: false, model: prefs.lastModel, strict: prefs.lastStrict, contexts: [] };
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const { backend, store } = props;
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [current, setCurrent] = useState<Conversation>(() => blankConversation(DEFAULT_PREFS));
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [rowsError, setRowsError] = useState<ReturnType<typeof toErrorData> | undefined>();
  const [draft, setDraft] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [panel, setPanel] = useState<{ source: ChatSource; sources: ChatSource[] } | null>(null);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [loaded, setLoaded] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const streamRef = useRef<AbortController | null>(null);

  // ---------------------------------------------------------------- loading

  useEffect(() => {
    let live = true;
    Promise.all([store.getPrefs(), store.listConversations()]).then(([p, list]) => {
      if (!live) return;
      setPrefs(p);
      setConversations(list);
      setCurrent((c) => (c.title === NEW_CHAT_TITLE && c.contexts.length === 0 ? { ...c, model: p.lastModel, strict: p.lastStrict } : c));
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [store]);

  useEffect(() => {
    let live = true;
    setRows(null);
    setRowsError(undefined);
    backend
      .listModels()
      .then((r) => live && setRows(r))
      .catch((err) => {
        if (!live) return;
        setRowsError(toErrorData(err));
        setRows([]);
      });
    return () => {
      live = false;
    };
  }, [backend]);

  // ---------------------------------------------------------------- persistence helpers

  const isSaved = useCallback((id: string) => conversations.some((c) => c.id === id), [conversations]);

  const saveConversation = useCallback(
    async (c: Conversation) => {
      if (currentRef.current.id === c.id) {
        currentRef.current = c;
        setCurrent(c);
      }
      setConversations((list) => {
        const rest = list.filter((x) => x.id !== c.id);
        return [c, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
      });
      await store.putConversation(c);
    },
    [store],
  );

  const updatePrefs = useCallback(
    (patch: Partial<Prefs>) => {
      const next = { ...prefsRef.current, ...patch };
      prefsRef.current = next;
      setPrefs(next);
      store.putPrefs(next).catch(() => {});
    },
    [store],
  );

  /** Update the current conversation; persist it only once it has content. */
  const patchCurrent = useCallback(
    async (patch: Partial<Conversation>, persist?: boolean) => {
      const c = { ...currentRef.current, ...patch };
      const saved = conversations.some((x) => x.id === c.id);
      if (saved || persist) await saveConversation(c);
      else {
        currentRef.current = c;
        setCurrent(c);
      }
      return c;
    },
    [conversations, saveConversation],
  );

  // ---------------------------------------------------------------- conversations

  const newChat = useCallback(() => {
    const cur = currentRef.current;
    setPanel(null);
    setDrawerOpen(false);
    setDraft('');
    if (messagesRef.current.length === 0 && cur.contexts.length === 0 && !isSaved(cur.id)) {
      const c = { ...cur, model: prefsRef.current.lastModel, strict: prefsRef.current.lastStrict };
      currentRef.current = c;
      setCurrent(c);
    } else {
      const c = blankConversation(prefsRef.current);
      currentRef.current = c;
      setCurrent(c);
      setMessages([]);
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [isSaved]);

  const selectConversation = useCallback(
    async (id: string) => {
      const c = conversations.find((x) => x.id === id);
      if (!c) return;
      setPanel(null);
      setDrawerOpen(false);
      currentRef.current = c;
      setCurrent(c);
      setMessages(await store.listMessages(id));
    },
    [conversations, store],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await store.deleteConversation(id);
      setConversations((list) => list.filter((c) => c.id !== id));
      if (currentRef.current.id === id) {
        const c = blankConversation(prefsRef.current);
        currentRef.current = c;
        setCurrent(c);
        setMessages([]);
        setPanel(null);
      }
    },
    [store],
  );

  // ---------------------------------------------------------------- answering

  const runAnswer = useCallback(
    async (conv: Conversation, history: MessageRecord[]) => {
      const controller = new AbortController();
      streamRef.current = controller;
      let cur: MessageRecord = {
        id: newId(),
        conversationId: conv.id,
        role: 'assistant',
        content: '',
        createdAt: Date.now() + 1,
        status: 'streaming',
        requested: conv.model,
      };
      setStreamingId(cur.id);
      setMessages((ms) => [...ms, cur]);
      store.putMessage(cur).catch(() => {});
      const push = (patch: Partial<MessageRecord>) => {
        cur = { ...cur, ...patch };
        const snapshot = cur;
        setMessages((ms) => ms.map((m) => (m.id === snapshot.id ? snapshot : m)));
      };

      const ctx = requestContext(conv.contexts);
      const req: ChatApiRequest = {
        messages: history
          .filter((m) => m.role === 'user' || ((m.status === 'done' || m.status === 'stopped') && m.content))
          .map((m) => ({ role: m.role, content: m.content })),
        ...(conv.model.kind === 'rung' ? { model: { rung: conv.model.rung, ...(conv.strict ? { strict: true } : {}) } } : {}),
        ...(ctx ? { context: ctx } : {}),
      };

      try {
        for await (const ev of backend.chat(req, conv, controller.signal)) {
          if (ev.type === 'meta') {
            push({
              rung: ev.rung,
              model: ev.model,
              sources: ev.sources,
              ...(ev.promptTokens !== undefined ? { promptTokens: ev.promptTokens } : {}),
              ...(ev.restart ? { content: '', reasoning: undefined } : {}),
            });
            store.putMessage(cur).catch(() => {});
          } else if (ev.type === 'reasoning') {
            push({ reasoning: (cur.reasoning ?? '') + ev.text });
          } else if (ev.type === 'delta') {
            push({ content: cur.content + ev.text });
          } else if (ev.type === 'done') {
            push({
              content: ev.text || cur.content,
              rung: ev.rung,
              model: ev.model,
              citations: ev.citations,
              attempts: ev.attempts,
              ...(ev.usage ? { usage: ev.usage } : {}),
              ...(ev.unverified?.length ? { unverified: ev.unverified } : {}),
              status: 'done',
            });
          } else if (ev.type === 'error') {
            const { type: _t, ...error } = ev;
            push({ status: 'error', error });
          }
        }
        if (cur.status === 'streaming') {
          push(
            controller.signal.aborted
              ? { status: 'stopped' }
              : { status: 'error', error: { code: 'upstream', message: 'The answer ended without a result.', hint: 'Retry, or pick another model.' } },
          );
        }
      } catch (err) {
        push(controller.signal.aborted ? { status: 'stopped' } : { status: 'error', error: toErrorData(err) });
      } finally {
        if (streamRef.current === controller) streamRef.current = null;
        setStreamingId(null);
        await store.putMessage(cur).catch(() => {});
      }
    },
    [backend, store],
  );

  const stop = useCallback(() => streamRef.current?.abort(), []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || streamRef.current) return;
    const history = messagesRef.current;
    const first = !history.some((m) => m.role === 'user');
    const conv = await patchCurrent(
      {
        title: first && currentRef.current.title === NEW_CHAT_TITLE ? titleFrom(text) : currentRef.current.title,
        updatedAt: Date.now(),
        preview: preview(text),
      },
      true,
    );
    const user: MessageRecord = { id: newId(), conversationId: conv.id, role: 'user', content: text, createdAt: Date.now(), status: 'done' };
    setMessages((ms) => [...ms, user]);
    setDraft('');
    await store.putMessage(user);
    await runAnswer(conv, [...history, user]);
  }, [draft, patchCurrent, runAnswer, store]);

  const regenerate = useCallback(
    async (assistantId: string) => {
      if (streamRef.current) return;
      const all = messagesRef.current;
      const idx = all.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      const history = all.slice(0, idx);
      await store.deleteMessages(all.slice(idx).map((m) => m.id));
      setMessages(history);
      const conv = await patchCurrent({ updatedAt: Date.now() });
      await runAnswer(conv, history);
    },
    [patchCurrent, runAnswer, store],
  );

  const editResend = useCallback(
    async (userId: string, text: string) => {
      if (streamRef.current) return;
      const all = messagesRef.current;
      const idx = all.findIndex((m) => m.id === userId);
      const original = all[idx];
      if (!original) return;
      const edited: MessageRecord = { ...original, content: text };
      const history = [...all.slice(0, idx), edited];
      await store.deleteMessages(all.slice(idx + 1).map((m) => m.id));
      await store.putMessage(edited);
      setMessages(history);
      const conv = await patchCurrent({ updatedAt: Date.now(), preview: preview(text) });
      await runAnswer(conv, history);
    },
    [patchCurrent, runAnswer, store],
  );

  // ---------------------------------------------------------------- attaching context

  const setContexts = useCallback(
    (fn: (list: AttachedContext[]) => AttachedContext[]) => patchCurrent({ contexts: fn(currentRef.current.contexts) }, true),
    [patchCurrent],
  );

  const replaceContext = useCallback(
    (key: string, next: AttachedContext) => setContexts((list) => list.map((c) => (c.key === key ? next : c))),
    [setContexts],
  );

  const attachInput = useCallback(
    async (input: string) => {
      const key = input;
      if (currentRef.current.contexts.some((c) => c.key === key)) return;
      setAttachOpen(false);
      await setContexts((list) => [...list, { key, kind: 'input', input, title: input, status: 'loading' }]);
      try {
        const ready = await backend.attachInput(input);
        await replaceContext(key, { ...ready, key });
      } catch (err) {
        await replaceContext(key, { key, kind: 'input', input, title: input, status: 'error', error: toErrorData(err) });
      }
    },
    [backend, setContexts, replaceContext],
  );

  const attachLibrary = useCallback(
    async (item: VideoSummary) => {
      const key = item.ref.url ?? item.id;
      if (currentRef.current.contexts.some((c) => c.key === key)) return;
      setAttachOpen(false);
      await setContexts((list) => [...list, { key, kind: 'input', input: key, videoId: item.id, title: item.title, status: 'loading' }]);
      try {
        const ready = await backend.attachLibraryItem(item);
        await replaceContext(key, { ...ready, key });
      } catch (err) {
        await replaceContext(key, { key, kind: 'input', input: key, title: item.title, status: 'error', error: toErrorData(err) });
      }
    },
    [backend, setContexts, replaceContext],
  );

  const attachCollection = useCallback(
    async (id: string) => {
      const key = `collection:${id}`;
      setAttachOpen(false);
      // One collection per conversation (ChatApiRequest.context.collectionId).
      await setContexts((list) => [...list.filter((c) => c.kind !== 'collection'), { key, kind: 'collection', collectionId: id, title: id, status: 'loading' }]);
      try {
        const ready = await backend.attachCollection(id);
        await replaceContext(key, ready);
      } catch (err) {
        await replaceContext(key, { key, kind: 'collection', collectionId: id, title: id, status: 'error', error: toErrorData(err) });
      }
    },
    [backend, setContexts, replaceContext],
  );

  const attachUpload = useCallback(
    async (file: File) => {
      const ready = await backend.attachUpload(file);
      setAttachOpen(false);
      await setContexts((list) => [...list.filter((c) => c.key !== ready.key), ready]);
    },
    [backend, setContexts],
  );

  const attachLocal = useCallback(
    async (contexts: VideoContext[]) => {
      const ready = await backend.attachLocal(contexts);
      setAttachOpen(false);
      const keys = new Set(ready.map((r) => r.key));
      await setContexts((list) => [...list.filter((c) => !keys.has(c.key)), ...ready]);
    },
    [backend, setContexts],
  );

  const removeContext = useCallback((key: string) => setContexts((list) => list.filter((c) => c.key !== key)), [setContexts]);

  // Hand-off: /chat/?input=... or ?collection=... opens a new chat with that attached, once.
  const handedOff = useRef(false);
  useEffect(() => {
    if (!loaded || handedOff.current || (!props.initialInput && !props.initialCollection)) return;
    handedOff.current = true;
    const c = blankConversation(prefsRef.current);
    currentRef.current = c;
    setCurrent(c);
    setMessages([]);
    if (props.initialInput) attachInput(props.initialInput);
    if (props.initialCollection) attachCollection(props.initialCollection);
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete('input');
      url.searchParams.delete('collection');
      window.history.replaceState(null, '', url);
    }
  }, [loaded, props.initialInput, props.initialCollection, attachInput, attachCollection]);

  // ---------------------------------------------------------------- model choice

  const chooseModel = useCallback(
    (choice: ModelChoice) => {
      patchCurrent({ model: choice });
      updatePrefs({ lastModel: choice });
    },
    [patchCurrent, updatePrefs],
  );

  const setStrict = useCallback(
    (strict: boolean) => {
      patchCurrent({ strict });
      updatePrefs({ lastStrict: strict });
    },
    [patchCurrent, updatePrefs],
  );

  const toggleFavorite = useCallback(
    (id: string) => {
      const favs = prefsRef.current.favorites;
      updatePrefs({ favorites: favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id] });
    },
    [updatePrefs],
  );

  const onUnavailable = useCallback(
    (row: ModelRow) => {
      if (backend.mode === 'client' && row.disabledReason?.startsWith('Needs ')) setSettingsOpen(true);
      else window.open(PROVIDERS_DOC_URL, '_blank', 'noopener,noreferrer');
    },
    [backend.mode],
  );

  // ---------------------------------------------------------------- derived

  const selectedRow = useMemo(() => {
    if (!rows) return undefined;
    return current.model.kind === 'rung' ? rows.find((r) => r.id === (current.model as { rung: string }).rung) : autoPick(rows);
  }, [rows, current.model]);

  const meter = useMemo(() => readMeter(current.contexts, messages, selectedRow, rows ?? [], draft), [current.contexts, messages, selectedRow, rows, draft]);

  const keyFields = useMemo<KeyField[]>(() => {
    const map = new Map<string, Set<string>>();
    for (const r of rows ?? []) {
      if (browserCorsFor(r.service, r.provider, r.tier).status === 'blocked') continue;
      for (const k of r.requires) {
        const set = map.get(k) ?? new Set<string>();
        set.add(serviceLabel(r.service.replace(/#\d+$/, '')));
        map.set(k, set);
      }
    }
    return [...map.entries()].map(([name, set]) => ({ name, unlocks: [...set].join(', ') }));
  }, [rows]);

  const loadingContext = current.contexts.some((c) => c.status === 'loading');

  const exportMarkdown = useCallback(() => {
    const md = conversationToMarkdown(currentRef.current, messagesRef.current);
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(currentRef.current.title);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  // ---------------------------------------------------------------- keyboard shortcuts

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.code === 'KeyO') {
        e.preventDefault();
        newChat();
      } else if (e.altKey && !mod && e.code === 'KeyM') {
        e.preventDefault();
        setPickerOpen(true);
      } else if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        textareaRef.current?.focus();
      } else if (e.key === '/' && !mod && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        textareaRef.current?.focus();
      } else if (e.key === 'Escape' && !pickerOpen && !attachOpen && !settingsOpen) {
        if (streamRef.current) {
          e.preventDefault();
          stop();
        } else if (panel) {
          setPanel(null);
        } else if (drawerOpen) {
          setDrawerOpen(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newChat, stop, pickerOpen, attachOpen, settingsOpen, panel, drawerOpen]);

  // ---------------------------------------------------------------- render

  const openSource = useCallback((source: ChatSource, sources: ChatSource[]) => setPanel({ source, sources }), []);
  const sidebarOpen = prefs.sidebarOpen;

  const sidebar = (
    <Sidebar
      conversations={conversations}
      activeId={isSaved(current.id) ? current.id : null}
      onSelect={selectConversation}
      onNew={newChat}
      onRename={(id, title) => {
        const c = conversations.find((x) => x.id === id);
        if (c) saveConversation({ ...c, title });
      }}
      onDelete={deleteConversation}
      onTogglePin={(id) => {
        const c = conversations.find((x) => x.id === id);
        if (c) saveConversation({ ...c, pinned: !c.pinned });
      }}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-bg text-fg">
      {/* Sidebar: drawer below md, collapsible column from md up. */}
      <div className={cx('hidden w-72 shrink-0 border-r border-border bg-surface', sidebarOpen && 'md:block')}>{sidebar}</div>
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="Close conversations" className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
          <div className="relative h-full w-[85vw] max-w-80 border-r border-border bg-surface shadow-pop">
            <div className="absolute right-2 top-2 z-10">
              <IconButton label="Close conversations" onClick={() => setDrawerOpen(false)}>
                <X size={18} aria-hidden />
              </IconButton>
            </div>
            <div className="h-full pt-10">{sidebar}</div>
          </div>
        </div>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
        <header className="flex items-center gap-2 border-b border-border px-2 py-2 sm:px-3">
          <span className="md:hidden">
            <IconButton label="Conversations" onClick={() => setDrawerOpen(true)}>
              <Menu size={18} aria-hidden />
            </IconButton>
          </span>
          <span className="hidden md:inline-flex">
            <IconButton label={sidebarOpen ? 'Hide conversations' : 'Show conversations'} onClick={() => updatePrefs({ sidebarOpen: !sidebarOpen })}>
              {sidebarOpen ? <PanelLeftClose size={18} aria-hidden /> : <PanelLeftOpen size={18} aria-hidden />}
            </IconButton>
          </span>
          <ModelPicker
            rows={rows}
            error={rowsError}
            choice={current.model}
            strict={current.strict}
            favorites={prefs.favorites}
            mode={backend.mode}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onChoose={chooseModel}
            onToggleFavorite={toggleFavorite}
            onStrictChange={setStrict}
            onUnavailable={onUnavailable}
          />
          <div className="min-w-0 flex-1" />
          <TokenMeter reading={meter} modelLabel={selectedRow?.label ?? 'The model'} onSwitch={(r) => chooseModel({ kind: 'rung', rung: r.id, label: r.label })} />
          {backend.mode === 'client' ? (
            <span className="hidden rounded-pill border border-tier-keyless/60 px-2 py-0.5 text-xs text-fg lg:inline" title="No vid2context server answered; models are called from this browser.">
              Client-only
            </span>
          ) : null}
          <IconButton label="Export as Markdown" onClick={exportMarkdown} disabled={messages.length === 0}>
            <Download size={17} aria-hidden />
          </IconButton>
          <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings size={17} aria-hidden />
          </IconButton>
        </header>

        {!store.persistent ? (
          <p className="border-b border-border bg-warning/10 px-4 py-1.5 text-center text-xs" role="status">
            This browser blocks IndexedDB here, so conversations last only until you close the tab.
          </p>
        ) : null}

        {messages.length === 0 ? (
          <EmptyState mode={backend.mode} onAttach={() => setAttachOpen(true)} hasContext={current.contexts.length > 0} loading={!loaded} />
        ) : (
          <Thread
            messages={messages}
            rows={rows}
            busy={streamingId !== null}
            onOpenSource={openSource}
            onRegenerate={regenerate}
            onEditResend={editResend}
          />
        )}

        {meter.level === 'over' || meter.level === 'warn' ? (
          <div className="mx-auto w-full max-w-3xl px-3 sm:px-6 md:hidden" role="status">
            <p className={cx('rounded-md px-3 py-1.5 text-xs', meter.level === 'over' ? 'bg-danger/15' : 'bg-warning/15')}>
              {meter.level === 'over' ? 'Too long for this model.' : 'Close to this model’s limit.'}
              {meter.suggestion ? (
                <button
                  type="button"
                  className="ml-1.5 text-accent underline underline-offset-2"
                  onClick={() => meter.suggestion && chooseModel({ kind: 'rung', rung: meter.suggestion.id, label: meter.suggestion.label })}
                >
                  Use {meter.suggestion.label}
                </button>
              ) : null}
            </p>
          </div>
        ) : null}

        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={stop}
          streaming={streamingId !== null}
          contexts={current.contexts}
          onRemoveContext={removeContext}
          onAttach={() => setAttachOpen(true)}
          textareaRef={textareaRef}
          {...(loadingContext ? { blockedReason: 'Waiting for the transcript…' } : {})}
        />
      </main>

      {panel ? (
        <div className="fixed inset-0 z-30 bg-bg lg:static lg:z-auto lg:w-[420px] lg:shrink-0">
          <Suspense
            fallback={
              <div className="p-4">
                <Spinner label="Opening source" />
              </div>
            }
          >
            <SourcePanel
              source={panel.source}
              sources={panel.sources}
              loadVideo={backend.loadVideo.bind(backend)}
              onSelect={(s) => setPanel({ source: s, sources: panel.sources })}
              onClose={() => setPanel(null)}
            />
          </Suspense>
        </div>
      ) : null}

      <AttachDialog
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        features={backend.features}
        onLink={attachInput}
        onLibrary={attachLibrary}
        onCollection={attachCollection}
        onUpload={attachUpload}
        onLocal={attachLocal}
        listLibrary={backend.listLibrary.bind(backend)}
        listCollections={backend.listCollections.bind(backend)}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mode={backend.mode}
        apiBase={props.apiBase}
        keyFields={keyFields}
        theme={theme}
        onTheme={(t) => {
          setTheme(t);
          applyTheme(t);
        }}
        onSaveConnection={props.onReconnect}
        onSaveKeys={props.onKeysSaved}
      />
    </div>
  );
}

function EmptyState(props: { mode: 'server' | 'client'; onAttach: () => void; hasContext: boolean; loading: boolean }) {
  if (props.loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label="Loading conversations" />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-10 text-center">
      <span className="v2c-gradient inline-flex h-12 w-12 items-center justify-center rounded-lg">
        <Sparkles size={22} aria-hidden />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">Talk to your videos</h1>
      <p className="max-w-md text-sm text-muted">
        {props.hasContext
          ? 'Your videos are attached. Ask anything; answers cite the moment they come from, and a click opens the video there.'
          : props.mode === 'server'
            ? 'Attach a YouTube link, a podcast, a library video or a collection, then ask. Answers cite timestamps you can click.'
            : 'No vid2context server answered, so this runs in your browser. Attach a vid2context JSON file or paste a timed transcript, then ask.'}
      </p>
      {!props.hasContext ? (
        <Button variant="primary" onClick={props.onAttach}>
          <Paperclip size={15} aria-hidden /> Attach context
        </Button>
      ) : null}
    </div>
  );
}
