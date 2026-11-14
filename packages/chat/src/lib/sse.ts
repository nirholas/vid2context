/**
 * Server-sent events over fetch. The chat endpoint is a POST, which rules out
 * EventSource, so the body stream is read and parsed here following the
 * WHATWG event-stream rules: `event:` names the event, `data:` lines are
 * joined with newlines, a blank line dispatches, lines starting with `:` are
 * comments, CR, LF and CRLF all end a line.
 */
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  function* takeLines(final: boolean): Generator<SseMessage> {
    for (;;) {
      const m = /\r\n|\r|\n/.exec(buffer);
      if (!m) break;
      // A trailing CR may be the first half of CRLF; wait for more input unless the stream ended.
      if (m[0] === '\r' && m.index === buffer.length - 1 && !final) break;
      const line = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      if (line === '') {
        if (data.length > 0) yield { event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) };
        event = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* takeLines(false);
    }
    buffer += decoder.decode();
    if (buffer && !/[\r\n]$/.test(buffer)) buffer += '\n';
    yield* takeLines(true);
    // Per the spec, an event not ended by a blank line before end of stream is discarded.
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
