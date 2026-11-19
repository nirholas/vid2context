# X (Twitter) videos

vid2context turns a video posted on X into a transcript, metadata and direct download links. Paste a post link; no X account, API key or login is needed. It works on Node, on Cloudflare Workers (including the public instance at [vid2context.com](https://vid2context.com)) and from the CLI, MCP server and HTTP API.

Provider: `x` (source), in [providers/x](../../providers/x). Its README has the full field list.

## Try it

```sh
npx vid2context https://x.com/anza_xyz/status/2122763240887468354 --timestamps
```

On vid2context.com the same link returned, on 2026-11-19, the post's title and author (Anza), its 2 min 9 s length, and this transcript from the free Workers AI Whisper rung:

```
[0:00] Sometimes less is more. So we're going to go ahead and simplify the protocol,
[0:04] replacing legacy abstractions and interfaces, pushing more of the execution on-chain,
[0:10] and modernizing some of the wire formats. And all of this, you know, enhances the resiliency,
```

The HTTP API takes the same link: `GET /api/v1/context?url=<post link>`. In MCP clients (Claude, Cursor, VS Code), paste the post link into the chat and the agent calls `get_transcript`.

## Supported links

| Link | Example | Reads |
|---|---|---|
| A post | `https://x.com/<user>/status/<id>` | the post's first video or GIF |
| Older and mirror hosts | `twitter.com`, `mobile.twitter.com`, `mobile.x.com`, `fxtwitter.com`, `vxtwitter.com`, `fixupx.com`, `fixvx.com` | the same post |
| Id-only forms | `/i/status/<id>`, `/i/web/status/<id>`, `/<user>/statuses/<id>` | the same post |
| A media position | `.../status/<id>/video/2` (2 to 4) | that media item of the post |

A post with no video of its own that quotes another post uses the quoted post's video (one level deep). Replies never borrow their parent's video. Live broadcasts, Spaces and profiles are not matched here; on Node, the yt-dlp provider handles broadcasts.

## How a post is read

Three lanes, tried in order until one answers:

1. **X's syndication endpoint**, the JSON behind embedded posts. Keyless.
2. **FxTwitter** (`api.fxtwitter.com`), a public keyless service that also reads some posts the first lane refuses. `X_FXTWITTER=0` turns it off; `X_FXTWITTER_BASE_URL` points at a self-hosted FxEmbed.
3. **x.com GraphQL with a guest token**, only when `X_BEARER_TOKEN` (or `TWITTER_BEARER_TOKEN`) is set: the same lane [xactions](https://github.com/nirholas/xactions) runs for xactions.app/video, for when both keyless lanes are rate limited or down.

Every request names its client. That matters on Cloudflare Workers, whose fetch sends no user-agent: without one, X's syndication endpoint answers 400 and FxTwitter 401.

## Transcripts

X has no public captions API, so the transcript comes from one of two places:

- **Creator captions**, when the poster uploaded them and the yt-dlp provider is installed (Node). The result says `origin: "creator-captions"`. This is the most accurate source and is used first in the default `auto` mode.
- **Speech-to-text** otherwise, through the usual free-first chain: local Whisper, free tiers with your key (Groq, Cloudflare Workers AI), then the keyless OVH lane. Force it with `--mode stt`.

For speech-to-text, the audio is X's audio-only rendition (32 kbps AAC, joined from its HLS fragments into one `.m4a`), not the video file: a 9-minute post is about 2 MB. When the playlist is unusable, the smallest MP4 is used instead. Both stop at `VID2CONTEXT_MAX_MEDIA_MB` (default 200).

### Long videos

The keyless OVH lane takes at most 60 seconds per request, and X audio is `.m4a`, which the built-in MP3 and WAV splitters cannot cut. On Node, the registry adds the ffmpeg splitter, so long X videos are split into pieces under 60 s, transcribed and stitched back with exact timestamps; this needs ffmpeg and ffprobe installed. A 9-minute interview took 128 s end to end on the keyless lane with no keys set. Groq's free tier (`GROQ_API_KEY`) takes 25 MB per request, so it transcribes the same file in one go.

Whisper sometimes gets stuck repeating a phrase on noisy recordings (a conference floor, music). vid2context detects these loops and transcribes the piece again, so the speech under them is recovered; see [long-audio.md](../long-audio.md#decoder-loops).

## Downloading the video

Every MP4 quality X serves is in the metadata as a direct link, highest first:

```sh
npx vid2context https://x.com/NASA/status/2094024294988701975 --format json
```

`metadata.extra.variants` lists `{ url, bitrate, width, height, quality }` for each rendition (`2160p` down to `270p` for that post), all on `video.twimg.com`, which serves them without a login or Referer, so a browser or `curl` can save them directly. To save with format choice, captions and clips instead, use `npx vid2context download <post link>` (Node, yt-dlp). Public servers such as vid2context.com have the download feature off.

## Metadata

`title` (the first line of the post), `description` (the full text with t.co links expanded), `channel` (the author and `https://x.com/<handle>`), `publishedAt`, `durationSec`, `thumbnailUrl` and `tags` (hashtags). `extra` adds the post id, media type and position, size, `variants`, the HLS playlist, likes, replies, reposts and views (FxTwitter and GraphQL only), and `via`: which lane answered (`syndication`, `fxtwitter` or `graphql`).

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `X_FXTWITTER` | on | `0` turns off the FxTwitter lane. |
| `X_FXTWITTER_BASE_URL` | `https://api.fxtwitter.com` | A self-hosted FxEmbed instance. |
| `X_BEARER_TOKEN` | unset | Turns on the GraphQL guest-token lane. `TWITTER_BEARER_TOKEN` works too. Redacted from logs. |
| `X_GRAPHQL_QUERY_ID` | `GZsN2Pc4knAoit6pXa4HSA` | The GraphQL operation id, for when X rotates it. |
| `VID2CONTEXT_MAX_MEDIA_MB` | 200 | Largest audio or video download. |

## When it fails

| Message | Cause | Fix |
|---|---|---|
| `unsupported-input: No source understands "https://x.com/..."` | The server runs a build from before X support (2026-11-15). | Update (`npx vid2context@latest`) or redeploy the server. |
| `not-found: X post <id> was not found` | The post is deleted, protected, from a suspended account, or the link is wrong. | Only public posts can be read. |
| `unavailable: X will not show post <id>` | Age-restricted or withheld. | Set `X_BEARER_TOKEN`, or on Node use yt-dlp with browser cookies. |
| `unavailable: ... holds a GIF` | GIFs on X are silent loops. | `--mode video` with a multimodal rung describes what is on screen. |
| `upstream: X GraphQL does not know the TweetResultByRestId operation id` | X rotated the GraphQL operation id the third lane uses. | Set `X_GRAPHQL_QUERY_ID` to the current id, or unset `X_BEARER_TOKEN`. The keyless lanes are unaffected. |
| `too-large: ... no splitter for audio/mp4` | A video over 60 s on the keyless lane, on a runtime without ffmpeg. | Install ffmpeg (Node), or add `GROQ_API_KEY`. |
