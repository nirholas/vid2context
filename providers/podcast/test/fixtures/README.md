# providers/podcast test fixtures

Real responses, recorded with curl and Python `urllib` from a US VM. Feeds, transcripts and chapters on 2026-11-14; the iTunes, Spotify, Atom and enclosure files on 2026-11-15. Long responses are trimmed as noted (trimmed XML still parses as XML). Email addresses are replaced with `[address removed]`; Spotify page tokens are replaced with `[removed]`.

## Feeds

| File | Source | Notes |
|---|---|---|
| `pc20-feed.xml` | `http://mp3s.nashownotes.com/pc20rss.xml` (Podcasting 2.0, Podcast Index) | Trimmed to its 2 `podcast:liveItem`s and 3 newest items. Carries `podcast:transcript` (SRT, typed `application/srt`) and `podcast:chapters` on every item. |
| `pnwr-feed.xml` | `https://rss.buzzsprout.com/1538779.rss` (Podnews Weekly Review) | Trimmed to 4 items: the 3 newest and the 2020 trailer. Four `podcast:transcript` types per item (HTML, JSON, SRT, VTT), `podcast:chapters` and `psc:chapters`. |
| `jre-feed.xml` | `https://feeds.megaphone.fm/GLT1412515089` (The Joe Rogan Experience) | Plain iTunes-style feed, trimmed to 3 items. Used for the Spotify match. |
| `ssgl-feed.xml` | `https://feeds.megaphone.fm/NATIONALAERONAUTICSANDSPACEADMINISTRATION5360639309` (NASA, Small Steps, Giant Leaps) | Plain iTunes-style feed, trimmed to the 3 newest items and the 2018 preview episode. |
| `cre-atom.xml` | `https://cre.fm/feed/atom` | Atom, 3 entries; the entries have empty `<id>` and no enclosure. |
| `huffduffer-adactio-atom.xml` | `https://huffduffer.com/adactio/atom` | Atom with `rel="enclosure"` links, trimmed to 4 entries. |

## Transcripts and chapters

| File | Source |
|---|---|
| `pc20-278-captions.srt` | `https://mp3s.nashownotes.com/PC20-278-Captions.srt` (trimmed to the first cues) |
| `pc20-278-chapters.json` | the feed's `podcast:chapters` URL, `https://reflex.livewire.io/chapters/podcast/917393e3-1b1e-5cef-ace4-edaa54e1f810/item/PC20-278/chapters/https://mp3s.nashownotes.com/PC20-278-Chapters.json` (complete) |
| `pnwr-20117890-transcript.vtt`, `.srt`, `.json`, `.html` | `https://www.buzzsprout.com/1538779/20117890/transcript.vtt`, `.srt`, `.json` and `/transcript` (each trimmed to the opening minutes; the SRT and JSON were cut at a cue or segment boundary and re-saved, so their bytes are not a prefix of the original) |
| `pnwr-20117890-chapters.json` | `https://www.buzzsprout.com/1538779/20117890/chapters.json` (complete) |

## Apple, iTunes Search and Spotify

| File | Request | Notes |
|---|---|---|
| `itunes-lookup-1542481043.json` | `GET https://itunes.apple.com/lookup?id=1542481043&entity=podcastEpisode&limit=200` | Podnews Weekly Review. 201 results, trimmed to the show and its 4 newest episodes. |
| `itunes-lookup-1445597915.json` | same for id 1445597915 | Small Steps, Giant Leaps. 185 results, trimmed to the show and 4 episodes. The preview episode (track 1000668876787) is outside the trimmed set, which exercises the URL-slug fallback. |
| `itunes-search-the-joe-rogan-experience.json` | `GET https://itunes.apple.com/search?media=podcast&term=The+Joe+Rogan+Experience&limit=10` | 9 results trimmed to 5: one exact title, four look-alike shows. |
| `itunes-search-without-fail.json` | same with `term=Without+Fail` | 10 results, none titled exactly "Without Fail". |
| `spotify-oembed-episode-7Hf1JDw7XuetyEqlrIQLaG.json` | `GET https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Fepisode%2F7Hf1JDw7XuetyEqlrIQLaG` | JRE #2581. |
| `spotify-oembed-show-4rOoJ6Egrf8K2IrywzwOMk.json` | same for `show/4rOoJ6Egrf8K2IrywzwOMk` | The Joe Rogan Experience: oEmbed titles a show by its latest episode. |
| `spotify-oembed-show-5CfCWKI5pZ28U0uOzXkDHe.json` | same for `show/5CfCWKI5pZ28U0uOzXkDHe` | Without Fail (Gimlet). |
| `spotify-embed-*.html` | `GET https://open.spotify.com/embed/<kind>/<id>` for the three ids above | Full pages; `accessToken`, `clientId` and `correlationId` values replaced. The `__NEXT_DATA__` entity gives the show title (`subtitle`) and release date. |

## Enclosure audio

| File | Request | Notes |
|---|---|---|
| `pnwr-trailer-hops.json` | `GET https://op3.dev/e/www.buzzsprout.com/1538779/episodes/6749611-the-podnews-weekly-review-the-last-word-in-podcast-news.mp3` with redirects not followed, then each `location` in turn | Status and the headers the provider reads for each of the 3 hops (op3.dev 302, buzzsprout.com 302, audio.buzzsprout.com 200). |
| `pnwr-trailer.mp3` | the body of the final hop | 916,092 bytes, 73 s: the Podnews Weekly Review trailer, as published in the public feed. |

Buzzsprout's CDN answers 403 to requests whose User-Agent is `node` or curl's default, which is why the provider names itself in every request.
