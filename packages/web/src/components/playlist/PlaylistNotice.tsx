/**
 * Above a video when its link also names a playlist (a YouTube watch URL with
 * list=): the playlist's title and size, and a link that opens the playlist.
 * The video stays what the page shows; the playlist is one click away. Shows
 * nothing while loading, for links without a playlist, and when the API
 * cannot be asked. Used by the result view and the download page.
 */
import { ListVideo } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type CallOptions, getPlaylistOf, type PlaylistInfo } from '../../lib/api.ts';
import { isAbort } from '../../lib/errors.ts';
import { appHref, onAppLinkClick } from '../../lib/route.ts';
import { buttonClass } from '../ui.tsx';

/**
 * Only links that carry list= can name a playlist, and a playlist's own page
 * (/playlist?list=) is the playlist, not a video inside one. Others skip the
 * request; the server decides for the rest.
 */
export function mayNamePlaylist(input: string): boolean {
  return /[?&]list=/.test(input) && !/\/playlist\?/.test(input);
}

export function PlaylistNotice({
  input,
  enabled = true,
  searchFor,
  call = {},
}: {
  /** The link the user opened. */
  input: string;
  /** False while the API is unknown or absent (client-only mode). */
  enabled?: boolean;
  /** The app query string that opens the playlist, for example runSearch or downloadSearch. */
  searchFor: (playlistUrl: string) => string;
  call?: CallOptions;
}) {
  const [playlist, setPlaylist] = useState<PlaylistInfo | null>(null);
  const callRef = useRef(call);
  callRef.current = call;

  useEffect(() => {
    setPlaylist(null);
    if (!enabled || !mayNamePlaylist(input)) return;
    const ac = new AbortController();
    getPlaylistOf(input, { ...callRef.current, signal: ac.signal })
      .then((info) => {
        if (!ac.signal.aborted) setPlaylist(info);
      })
      .catch((err) => {
        if (!isAbort(err)) console.error('[vid2context] could not check the playlist of this link', err);
      });
    return () => ac.abort();
  }, [input, enabled]);

  if (!playlist) return null;
  const search = searchFor(playlist.url);
  const size = playlist.count !== undefined ? `${playlist.count} video${playlist.count === 1 ? '' : 's'}` : undefined;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-v2c border border-border bg-surface-2 px-3 py-2 text-sm text-fg"
      data-testid="playlist-notice"
    >
      <ListVideo className="size-4 shrink-0 text-muted" aria-hidden />
      <p className="min-w-0 flex-1">
        This video is part of a playlist
        {playlist.title ? (
          <>
            : <span className="font-medium">{playlist.title}</span>
          </>
        ) : null}
        {size ? <span className="text-muted"> ({size})</span> : null}.
      </p>
      <a
        href={appHref(search)}
        onClick={(e) => onAppLinkClick(e, search)}
        className={buttonClass('secondary', 'shrink-0')}
        data-testid="playlist-open"
      >
        {size ? `View all ${size}` : 'View the playlist'}
      </a>
    </div>
  );
}
