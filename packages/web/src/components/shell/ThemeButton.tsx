/** One button that cycles the theme: dark, light, system. The icon shows the current theme. */
import { Monitor, Moon, Sun } from 'lucide-react';
import { nextTheme, saveTheme, type Theme, useTheme } from '../../lib/theme.ts';
import { IconButton } from '../ui.tsx';

const ICONS: Record<Theme, typeof Moon> = { dark: Moon, light: Sun, system: Monitor };
const NAMES: Record<Theme, string> = { dark: 'dark', light: 'light', system: 'the system setting' };

export function ThemeButton() {
  const theme = useTheme();
  const next = nextTheme(theme);
  const Icon = ICONS[theme];
  return (
    <IconButton label={`Theme: ${NAMES[theme]}. Switch to ${NAMES[next]}`} onClick={() => saveTheme(next)}>
      <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
    </IconButton>
  );
}
