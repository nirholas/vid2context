/** Above an imported result: where the transcript lives now, so nobody wonders why the server does not know it. */
import { Info } from 'lucide-react';

export function ImportedNotice({ saved, clientOnly }: { saved: boolean; clientOnly: boolean }) {
  const where = clientOnly
    ? "It was built here in your browser and is kept in this browser's history."
    : saved
      ? 'The server saved it, so the API, chat and MCP use it for this video too.'
      : "This server does not store imported transcripts, so it is kept in this browser's history only.";
  return (
    <p
      className="flex items-start gap-2 rounded-v2c border border-border bg-surface-2 px-3 py-2 text-sm text-fg"
      data-testid="imported-notice"
      data-saved={saved ? 'true' : 'false'}
    >
      <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <span>Imported transcript. {where}</span>
    </p>
  );
}
