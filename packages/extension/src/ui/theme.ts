/** Extension pages follow the system light or dark setting (the tokens' "system" theme). */
export function applyTheme(): void {
  document.documentElement.dataset.theme = 'system';
}
