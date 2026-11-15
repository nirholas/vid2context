/**
 * Web Worker for in-browser speech-to-text (local.ts starts it). Whisper's
 * model load and inference run here, off the page's thread, so the page
 * stays responsive and Cancel stops the work by terminating the worker. The
 * loaded model stays in this worker's memory between runs.
 */
import { transcribeLocal } from './transcribe-core.ts';
import { serializeError, type WorkerRequest, type WorkerResponse } from './worker-protocol.ts';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (m: WorkerResponse) => void;
};

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg?.type !== 'run') return;
  transcribeLocal(msg.audio, {
    ...msg.opts,
    onModel: (progress) => scope.postMessage({ type: 'model', id: msg.id, progress }),
  }).then(
    (context) => scope.postMessage({ type: 'done', id: msg.id, context }),
    (err) => scope.postMessage({ type: 'error', id: msg.id, error: serializeError(err) }),
  );
};
