/** Why a link cannot be fetched without an API server, and what to do instead. */
import { Info, Settings, Upload } from 'lucide-react';
import type { ApiState } from '../lib/api-status.tsx';
import { appHref, onAppLinkClick } from '../lib/route.ts';
import { buttonClass, Card } from './ui.tsx';

export function ClientOnlyNotice({ api, input }: { api: ApiState; input?: string }) {
  const reason =
    api.status === 'client-only-build'
      ? 'This copy of the app runs without a server.'
      : `The vid2context API at ${api.base} did not answer.`;
  return (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 space-y-3">
          <h1 className="text-base font-semibold text-fg">Links need an API server</h1>
          {input && <p className="truncate font-mono text-sm text-muted">{input}</p>}
          <p className="text-sm text-fg">
            {reason} YouTube and most video sites block requests that come straight from a browser, so fetching a link needs a
            vid2context server. Start one on your machine with <code className="font-mono">npm run start:server</code>, or set the
            API base in Settings to a server you can reach.
          </p>
          <p className="text-sm text-fg">
            Files still work: drop a video or audio file on the home page and it is transcribed here in your browser.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={appHref('?view=settings')} onClick={(e) => onAppLinkClick(e, '?view=settings')} className={buttonClass('secondary')}>
              <Settings className="size-4" aria-hidden /> Set the API base
            </a>
            <a href={appHref('')} onClick={(e) => onAppLinkClick(e, '')} className={buttonClass('ghost')}>
              <Upload className="size-4" aria-hidden /> Drop a file instead
            </a>
          </div>
        </div>
      </div>
    </Card>
  );
}
