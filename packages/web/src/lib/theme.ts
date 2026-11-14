/** Theme: localStorage `v2c.theme` (dark, light, system), applied as data-theme on <html>. Dark by default. */

export type Theme = 'dark' | 'light' | 'system';
export const THEME_KEY = 'v2c.theme';
export const THEMES: Theme[] = ['dark', 'light', 'system'];

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
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the theme lasts for this page only.
  }
}
