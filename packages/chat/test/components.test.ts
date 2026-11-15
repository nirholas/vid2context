// @vitest-environment jsdom
/**
 * Component tests on recorded data. The workspace runs with its real
 * backends: ClientBackend over the browser registry with replayFetch serving
 * the recorded OVH and Groq responses, and ServerBackend whose ApiClient
 * replays the local server's recorded /chat stream and the shared
 * VideoContext fixture as GET /context.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearCooldowns } from '@vid2context/core';
import { replayFetch } from '@vid2context/core/testing';
import { createRegistry } from '@vid2context/registry/browser';
import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatWorkspace } from '../src/components/ChatWorkspace.tsx';
import { ModelPicker } from '../src/components/ModelPicker.tsx';
import { ApiClient } from '../src/lib/api.ts';
import { ClientBackend, ServerBackend } from '../src/lib/backend.ts';
import { toModelRows } from '../src/lib/models.ts';
import { MemoryChatStore } from '../src/lib/store.ts';
import type { ModelChoice, ModelRow } from '../src/lib/types.ts';
import { clientRecording, fixture, fixtureJson, routesFor, serverModels, sharedContextText } from './helpers.ts';

beforeEach(() => clearCooldowns());
afterEach(() => cleanup());

// ---------------------------------------------------------------- model picker

function Picker(props: { rows: ModelRow[]; onUnavailable?: (r: ModelRow) => void; mode?: 'server' | 'client' }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ModelChoice>({ kind: 'auto' });
  const [strict, setStrict] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  return createElement(ModelPicker, {
    rows: props.rows,
    choice,
    strict,
    favorites,
    mode: props.mode ?? 'server',
    open,
    onOpenChange: setOpen,
    onChoose: setChoice,
    onToggleFavorite: (id: string) => setFavorites((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id])),
    onStrictChange: setStrict,
    onUnavailable: props.onUnavailable ?? (() => {}),
  });
}

describe('ModelPicker with the real /models list', () => {
  const rows = toModelRows(serverModels(), 'server');

  function open() {
    render(createElement(Picker, { rows }));
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }));
    return screen.getByRole('listbox', { name: 'Models' });
  }

  it('puts Auto first, recommended, then tiers in free-first order', () => {
    const list = open();
    const options = within(list).getAllByRole('option');
    expect(options[0]?.textContent).toMatch(/Auto/);
    expect(options[0]?.textContent).toMatch(/Recommended/);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    const groups = within(list)
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-labelledby'))
      .map((id) => document.getElementById(id ?? '')?.textContent);
    expect(groups).toEqual(['Local', 'Free', 'Keyless', 'Paid']);
    expect(options).toHaveLength(rows.length + 1);
  });

  it('filters by label, service and capability', () => {
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gpt-oss ovh' } });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.getAttribute('data-rung')).toBe('llm/ovh/gpt-oss-120b');
  });

  it('shows what a disabled row needs and hands it to onUnavailable instead of choosing it', () => {
    const onUnavailable = vi.fn();
    render(createElement(Picker, { rows, onUnavailable }));
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }));
    const groq = document.querySelector('[data-rung="llm/groq/openai/gpt-oss-120b"]') as HTMLElement;
    expect(groq.getAttribute('aria-disabled')).toBe('true');
    expect(groq.textContent).toContain('Needs GROQ_API_KEY');
    fireEvent.click(groq);
    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({ id: 'llm/groq/openai/gpt-oss-120b' }));
    expect(screen.getByRole('button', { name: /Change model/ }).getAttribute('aria-label')).toMatch(/^Model: Auto\./);
  });

  it('chooses with the keyboard and stars with Alt+S into a Favorites group', () => {
    open();
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'gpt-oss ovh' } });
    fireEvent.keyDown(box, { key: 's', code: 'KeyS', altKey: true });
    fireEvent.change(box, { target: { value: '' } });
    const favGroup = within(screen.getByRole('listbox'))
      .getAllByRole('group')
      .find((g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent?.includes('Favorites'));
    expect(favGroup).toBeDefined();
    expect(
      within(favGroup as HTMLElement)
        .getAllByRole('option')[0]
        ?.getAttribute('data-rung'),
    ).toBe('llm/ovh/gpt-oss-120b');
    fireEvent.change(box, { target: { value: 'gpt-oss ovh' } });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: /Change model/ }).getAttribute('aria-label')).toMatch(/^Model: gpt-oss-120b\./);
  });

  it('toggles Strict from the footer', () => {
    open();
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });
});

// ---------------------------------------------------------------- the workspace

const registry = createRegistry();

/** Serve the recorded body in small pieces with a pause, so a test can act mid-stream. */
function paced(inner: typeof fetch, pieceBytes = 2000, delayMs = 5): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    if (!res.body) return res;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (init?.signal?.aborted) {
          controller.error(new DOMException('Aborted', 'AbortError'));
          return;
        }
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(bytes.slice(offset, offset + pieceBytes));
        offset += pieceBytes;
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

function renderWorkspace(backend: ClientBackend | ServerBackend, store: MemoryChatStore, extra: Record<string, unknown> = {}) {
  return render(
    createElement(ChatWorkspace, {
      backend,
      store,
      apiBase: '/api/v1',
      onReconnect: async () => {},
      onKeysSaved: async () => {},
      ...extra,
    }),
  );
}

async function attachJsonFixture() {
  fireEvent.click(await screen.findByRole('button', { name: 'Attach context' }));
  fireEvent.click(screen.getByRole('tab', { name: /JSON files/ }));
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  const file = new File([sharedContextText('cCPsdFdlshc')], 'youtube-cCPsdFdlshc.json', { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(document.querySelector('[data-context="youtube:cCPsdFdlshc"]')).not.toBeNull());
}

async function ask(text: string) {
  const box = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

function assistant(): HTMLElement {
  const all = document.querySelectorAll<HTMLElement>('[data-role=assistant]');
  return all[all.length - 1] as HTMLElement;
}

describe('ChatWorkspace in client-only mode, replaying a real OVH stream', () => {
  const rec = clientRecording('ovh-gpt-oss');

  it('blocks sending until a video is attached', async () => {
    const backend = new ClientBackend(registry, {}, new MemoryChatStore(), replayFetch([]));
    renderWorkspace(backend, new MemoryChatStore());
    const box = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'hello' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Attach a video to ask about it')).toBeTruthy();
  });

  it('streams the answer, keeps reasoning in a collapsed disclosure, and opens a citation at its moment', async () => {
    const store = new MemoryChatStore();
    // The recording is OVH gpt-oss-120b, strict; start the conversation with that choice.
    await store.putPrefs({
      favorites: [],
      lastModel: { kind: 'rung', rung: 'llm/ovh/gpt-oss-120b', label: 'gpt-oss-120b' },
      lastStrict: true,
      sidebarOpen: true,
    });
    const fetch = replayFetch(routesFor(rec));
    renderWorkspace(new ClientBackend(registry, {}, store, fetch), store);
    await attachJsonFixture();
    await ask(rec.request.messages[0]?.content ?? '');
    await waitFor(() => expect(assistant().getAttribute('data-status')).toBe('done'), { timeout: 10_000 });

    const details = assistant().querySelector('details');
    expect(details?.textContent).toMatch(/Thinking/);
    expect(details?.open).toBe(false);
    const chips = await waitFor(
      () => {
        const found = assistant().querySelectorAll<HTMLElement>('[data-cite]');
        expect(found.length).toBeGreaterThan(0);
        return found;
      },
      { timeout: 10_000 },
    );
    const first = chips[0] as HTMLElement;
    expect(first.textContent).toMatch(/Best & Worst G-Wagon Years.* @ \d+:\d\d/);
    expect(assistant().querySelector('[data-model-tag]')?.textContent).toContain('gpt-oss-120b');

    await act(async () => fireEvent.click(first));
    const iframe = await waitFor(
      () => {
        const f = document.querySelector('iframe');
        expect(f).not.toBeNull();
        return f as HTMLIFrameElement;
        // The source panel is a lazy chunk; under a loaded machine its import can exceed the 1 s default.
      },
      { timeout: 10_000 },
    );
    const n = Number(first.getAttribute('data-cite'));
    const meta = rec.events.find((e) => e.type === 'meta') as { sources: { n: number; startSec: number }[] };
    const start = Math.floor(meta.sources.find((s) => s.n === n)?.startSec ?? -1);
    expect(iframe.src).toBe(`https://www.youtube-nocookie.com/embed/cCPsdFdlshc?start=${start}&autoplay=1&rel=0`);
    await waitFor(() => expect(document.querySelectorAll('[data-cited]').length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
  });

  it('stops mid-stream and keeps the partial answer', async () => {
    const store = new MemoryChatStore();
    const fetch = paced(replayFetch(routesFor(rec)), 1500, 15);
    renderWorkspace(new ClientBackend(registry, {}, store, fetch), store);
    await attachJsonFixture();
    await ask(rec.request.messages[0]?.content ?? '');
    const stop = await screen.findByRole('button', { name: /Stop/ });
    await waitFor(() => expect(assistant().querySelector('details')).not.toBeNull(), { timeout: 10_000 });
    await act(async () => fireEvent.click(stop));
    await waitFor(() => expect(assistant().getAttribute('data-status')).toBe('stopped'));
    expect(screen.getByText('Stopped.')).toBeTruthy();
    const saved = await store.listMessages((await store.listConversations())[0]?.id ?? '');
    expect(saved.at(-1)?.status).toBe('stopped');
  });

  it('shows the hint and every attempt when all models fail (real Groq 401)', async () => {
    const bad = clientRecording('groq-bad-key');
    const store = new MemoryChatStore();
    const backend = new ClientBackend(registry, { GROQ_API_KEY: 'invalid-key-for-fixture' }, store, replayFetch(routesFor(bad)));
    await store.putPrefs({
      favorites: [],
      lastModel: { kind: 'rung', rung: 'llm/groq/openai/gpt-oss-120b', label: 'gpt-oss-120b' },
      lastStrict: true,
      sidebarOpen: true,
    });
    renderWorkspace(backend, store);
    await attachJsonFixture();
    await ask(bad.request.messages[0]?.content ?? '');
    const alert = await screen.findByRole('alert', {}, { timeout: 10_000 });
    expect(alert.textContent).toContain('all-rungs-failed');
    expect(alert.textContent).toMatch(/rejected the key/);
    const toggle = within(alert).queryByRole('button', { name: /details/i });
    if (toggle) fireEvent.click(toggle);
    expect(alert.textContent).toContain('llm/groq/openai/gpt-oss-120b');
    expect(alert.textContent).toContain('auth-401');
    expect(within(alert).getByRole('button', { name: /Retry/ })).toBeTruthy();
  });
});

describe('ChatWorkspace in server mode, replaying the local server', () => {
  const sse = fixture('server-chat-cCPsdFdlshc.sse');
  const routes = [
    {
      method: 'GET',
      url: /\/api\/v1\/models\?kind=llm$/,
      response: { body: fixture('server-models.json'), headers: { 'content-type': 'application/json' } },
    },
    {
      method: 'GET',
      url: /\/api\/v1\/context\?url=/,
      response: { body: sharedContextText('cCPsdFdlshc'), headers: { 'content-type': 'application/json' } },
    },
    { method: 'POST', url: /\/api\/v1\/chat$/, response: { body: sse, headers: { 'content-type': 'text/event-stream' } } },
  ];

  it('attaches the hand-off input, sends it as context, and refines chip times from done.citations', async () => {
    const fetch = replayFetch(routes);
    const store = new MemoryChatStore();
    const api = new ApiClient({ base: 'http://127.0.0.1/api/v1', fetch });
    renderWorkspace(new ServerBackend(api, store, null), store, { initialInput: 'https://www.youtube.com/watch?v=cCPsdFdlshc' });
    await waitFor(() =>
      expect(document.querySelector('[data-context] img, [data-context]')?.textContent).toContain('Best & Worst'),
    );
    await ask('Which engine does the 2000 G500 have?');
    await waitFor(() => expect(assistant().getAttribute('data-status')).toBe('done'), { timeout: 10_000 });

    const chatCall = fetch.calls.find((c) => c.url.endsWith('/chat'));
    const body = JSON.parse(String(chatCall?.body));
    expect(body.context).toEqual({ inputs: ['https://www.youtube.com/watch?v=cCPsdFdlshc'] });
    expect(body.model).toBeUndefined();
    const chips = [...assistant().querySelectorAll<HTMLElement>('[data-cite]')].map((c) => c.textContent);
    expect(chips).toEqual(['Best & Worst G-Wagon Years: Rel… @ 0:40', 'Best & Worst G-Wagon Years: Rel… @ 1:22']);
    expect(assistant().querySelector('[data-model-tag]')?.textContent).toContain('nemotron-3-ultra-550b-a55b:free');
  });

  it('renders the server error body with its hint', async () => {
    const err = fixtureJson<{ status: number; body: unknown }>('server-error-strict-disabled.json');
    const fetch = replayFetch([
      ...routes.filter((r) => r.method === 'GET'),
      {
        method: 'POST',
        url: /\/api\/v1\/chat$/,
        response: { status: err.status, body: JSON.stringify(err.body), headers: { 'content-type': 'application/json' } },
      },
    ]);
    const store = new MemoryChatStore();
    const api = new ApiClient({ base: 'http://127.0.0.1/api/v1', fetch });
    renderWorkspace(new ServerBackend(api, store, null), store, { initialInput: 'https://www.youtube.com/watch?v=cCPsdFdlshc' });
    await waitFor(() => expect(document.querySelector('[data-context]')?.textContent).toContain('Best & Worst'));
    await ask('hi');
    const alert = await screen.findByRole('alert', {}, { timeout: 10_000 });
    expect(alert.textContent).toContain('is not enabled on this server');
    expect(alert.textContent).toContain('Set GROQ_API_KEY to enable it');
  });
});
