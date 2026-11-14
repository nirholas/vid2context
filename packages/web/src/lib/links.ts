/** Hand-off links to the other apps on the same domain (docs/prompts/SHARED-CONTRACTS.md section 6). */

/** The chat app (prompt 28). */
export const CHAT_PATH = '/chat/';

/** Opens a new chat with this video attached; the user picks the model there. */
export function chatHref(input: string): string {
  return `${CHAT_PATH}?input=${encodeURIComponent(input)}`;
}
