/** Theme: localStorage `v2c.theme` (dark, light, system), applied as data-theme on <html>. Dark by default. */

import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';
export const THEME_KEY = 'v2c.theme';
export const THEMES: Theme[] = ['dark', 'light', 'system'];
/** Fired on `window` with the new theme as `detail` whenever saveTheme runs, so every theme control stays in step. */
export const THEME_EVENT = 'v2c:theme';

export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'system' || t === 'dark' ? t : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the theme lasts for this page only.
  }
}

/** The next theme in the sidebar's one-button cycle: dark, light, system. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'dark';
}

/** The saved theme, updated live when any control changes it. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => {
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_EVENT, on);
    return () => window.removeEventListener(THEME_EVENT, on);
  }, []);
  return theme;
}
