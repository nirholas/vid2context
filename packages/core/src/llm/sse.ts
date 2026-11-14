/**
 * Server-Sent Events parser, per the WHATWG EventSource rules. Runtime-neutral:
 * takes a fetch body (ReadableStream of bytes) and yields one message per
 * blank-line-terminated block. Handles CRLF, LF and lone CR line endings,
 * comment lines, multi-line `data:`, events and UTF-8 characters split across
 * chunks, a trailing event with no blank line after it, and abort.
 */

export interface SseMessage {
  /** The `event:` field, when the server sent one. */
  event?: string;
  /** `data:` lines joined with "\n". */
  data: string;
  id?: string;
  /** Reconnection time in milliseconds, when the server sent one. */
  retry?: number;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Parse an SSE byte stream into messages. Releases the reader when the loop exits early. */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let first = true;
  let event: string | undefined;
  let data: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;
  let hasField = false;

  const onAbort = () => {
    reader.cancel(signal ? abortError(signal) : undefined).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // Returns a finished message when the line was blank and fields were collected.
  const line = (text: string): SseMessage | undefined => {
    if (text === '') {
      if (!hasField) return undefined;
      const msg: SseMessage = { data: data.join('\n') };
      if (event !== undefined) msg.event = event;
      if (id !== undefined) msg.id = id;
      if (retry !== undefined) msg.retry = retry;
      event = undefined;
      data = [];
      id = undefined;
      retry = undefined;
      hasField = false;
      return msg;
    }
    if (text.startsWith(':')) return undefined;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      data.push(value);
      hasField = true;
    } else if (field === 'event') {
      event = value;
      hasField = true;
    } else if (field === 'id') {
      if (!value.includes('\0')) id = value;
      hasField = true;
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) retry = Number(value);
      hasField = true;
    }
    return undefined;
  };

  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError(signal);
      if (done) {
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }
      if (first && buffer.length > 0) {
        if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
        first = false;
      }
      // Split complete lines. A trailing CR may be the first half of CRLF, so keep it until more input arrives.
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer.charCodeAt(i);
        if (c !== 10 && c !== 13) continue;
        if (c === 13 && i === buffer.length - 1 && !done) break;
        const msg = line(buffer.slice(start, i));
        if (c === 13 && buffer.charCodeAt(i + 1) === 10) i++;
        start = i + 1;
        if (msg) {
          yield msg;
          if (signal?.aborted) throw abortError(signal);
        }
      }
      buffer = buffer.slice(start);
      if (done) {
        // A final event without its blank line still counts.
        if (buffer.length > 0) line(buffer);
        const last = line('');
        if (last) yield last;
        return;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      await reader.cancel();
    } catch {
      // The stream already errored or closed.
    }
    reader.releaseLock();
  }
}
