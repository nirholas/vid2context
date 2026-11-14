/**
 * Browser settings shared with the other web packages (SHARED-CONTRACTS
 * section 6): API base in localStorage `v2c.apiBase`, theme in `v2c.theme`
 * applied as data-theme on <html>. Mode detection: client-only when the
 * build sets VITE_CLIENT_ONLY=1 or the API does not answer /health.
 */
import type { ApiClient } from './api.ts';

export type Theme = 'dark' | 'light' | 'system';

const API_BASE_KEY = 'v2c.apiBase';
const THEME_KEY = 'v2c.theme';

function ls(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function defaultApiBase(): string {
  return (import.meta.env?.VITE_API_BASE as string | undefined) || '/api/v1';
}

export function getApiBase(): string {
  return ls()?.getItem(API_BASE_KEY) || defaultApiBase();
}

export function setApiBase(base: string): void {
  const s = ls();
  if (!s) return;
  if (!base.trim() || base.trim() === defaultApiBase()) s.removeItem(API_BASE_KEY);
  else s.setItem(API_BASE_KEY, base.trim());
}

export function getTheme(): Theme {
  const t = ls()?.getItem(THEME_KEY);
  return t === 'light' || t === 'system' || t === 'dark' ? t : 'dark';
}

export function applyTheme(theme: Theme): void {
  ls()?.setItem(THEME_KEY, theme);
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
}

export function clientOnlyBuild(): boolean {
  const v = import.meta.env?.VITE_CLIENT_ONLY as string | undefined;
  return v === '1' || v === 'true';
}

/** 'server' when the API answers /health within the timeout, else 'client'. */
export async function detectMode(api: ApiClient, timeoutMs = 4000): Promise<'server' | 'client'> {
  if (clientOnlyBuild()) return 'client';
  try {
    const health = await api.health(AbortSignal.timeout(timeoutMs));
    return health && health.ok !== false ? 'server' : 'client';
  } catch {
    return 'client';
  }
}
