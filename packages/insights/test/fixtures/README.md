# packages/insights test fixtures

All recorded on 2026-11-14 from real services. Never edit them by hand; re-record instead.

## contexts/

Real `VideoContext` JSON for more parts of the Alliance Motorworks G-Wagon buyer's series (playlist `PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b`), used with the shared part-1 fixture `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`.

YouTube answered HTTP 429 to every caption request from the recording machine that day (through both the YouTube provider and yt-dlp), so these went through the pipeline's speech-to-text path instead: metadata from the YouTube provider, the video's own audio track downloaded with the managed yt-dlp (`-f bestaudio`) and re-encoded to 16 kHz mono MP3 with ffmpeg, then core `transcribe()` with local whisper.cpp (`ggml-small`, the first rung in free-first order). Script: `scripts/record-stt-context.ts`.

| File | Video | Transcript |
|---|---|---|
| `youtube-q6dzm-O1i2o.json` | "What to Look For When Buying a Used G-Wagon (Rust, Known Issues, Engine & More)" (30:34) | stt, whisper.cpp small, 898 segments |
| `youtube-ovIkN7UgbgE.json` | "G-Wagon Mechanic Reveals The Truth: Are They Ridiculously Expensive To Maintain?" (13:41) | stt, whisper.cpp small, 350 segments |
| `youtube-1Xx1fmHIsiA.json` | "Owning a 2018 Mercedes G550 For 2 Years: Costs, Fuel Economy, & More" (15:06) | stt, whisper.cpp small, 240 segments |

In the descriptions of `youtube-q6dzm-O1i2o.json` and `youtube-ovIkN7UgbgE.json`, a person's email address and phone number were replaced with `[email redacted]` and `[phone redacted]` (`scripts/redact-fixture.py`); nothing else was changed. No stream URLs or IP addresses are stored.

## llm/

Real LLM exchanges recorded LIVE on 2026-11-14 by `scripts/record-llm.ts` from the keyless chain only (no keys set: OVH AI Endpoints Llama 3.3 70B and gpt-oss-120b, then Pollinations), and replayed in order by `test/recording.ts`. Each exchange keeps its time offset, status and body verbatim (the recorder also stores 429s, free-limit 402s and timeouts when they happen), so the chain's fallbacks and cooldowns replay exactly. In `brief-single.json` and `brief-map-reduce.json`, gpt-oss-120b (first under policy `quality`) used its whole output budget on reasoning and returned empty content, and the chain fell through to Llama 3.3 70B. Scenarios are defined in `test/scenarios.ts`.

| File | Scenario |
|---|---|
| `brief-single.json` | `buildBrief` over the four videos, buyer-guide template, one pass |
| `brief-map-reduce.json` | `buildBrief` over parts 1 and 3 with a 2500-token chunk cap: one map call per chunk, then reduce |
| `extract-buyer.json` | `extract` with the buyer-guide template over the four videos; the first answer broke the template schema and one repair call fixed it |
| `extract-repair.json` | `extract` with a strict custom schema over part 1; the first answer met it, so no repair call was made |
