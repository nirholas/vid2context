# Podcasts

vid2context reads podcast feeds, Apple Podcasts links and Spotify links. When an episode publishes a transcript in its feed (the Podcasting 2.0 `podcast:transcript` tag), that transcript is used and speech-to-text never runs. Otherwise the episode audio goes to the free-first speech-to-text chain. Everything here is keyless and runs on Node and Cloudflare Workers (not in the browser: most feed hosts send no CORS headers).

Providers: `podcast` (source) and `podcast-transcript` (captions), in [providers/podcast](../../providers/podcast).

## Supported inputs

| Input | Example | Becomes |
|---|---|---|
| Feed URL | `https://rss.buzzsprout.com/1538779.rss` | a feed: list its episodes |
| Any other feed | `podcast:https://example.org/shows/weekly` | a feed, for URLs the heuristics below miss |
| Feed episode | `https://rss.buzzsprout.com/1538779.rss#item=Buzzsprout-20117890` | one episode (the item's guid after `#item=`) |
| Apple Podcasts show | `https://podcasts.apple.com/us/podcast/podnews-weekly-review/id1542481043` | a feed |
| Apple Podcasts episode | the same with `?i=1000801656977` | one episode |
| Spotify show | `https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk` | a feed, when a public feed matches |
| Spotify episode | `https://open.spotify.com/episode/7Hf1JDw7XuetyEqlrIQLaG` (also `intl-xx/` paths and `spotify:episode:` URIs) | one episode, when a public feed matches |

A URL counts as a feed when its path ends in `.rss`, `.xml` or `.atom`, has a `/feed`, `/feeds` or `/rss` segment, or its host only serves feeds (`feeds.megaphone.fm`, `feeds.simplecast.com`, `rss.art19.com`, `feeds.buzzsprout.com`, `rss.buzzsprout.com`, `anchor.fm/s/<id>/podcast/rss`, `feeds.transistor.fm`, `omnycontent.com`, `feed.podbean.com`, `feeds.libsyn.com`, `feeds.acast.com`, `feeds.captivate.fm` and a few more). YouTube, Vimeo and other platform URLs, sitemaps and media files are never treated as feeds. For anything else, put `podcast:` in front. Public servers (`VID2CONTEXT_PUBLIC=1`) refuse the `podcast:` form along with other non-URL inputs, so use a plain feed URL there.

```sh
npm run cli -- list http://mp3s.nashownotes.com/pc20rss.xml --limit 3
npm run cli -- "http://mp3s.nashownotes.com/pc20rss.xml#item=PC20-278"
npm run cli -- "https://podcasts.apple.com/us/podcast/iheart-the-business-deal-that-doesnt-make-any-sense/id1542481043?i=1000801656977"
```

`list` (and `GET /items`, MCP `list_items`) prints episode URLs in the `#item=` form. They resolve back to the same episode, so you can pass them straight to the CLI or the API. The episode web page and the enclosure are in the metadata (`extra.link`, `extra.enclosure`) instead, because passing the enclosure URL would treat it as a plain media file and skip the feed's transcript.

## Listing episodes

Episodes come newest first and stream as the feed downloads, so `--limit 5` on a feed with thousands of episodes stops reading after five. If the first two dated items show an oldest-first feed, the whole feed is read and sorted. Episodes are keyed by their `guid` (else the enclosure URL, link or title), and ids are a SHA-256 of the feed URL and that key, so they stay stable across runs.

## How Apple links are resolved

Apple's iTunes Lookup API (`itunes.apple.com/lookup?id=<show>&entity=podcastEpisode&limit=200`) returns the show's RSS feed and its 200 most recent episodes. The episode is matched by its Apple id there, then found in the feed by guid, enclosure URL or title. For older episodes the title slug in the Apple URL is matched against the feed, and only accepted when exactly one episode fits. Shows Apple hosts without a public feed fail with `unavailable`.

## How Spotify links are resolved, and when they fail

Spotify publishes no RSS, so a Spotify link is matched to a public feed and accepted only when every signal agrees:

1. Spotify oEmbed confirms the link and gives the episode title (for a show link, its latest episode).
2. The public embed page gives the show title and the release date. Spotify does not expose the author without a key, so the release date and the feed's own contents stand in for it.
3. The iTunes Search API lists feeds; only shows with exactly the same title (ignoring case, accents and punctuation) are kept. This drops look-alike feeds that repost a show's episodes under another name.
4. Each remaining feed must have the same channel title and an episode with the same title released within 3 days.

Exactly one feed must pass. Otherwise the request fails with `unsupported-input` and a hint to paste the show's RSS feed or its Apple Podcasts link. vid2context never guesses. Spotify-only shows (exclusives, or shows whose Apple listing has a different title) always fail this way; for example the Gimlet show "Without Fail" has no Apple listing under that exact title.

## Native transcripts

The `podcast-transcript` captions provider reads the episode's `podcast:transcript` tags and picks, in order: WebVTT, SRT (`application/x-subrip`, also `application/srt`), the Podcasting 2.0 JSON format, then HTML. With `--lang`, tags in that language win. If the best file fails to download or parse, the next one is tried. The result has `origin: "native-transcript"` and `producer: "podcast-transcript"`.

- Speakers come from WebVTT voice spans (`<v Name>`), SRT turn labels (`Name: text`, trusted when they repeat) and the JSON `speaker` field.
- Word-level JSON transcripts are merged into phrases per speaker.
- HTML transcripts become one segment per paragraph, timed when the page marks times (Buzzsprout does). When it has none, every segment sits at 0 and the producer is `podcast-transcript/html-untimed`.

Because captions run before audio in the pipeline, an episode with a native transcript costs no download and no speech-to-text call.

## Chapters and people

Chapters come from the `podcast:chapters` JSON file (chapters with `toc: false` are left out), with end times filled from the next chapter and the episode duration. When that file is missing or fails, Podlove Simple Chapters (`psc:chapters`) in the feed are used. `podcast:person` tags (item level, else channel level) are in `extra.persons` with name, role, group, link and image.

## Audio and size limits

Episodes without a native transcript get their enclosure downloaded through `ctx.fetch`:

- Redirects are followed one hop at a time (up to 10), so tracking prefixes such as op3.dev, podtrac, chartable and pdst.fm work on every runtime.
- Every request carries a `vid2context` User-Agent. Some CDNs (Buzzsprout's) refuse requests with none.
- `VID2CONTEXT_MAX_MEDIA_MB` (default 200) caps the download. The feed's declared length is checked before downloading, then the `content-length`, then the bytes as they arrive.
- The file name always has a real audio extension (keyless OVH Whisper rejects files without one).

Long episodes are split for speech-to-text by the pipeline's long-audio handling, not by this provider. Note that the keyless OVH rung accepts only small uploads and about 2 requests a minute, so long episodes without a native transcript need a speech-to-text key (Groq is free) or a local rung; see [speech-to-text.md](speech-to-text.md).
