/**
 * Persistence for the workspace. IndexedDB database `v2c-chat` keeps
 * conversations, messages, the transcripts of videos attached in client-only
 * mode, and preferences (favorite models, last model choice). Provider keys
 * live in the shared `v2c-settings` database (store `kv`, key
 * `providerKeys`), as SHARED-CONTRACTS section 6 specifies, so the web app
 * and this workspace see the same keys.
 *
 * MemoryChatStore implements the same interface in memory. The workspace
 * uses it when IndexedDB is unavailable (some private windows), and says so.
 */
import type { VideoContext } from '@vid2context/core';
import type { Conversation, MessageRecord, ModelChoice } from './types.ts';

export interface Prefs {
  favorites: string[];
  lastModel: ModelChoice;
  lastStrict: boolean;
  sidebarOpen: boolean;
}

export const DEFAULT_PREFS: Prefs = { favorites: [], lastModel: { kind: 'auto' }, lastStrict: false, sidebarOpen: true };

export interface ChatStore {
  readonly persistent: boolean;
  listConversations(): Promise<Conversation[]>;
  putConversation(c: Conversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  listMessages(conversationId: string): Promise<MessageRecord[]>;
  putMessage(m: MessageRecord): Promise<void>;
  deleteMessages(ids: string[]): Promise<void>;
  getContext(videoId: string): Promise<VideoContext | undefined>;
  putContext(c: VideoContext): Promise<void>;
  getPrefs(): Promise<Prefs>;
  putPrefs(p: Prefs): Promise<void>;
}

export class MemoryChatStore implements ChatStore {
  readonly persistent = false;
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, MessageRecord>();
  private contexts = new Map<string, VideoContext>();
  private prefs: Prefs = { ...DEFAULT_PREFS };

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()].map(clone).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async putConversation(c: Conversation): Promise<void> {
    this.conversations.set(c.id, clone(c));
  }
  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    for (const [k, m] of this.messages) if (m.conversationId === id) this.messages.delete(k);
  }
  async listMessages(conversationId: string): Promise<MessageRecord[]> {
    return [...this.messages.values()]
      .filter((m) => m.conversationId === conversationId)
      .map(clone)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async putMessage(m: MessageRecord): Promise<void> {
    this.messages.set(m.id, clone(m));
  }
  async deleteMessages(ids: string[]): Promise<void> {
    for (const id of ids) this.messages.delete(id);
  }
  async getContext(videoId: string): Promise<VideoContext | undefined> {
    const c = this.contexts.get(videoId);
    return c ? clone(c) : undefined;
  }
  async putContext(c: VideoContext): Promise<void> {
    this.contexts.set(c.metadata.ref.id, clone(c));
  }
  async getPrefs(): Promise<Prefs> {
    return clone(this.prefs);
  }
  async putPrefs(p: Prefs): Promise<void> {
    this.prefs = clone(p);
  }
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

// ---------------------------------------------------------------- IndexedDB

const CHAT_DB = 'v2c-chat';
const CHAT_DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function open(name: string, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = () => upgrade(r.result);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(`${name} is open in an older version in another tab; close it and reload.`));
  });
}

export class IdbChatStore implements ChatStore {
  readonly persistent = true;
  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<IdbChatStore> {
    const db = await open(CHAT_DB, CHAT_DB_VERSION, (d) => {
      if (!d.objectStoreNames.contains('conversations')) d.createObjectStore('conversations', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('messages')) {
        const s = d.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('byConversation', 'conversationId');
      }
      if (!d.objectStoreNames.contains('contexts')) d.createObjectStore('contexts');
      if (!d.objectStoreNames.contains('prefs')) d.createObjectStore('prefs');
    });
    return new IdbChatStore(db);
  }

  async listConversations(): Promise<Conversation[]> {
    const tx = this.db.transaction('conversations');
    const all = await req(tx.objectStore('conversations').getAll() as IDBRequest<Conversation[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async putConversation(c: Conversation): Promise<void> {
    const tx = this.db.transaction('conversations', 'readwrite');
    tx.objectStore('conversations').put(c);
    await done(tx);
  }
  async deleteConversation(id: string): Promise<void> {
    const tx = this.db.transaction(['conversations', 'messages'], 'readwrite');
    tx.objectStore('conversations').delete(id);
    const keys = await req(tx.objectStore('messages').index('byConversation').getAllKeys(id));
    for (const k of keys) tx.objectStore('messages').delete(k);
    await done(tx);
  }
  async listMessages(conversationId: string): Promise<MessageRecord[]> {
    const tx = this.db.transaction('messages');
    const all = await req(tx.objectStore('messages').index('byConversation').getAll(conversationId) as IDBRequest<MessageRecord[]>);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  async putMessage(m: MessageRecord): Promise<void> {
    const tx = this.db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put(m);
    await done(tx);
  }
  async deleteMessages(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = this.db.transaction('messages', 'readwrite');
    for (const id of ids) tx.objectStore('messages').delete(id);
    await done(tx);
  }
  async getContext(videoId: string): Promise<VideoContext | undefined> {
    const tx = this.db.transaction('contexts');
    return (await req(tx.objectStore('contexts').get(videoId))) as VideoContext | undefined;
  }
  async putContext(c: VideoContext): Promise<void> {
    const tx = this.db.transaction('contexts', 'readwrite');
    tx.objectStore('contexts').put(c, c.metadata.ref.id);
    await done(tx);
  }
  async getPrefs(): Promise<Prefs> {
    const tx = this.db.transaction('prefs');
    const p = (await req(tx.objectStore('prefs').get('prefs'))) as Partial<Prefs> | undefined;
    return { ...DEFAULT_PREFS, ...(p ?? {}) };
  }
  async putPrefs(p: Prefs): Promise<void> {
    const tx = this.db.transaction('prefs', 'readwrite');
    tx.objectStore('prefs').put(p, 'prefs');
    await done(tx);
  }
}

/** IndexedDB when the browser allows it, otherwise memory. */
export async function openChatStore(): Promise<ChatStore> {
  if (typeof indexedDB === 'undefined') return new MemoryChatStore();
  try {
    return await IdbChatStore.open();
  } catch {
    return new MemoryChatStore();
  }
}

// ---------------------------------------------------------------- shared settings (v2c-settings)

const SETTINGS_DB = 'v2c-settings';
const SETTINGS_VERSION = 1;

function openSettings(): Promise<IDBDatabase> {
  return open(SETTINGS_DB, SETTINGS_VERSION, (d) => {
    if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
  });
}

async function settingsGet<T>(key: string): Promise<T | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  const db = await openSettings();
  try {
    return (await req(db.transaction('kv').objectStore('kv').get(key))) as T | undefined;
  } finally {
    db.close();
  }
}

async function settingsSet(key: string, value: unknown): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('This browser has no IndexedDB, so keys cannot be saved.');
  const db = await openSettings();
  try {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    await done(tx);
  } finally {
    db.close();
  }
}

/** Env-style provider keys (`GROQ_API_KEY`, ...) the user saved for client-only mode. */
export async function loadProviderKeys(): Promise<Record<string, string>> {
  return (await settingsGet<Record<string, string>>('providerKeys')) ?? {};
}

export async function saveProviderKeys(keys: Record<string, string>): Promise<void> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(keys)) if (v.trim()) clean[k] = v.trim();
  await settingsSet('providerKeys', clean);
}

/** Bearer key for a server that has VID2CONTEXT_API_KEYS set. Stored next to the provider keys. */
export async function loadServerApiKey(): Promise<string> {
  return (await settingsGet<string>('serverApiKey')) ?? '';
}

export async function saveServerApiKey(key: string): Promise<void> {
  await settingsSet('serverApiKey', key.trim());
}
