# providers/media-file test fixtures

Real stream manifests and subtitles recorded with curl on 2026-11-14, unchanged. They contain no personal data (no signed URLs or tokens). The local-file tests use the media in `tests/fixtures/media/` and `packages/ffmpeg/test/fixtures/` (see the READMEs there).

| File | Recorded from | Notes |
|---|---|---|
| `bipbop_16x9_variant.m3u8` | `https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8` | Apple's public HLS example: multivariant playlist with 6 variants, 2 audio and 8 subtitle renditions |
| `bipbop_16x9_gear0_prog_index.m3u8` | `https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/gear0/prog_index.m3u8` | the audio-only variant's media playlist (180 segments, VOD, byte ranges) |
| `bipbop_eng_fileSequence0.webvtt` | `https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/subtitles/eng/fileSequence0.webvtt` | a real WebVTT segment with `X-TIMESTAMP-MAP`, `<i>`/`<b>`/`<u>` tags and `align:` cue settings |
| `bbb_30fps.mpd` | `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` | Akamai's public DASH test manifest for Big Buck Bunny (the film is CC BY 3.0, Blender Foundation); static, 634.566 s, one video and one audio adaptation set |
