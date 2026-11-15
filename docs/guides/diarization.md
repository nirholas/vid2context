# Diarization and speaker naming

Podcasts, interviews, panels and meetings are hard to use without knowing who said what: "the mechanic says avoid 2013" and "the seller says avoid 2013" are different claims. vid2context keeps speakers on each transcript segment (`Segment.speaker`) and can turn anonymous labels into real names when the video itself makes them clear.

## How labels look

A diarizing speech-to-text rung labels each segment with an anonymous speaker:

```json
{ "startSec": 54, "endSec": 63.68, "text": "Hello, Neil and Buzz. I'm talking to you by telephone ...", "speaker": "Speaker 2", "confidence": 0.97 }
```

Labels are `Speaker 0`, `Speaker 1`, ... (or `Speaker A`, `Speaker B` for services that use letters). They are consistent within one transcript and mean nothing across transcripts. The JSON, Markdown, SRT and VTT formats already carry them (Markdown starts a paragraph per speaker turn, SRT prefixes `Speaker 2: `, VTT uses voice tags); plain text does not.

## What is available today

- **Hosted diarization on Cloudflare Workers AI**: `stt/cloudflare/@cf/deepgram/nova-3`, Deepgram's nova-3 model run by Cloudflare. It needs only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (a free account; see [cloudflare.md](cloudflare.md)), and labels speakers when you pass `stt: { diarize: true }`. It sends the audio to Cloudflare as raw bytes with Deepgram's flags (`diarize`, `smart_format`, `punctuate`, `utterances`, `paragraphs`, and `detect_language` or `language`) and maps Deepgram's utterances to segments with `speaker` and `confidence`. REST only: the Workers AI binding input for this model has not been verified.
- **Speaker naming** (`@vid2context/speakers`) works on any transcript that has speaker labels, whatever produced them.
- **Not included: direct Deepgram and AssemblyAI rungs.** Their APIs give sign-up credits and strong diarization, but neither `DEEPGRAM_API_KEY` nor `ASSEMBLYAI_API_KEY` was available to record real responses, and the project ships only rungs verified against real recordings. They can be added once a key exists.
- **Local diarization** (sherpa-onnx, roadmap item 23) is deferred. It needs native or WASM speaker-embedding models and a clustering step, which is a separate piece of work from hosted diarization. Until then there is no fully local or keyless way to get speaker labels.

### Routing

The nova-3 rung has the `diarization` capability and runs after the Whisper rungs, so ordinary transcription does not spend neurons on it. The pipeline does not yet add `diarization` to the chain's required capabilities when `stt.diarize` is set, so a diarized request still tries the earlier Whisper rungs first, and they return no speakers. Until that lands, require the capability yourself; the chain then skips every rung without it:

```ts
const ctx = await getVideoContext(url, { mode: 'stt', stt: { diarize: true }, chain: { needs: ['diarization'] } });
```

`chain: { only: ['stt/cloudflare/@cf/deepgram/nova-3'] }` pins the rung instead. In `getVideoContext`, `chain` applies to the speech-to-text and video stages only, so it does not restrict the LLM stages.

### Cost and limits

Workers AI's free allocation is 10,000 neurons a day (resets at 00:00 UTC). nova-3 used about 8 neurons per second of audio in the recordings (190 for a 24 s clip, 1,600 for a 202 s call), so a free account diarizes roughly 20 minutes of audio a day. When the allocation runs out the rung reports `rate-limited` until midnight UTC. `CLOUDFLARE_DIARIZE_MODEL` replaces the model list (comma-separated).

### Quality notes from the recordings

On the 1969 Nixon to Apollo 11 call (three voices over a noisy radio link) nova-3 separated Houston, Nixon and Armstrong into speakers 0, 2 and 1, but missed part of Armstrong's reply (121 to 149 s) and misheard some words. On clean modern audio expect better; on old or degraded audio, Whisper's text is often more accurate, and speaker labels are the reason to choose nova-3.

## Speaker naming

```ts
import { nameSpeakers } from '@vid2context/speakers';

const { mapping, context: named } = await nameSpeakers(context, registry, ctx);
// mapping: [{ label: 'Speaker 2', name: 'President Nixon', confidence: 0.97,
//             evidence: [{ quote: "Hello, Neil and Buzz. I'm talking to you ...", startSec: 54 }] }, ...]
```

What it does:

1. Groups segments into turns and samples, per speaker, every turn in the first five minutes plus any turn anywhere with an introduction or direct address ("I'm ...", "thanks, Doug", "go ahead, Mr. President"), within a character budget.
2. Sends the title, channel, description and those turns to the LLM chain, asking for JSON. All video-supplied text sits inside `<untrusted_metadata>` and `<untrusted_transcript>` blocks with an instruction that it is data, not instructions; delimiter tags inside the text are stripped so it cannot break out.
3. Checks the answer against the evidence rule (below) and returns a copy of the context with named labels replaced. The input is never mutated, and `mapping` keeps the original labels, so the raw diarization is never lost.

Options: `minConfidence` (default 0.7), `toleranceSec` (how far from the cited time a quote may be, default 30), `openingSec`, `maxCharsPerSpeaker`, `maxChars`, `chain` (LLM chain options) and `maxTokens`.

### The evidence rule

A name is applied only when all of these hold:

- the model gives at least one quote that appears in the transcript (case-insensitive, punctuation and whitespace normalized) within `toleranceSec` of the time it cites;
- the name itself (a word of it, ignoring honorifics) appears in the transcript, title, channel name or description;
- it is a person's name, not a diarization label or a role ("Host", "Speaker 2", "Unknown");
- the model's confidence is at least `minConfidence`;
- no other label was given the same name with higher confidence.

Otherwise the label stays `Speaker N`. In the recorded Nixon to Apollo 11 call, Speaker 2 is named because Houston hands the floor to "mister president" and the title names President Nixon; Houston's CAPCOM stays anonymous (a call sign, never a name), and Armstrong stays anonymous because the transcript only ever calls him "sir". That is the intended trade-off: a missing name is better than a wrong one.

### Cost

Diarization is opt-in (`stt.diarize`), so ordinary transcription never asks for it. Speaker naming is one LLM call per video on the free-first chain: local models, then free tiers with your key, then keyless hosts (OVH, Pollinations). Paid rungs are excluded unless you pass `chain: { allowPaid: true }`. Keyless hosts allow roughly one request a minute per IP; with a free Groq or Gemini key the call is faster and less likely to be rate-limited. Small models are more conservative and leave more labels anonymous. Reasoning models spend output tokens before answering; the default `maxTokens` is 4000, and a cut-off answer fails with an `upstream` error whose hint says to raise it.
