/** Copy text, with a textarea fallback for browsers without the async clipboard API (or without permission). */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Permission denied or insecure context: fall through to the legacy path.
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand?.('copy') ?? false;
  ta.remove();
  if (!ok) throw new Error('The browser refused to copy. Select the text and copy it by hand.');
}
