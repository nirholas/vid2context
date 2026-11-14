/**
 * Cycles dark, light and system. The choice is stored in localStorage
 * `v2c.theme` and applied as data-theme on <html> (an inline script in the
 * head applies it before first paint). Dark is the default.
 */
import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'system';
const ORDER: Theme[] = ['dark', 'light', 'system'];
const KEY = 'v2c.theme';

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'system' || v === 'dark' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

const ICONS: Record<Theme, string> = {
  dark: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
  light:
    'M12 3v2M12 19v2M5 5l1.4 1.4M17.6 17.6 19 19M3 12h2M19 12h2M5 19l1.4-1.4M17.6 6.4 19 5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  system: 'M4 5h16v11H4zM9 20h6M12 16v4',
};

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => setTheme(read()), []);

  function next() {
    const t = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] as Theme;
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // Private mode or storage disabled: the theme still applies for this page.
    }
  }

  const following = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={next}
      aria-label={`Theme: ${theme}. Switch to ${following}.`}
      title={`Theme: ${theme}`}
      data-theme-toggle
      data-current={theme}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d={ICONS[theme]} />
      </svg>
    </button>
  );
}
