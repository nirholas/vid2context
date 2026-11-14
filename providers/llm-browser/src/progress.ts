/** Model download and load progress for the browser engines, for the web app's progress bars. */
export interface BrowserAiProgress {
  engine: 'webllm' | 'chrome-ai';
  model: string;
  /** 0..1 when known. */
  progress?: number;
  text: string;
}

const listeners = new Set<(e: BrowserAiProgress) => void>();

/** Subscribe to progress events. Returns an unsubscribe function. */
export function onProgress(listener: (e: BrowserAiProgress) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitProgress(e: BrowserAiProgress): void {
  for (const l of listeners) l(e);
}
