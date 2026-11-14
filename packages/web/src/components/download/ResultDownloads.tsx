/**
 * The "Download video or audio" section of the result page. Renders nothing
 * unless the server offers downloads, so client-only builds and public
 * servers without downloads look exactly as before.
 */
import { Download } from 'lucide-react';
import type { CallOptions } from '../../lib/api.ts';
import { SectionTitle } from '../ui.tsx';
import { DownloadPanel } from './DownloadPanel.tsx';
import { useDownloadStatus } from './use-download-status.ts';

export function ResultDownloads({ url, call, pollMs }: { url: string; call?: CallOptions; pollMs?: number }) {
  const availability = useDownloadStatus(call);
  if (availability.state !== 'on') return null;
  return (
    <section aria-labelledby="download-title" className="space-y-3 rounded-v2c-lg border border-border bg-surface p-4 sm:p-5">
      <SectionTitle id="download-title" icon={<Download className="size-4 text-muted" aria-hidden />}>
        Download video or audio
      </SectionTitle>
      <DownloadPanel url={url} status={availability.status} call={call} pollMs={pollMs} />
    </section>
  );
}

export default ResultDownloads;
