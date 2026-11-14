# Dedupe fixtures

Real `VideoContext` JSON recorded with the vid2context CLI on 2026-11-14:

```sh
npm run cli -- "https://www.youtube.com/watch?v=<id>" --format json --mode captions > youtube-<id>.json
```

Nothing was edited. The files hold public video metadata (title, channel, description, view count) and the captions YouTube served; none contains a stream URL, email address or phone number.

The shared fixtures in `tests/fixtures/contexts/` are used too: `youtube-jNQXAC9IVRw.json` ("Me at the zoo", the original) and `youtube-cCPsdFdlshc.json` (an 18-minute G-Wagon buyer's guide, a distinct-video negative).

## Reuploads of "Me at the zoo"

| File | Video | Transcript |
| --- | --- | --- |
| `youtube-g5RBHWskGtc.json` | [Me at the zoo (reupload)](https://www.youtube.com/watch?v=g5RBHWskGtc), RetroYTVideos, 19 s | auto-captions, 8 segments; close to the original's creator captions |
| `youtube-9Pd5fi1DCb8.json` | [Me At The Zoo (REUPLOAD)](https://www.youtube.com/watch?v=9Pd5fi1DCb8), 20 s | auto-captions, 8 segments; the recognizer heard "one of the elephants" for "in front of the elephants" and "fronts" for "trunks", and added `[Music]` and "um" |

The original (`jNQXAC9IVRw`) has creator captions. The three transcripts of the same 19 seconds of audio differ word by word, which is what the gap tolerance in `src/align.ts` is measured against.

## A full episode and three clips of it

Recorded on 2026-11-14 with the local whisper.cpp rung, because YouTube answered HTTP 429 to caption requests from this machine at the time:

```sh
WHISPER_CPP_MODEL=small npm run cli -- "https://www.youtube.com/watch?v=<id>" --format json --mode stt > youtube-<id>.json
```

Each video was transcribed in its own run, so the clip transcripts are not cut from the episode transcript: Whisper segments and words them differently ("in your eyes" vs "and your eyes", "tangential like pause" vs "tangential pause"). Every Lex Clips description links the full episode.

| File | Video | Length |
| --- | --- | --- |
| `youtube-U_6AYX42gkU.json` | [Grant Sanderson: Math, Manim, Neural Networks & Teaching with 3Blue1Brown, Lex Fridman Podcast #118](https://www.youtube.com/watch?v=U_6AYX42gkU), Lex Fridman, 2020-08-23 | 2:08:25 |
| `youtube-YrGuJ4Pkkuo.json` | [Richard Feynman is misunderstood](https://www.youtube.com/watch?v=YrGuJ4Pkkuo), Lex Clips, 2020-08-25 | 4:49 |
| `youtube-Ge0ggAtmL54.json` | [Topology is amazing and useful](https://www.youtube.com/watch?v=Ge0ggAtmL54), Lex Clips, 2020-08-26 | 5:16 |
| `youtube-J_n3wupU2dg.json` | [The Snuggle is Real](https://www.youtube.com/watch?v=J_n3wupU2dg), Lex Clips, 2020-08-27 | 0:36 (15 s of speech, then silence) |

True offsets, found by matching clip sentences to episode sentences by hand (clip time, then episode time):

- Feynman: "You've spoken about Richard Feynman as someone you admire" 0.00 / 313.76; "I think last time we spoke" 5.90 / 317.08; "Who is Richard Feynman to you" 12.98 / 324.76; "What impact did he have on you?" 15.50 / 327.28. The later lines agree on 311.2 to 311.8 s; the first line differs because Whisper started the clip's first segment at 0. True offset about 311.8 s (5:12).
- Topology: "A few videos I've seen you do" 0.00 / 1123.12. The clip ends with "shy away from being a little too technical", episode 1413.80 to 1416.88. True offset 1123.1 s (18:43).
- Snuggle: "It's the only one I have" 6.68 / 1423.00; "By the way, for anyone watching" 11.20 / 1427.36; "The snuggle is real." 14.12 / 1430.20. True offset 1416.1 to 1416.3 s (23:36). It starts one line after the topology clip ends, so the two clips share no speech.

The episode is the longest fixture (295 KB); `test/performance.test.ts` repeats it to measure scale. None of the four files contains a stream URL, email address or phone number; descriptions are the channels' public text.
