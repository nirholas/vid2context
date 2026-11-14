/** One endpoint on the API page: what it does, its parameters and body, Send, curl, and the last response. */
import { CircleAlert, RotateCcw, Send, Square, Terminal } from 'lucide-react';
import { useId } from 'react';
import type { Endpoint, Field, Vars } from '../../lib/api-catalog.ts';
import { type BuiltRequest, bodyText, defaultBody, type FormState, fieldValue, hasBody, toCurl } from '../../lib/playground.ts';
import type { Outcome } from '../../lib/playground-send.ts';
import { Button, Card, CopyButton } from '../ui.tsx';
import { MethodBadge } from './EndpointList.tsx';
import { ResponseView } from './ResponseView.tsx';

const INPUT = 'w-full rounded-v2c-sm border border-border bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-muted';

function FieldInput({
  field,
  value,
  onChange,
  onFile,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
  onFile: (f: File | null) => void;
}) {
  const id = useId();
  const hint = `${id}-hint`;
  const label = (
    <span className="flex items-baseline gap-2">
      <code className="font-mono text-[13px] text-fg">{field.name}</code>
      <span className="text-xs text-subtle">
        {field.in === 'path' ? 'path' : field.in === 'file' ? 'form file' : 'query'}
        {field.required ? ', required' : ''}
      </span>
    </span>
  );

  if (field.kind === 'bool') {
    return (
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={value === '1'}
          onChange={(e) => onChange(e.target.checked ? '1' : '')}
          aria-describedby={hint}
          className="mt-1 size-4 accent-[var(--v2c-accent)]"
        />
        <div>
          <label htmlFor={id}>{label}</label>
          <p id={hint} className="text-xs text-muted">
            {field.description}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block">
        {label}
      </label>
      {field.kind === 'select' ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint} className={INPUT}>
          <option value="">Not set</option>
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.kind === 'file' ? (
        <input
          id={id}
          type="file"
          accept="audio/*,video/*"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          aria-describedby={hint}
          className={`${INPUT} file:mr-3 file:rounded file:border-0 file:bg-surface-3 file:px-2 file:py-1 file:text-fg`}
        />
      ) : (
        <input
          id={id}
          type={field.kind === 'number' ? 'number' : 'text'}
          inputMode={field.kind === 'number' ? 'numeric' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={hint}
          aria-required={field.required || undefined}
          className={`${INPUT} font-mono`}
        />
      )}
      <p id={hint} className="text-xs text-muted">
        {field.description}
      </p>
    </div>
  );
}

export function EndpointPanel({
  ep,
  vars,
  form,
  onForm,
  onFile,
  request,
  outcome,
  absent,
  onSend,
  onCancel,
}: {
  ep: Endpoint;
  vars: Vars;
  form: FormState | undefined;
  onForm: (f: FormState | undefined) => void;
  onFile: (f: File | null) => void;
  request: BuiltRequest;
  outcome: Outcome | undefined;
  /** The server's OpenAPI document does not list this route. */
  absent: boolean;
  onSend: () => void;
  onCancel: () => void;
}) {
  const bodyId = useId();
  const sending = outcome?.state === 'sending';
  const body = bodyText(ep, form, vars);
  const edited = !!form && (Object.keys(form.values).length > 0 || form.body !== undefined);
  const blocked = request.missing.length > 0 || !!request.bodyError;
  const setValue = (name: string, v: string) => onForm({ values: { ...form?.values, [name]: v }, body: form?.body });
  const curl = () => toCurl(request, window.location.origin);
  const params = ep.fields;

  return (
    <div className="space-y-5">
      <Card className="space-y-5 p-5">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <MethodBadge method={ep.method} className="w-auto rounded border border-border px-1.5 py-0.5" />
            <code className="font-mono text-sm break-all text-fg">{ep.root ? ep.path : `/api/v1${ep.path}`}</code>
          </div>
          <h2 className="text-lg font-semibold text-fg" data-testid="api-endpoint-title">
            {ep.summary}
          </h2>
          {ep.description && <p className="text-sm text-muted">{ep.description}</p>}
          <div className="flex flex-col gap-1.5 text-xs">
            {absent && (
              <p className="flex items-start gap-2 text-fg">
                <CircleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                This server's OpenAPI document does not list this route, so it will probably answer 404.
                {ep.needs ? ` It needs: ${ep.needs}` : ''}
              </p>
            )}
            {!absent && ep.needs && <p className="text-muted">Needs: {ep.needs}</p>}
            {ep.mutates && <p className="text-muted">Changes saved data on the server. Test all skips it.</p>}
          </div>
        </header>

        {params.length > 0 && (
          <fieldset className="space-y-4">
            <legend className="mb-3 text-sm font-medium text-fg">Parameters</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {params.map((f) => (
                <div key={f.name} className={f.name === 'url' || f.kind === 'file' ? 'sm:col-span-2' : ''}>
                  <FieldInput field={f} value={fieldValue(f, form, vars)} onChange={(v) => setValue(f.name, v)} onFile={onFile} />
                </div>
              ))}
            </div>
          </fieldset>
        )}

        {hasBody(ep) && (
          <div className="space-y-1">
            <label htmlFor={bodyId} className="flex items-baseline gap-2 text-sm font-medium text-fg">
              Body <span className="text-xs font-normal text-subtle">application/json</span>
            </label>
            <textarea
              id={bodyId}
              value={body}
              onChange={(e) => onForm({ values: { ...form?.values }, body: e.target.value })}
              rows={Math.min(18, Math.max(4, body.split('\n').length + 1))}
              spellCheck={false}
              aria-invalid={!!request.bodyError || undefined}
              aria-describedby={request.bodyError ? `${bodyId}-err` : undefined}
              className={`${INPUT} font-mono text-[12.5px] leading-relaxed`}
            />
            {request.bodyError && (
              <p id={`${bodyId}-err`} className="text-xs text-danger">
                Not valid JSON: {request.bodyError}
              </p>
            )}
          </div>
        )}

        <div className="space-y-3">
          <div className="overflow-x-auto rounded-v2c-sm border border-border bg-surface-2 px-3 py-2">
            <code className="font-mono text-xs whitespace-nowrap text-muted" data-testid="api-request-url">
              {ep.method} {request.url}
            </code>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sending ? (
              <Button variant="secondary" onClick={onCancel}>
                <Square className="size-4" aria-hidden /> Cancel
              </Button>
            ) : (
              <Button variant="accent" onClick={onSend} disabled={blocked} data-testid="api-send">
                <Send className="size-4" aria-hidden /> Send
              </Button>
            )}
            <CopyButton getText={curl} label="Copy curl" icon={<Terminal className="size-4" aria-hidden />} />
            {edited && (
              <Button variant="ghost" onClick={() => onForm(undefined)}>
                <RotateCcw className="size-4" aria-hidden /> Reset
              </Button>
            )}
            {request.missing.length > 0 && (
              <span className="text-xs text-muted">Fill in {request.missing.join(', ')} to send.</span>
            )}
            {ep.body && form?.body !== undefined && form.body !== defaultBody(ep, vars) && (
              <span className="text-xs text-subtle">Body edited: it no longer follows the video.</span>
            )}
          </div>
        </div>
      </Card>

      <section aria-labelledby={`${bodyId}-resp`} className="space-y-3">
        <h2 id={`${bodyId}-resp`} className="text-sm font-medium text-fg">
          Response
        </h2>
        {outcome ? (
          <ResponseView key={outcome.state === 'done' ? `${outcome.answer.ms}` : outcome.state} outcome={outcome} />
        ) : (
          <p className="rounded-v2c border border-dashed border-border p-6 text-center text-sm text-subtle">
            Press Send to call this endpoint.
          </p>
        )}
      </section>
    </div>
  );
}
