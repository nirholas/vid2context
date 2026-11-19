# Cleanup fixtures

Real responses from OVH AI Endpoints (keyless, no key sent), recorded from this repo's VM on 2026-11-14. Tests replay them through `replayFetch`. The response bodies hold no URLs, IPs or personal details.

## Speech-to-text (`POST /v1/audio/transcriptions`, `model=whisper-large-v3-turbo`, `response_format=verbose_json`)

The audio was cut from `tests/fixtures/media/apollo11-small-step.mp3` (public domain) with ffmpeg. The cut audio is not committed; the commands are below so it can be rebuilt.

| File | Audio sent | Response |
|---|---|---|
| `ovh-whisper-loop.verbose.json` | a 0.5 s snippet from 9.0 s, looped 40 times (20 s): `ffmpeg -i apollo11-small-step.mp3 -ss 9.0 -t 0.5 -ac 1 -ar 16000 snip.wav` then `ffmpeg -stream_loop 39 -i snip.wav -ac 1 -b:a 48k rep40.mp3` | One segment 0 to 20 s whose text is the katakana "ギ" 19 times (compression ratio 4.07): a real decoder loop |
| `ovh-apollo11-small-step-part1.verbose.json` | the full clip (24.192 s) split by `mp3FramesSplitter` the way a looped answer is re-sent: `loopRetryTargetSec(24.192, 2)`, 2 s overlap. Part 1 is 0 to 12.13 s. Recorded 2026-11-19 | "I'm going to step off the lam now." (Whisper's own mishearing of "limb", kept as recorded) |
| `ovh-apollo11-small-step-part2.verbose.json` | part 2 of the same split, 10.15 to 24.19 s. Recorded 2026-11-19 | "That's one small step for man, one giant leap for mankind." |
| `ovh-whisper-tail-hallucination.verbose.json` | the full clip followed by 30 s of its own opening static (the first 0.6 s looped) | The two real lines, then "I'll see you next time." at 37 to 67 s, invented over static |

Seven attempts were made to get an English word loop of the "really, really, really" kind (slowed speech, repeated snippets, a repetitive `prompt`). None produced one, so the loop fixture is the katakana run above.

## LLM punctuation (`POST /v1/chat/completions`)

Both requests sent the first 16 segments (117 words) of the real auto-captions in `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`, with `PUNCTUATION_SYSTEM_PROMPT` from `src/clean/llm.ts` as the system message and `temperature: 0`, as `punctuateWithLlm` builds them. The gpt-oss request used `max_tokens: 1492` (the current budget, words times 4 plus 1024); the Llama request was made first with an earlier, smaller budget of 607, which it did not reach (149 completion tokens).

| File | Model | Result |
|---|---|---|
| `ovh-gpt-oss-120b.punctuate.json` | `gpt-oss-120b` | Only punctuation and capitals changed: passes word verification. 1166 of its 1311 completion tokens went to reasoning. |
| `ovh-llama-3.3-70b.punctuate-added-word.json` | `Meta-Llama-3_3-70B-Instruct` | Inserted a word ("buy a G wagon" for "buy G wagon"): fails verification, so the chunk keeps its original text |
