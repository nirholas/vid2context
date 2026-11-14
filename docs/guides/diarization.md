# Diarization and speaker naming

Podcasts, interviews, panels and meetings are hard to use without knowing who said what: "the mechanic says avoid 2013" and "the seller says avoid 2013" are different claims. vid2context keeps speakers on each transcript segment (`Segment.speaker`) and can turn anonymous labels into real names when the video itself makes them clear.

## How labels look

A diarizing speech-to-text rung labels each segment with an anonymous speaker:

```json
{ "startSec": 54, "endSec": 63.68, "text": "Hello, Neil and Buzz. I'm talking to you by telephone ...", "speaker": "Speaker 2", "confidence": 0.97 }
```

Labels are `Speaker 0`, `Speaker 1`, ... (or `Speaker A`, `Speaker B` for services that use letters). They are consistent within one transcript and mean nothing across transcripts. The JSON, Markdown, SRT and VTT formats already carry them (Markdown starts a paragraph per speaker turn, SRT prefixes `Speaker 2: `, VTT uses voice tags); plain text does not.

## What is available today

- **Speaker naming** (`@vid2context/speakers`) works on any transcript that has speaker labels, whatever produced them.
- **No installed speech-to-text rung produces speaker labels yet.** `stt.diarize` is passed to rungs, but the current ones (OpenAI-compatible Whisper hosts, Transformers.js) ignore it. Hosted diarization through Deepgram and AssemblyAI was planned for this item but is not included: neither key was available, and the project ships only rungs verified against real recorded responses. Adding those rungs, and making the pipeline route `diarize: true` only to rungs with the `diarization` capability, needs a `DEEPGRAM_API_KEY` or `ASSEMBLYAI_API_KEY` to record fixtures.
- **Local diarization** (sherpa-onnx, roadmap item 23) is deferred. It needs native or WASM speaker-embedding models and a clustering step, which is a separate piece of work from hosted diarization. Until then there is no fully local or keyless way to get speaker labels.

The speaker-naming fixtures were recorded from Deepgram nova-3 running on Cloudflare Workers AI (`@cf/deepgram/nova-3` with `diarize=true`), which shows the label format a hosted diarizer returns.

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

Diarization is opt-in (`stt.diarize`), so ordinary transcription never asks for it. Speaker naming is one LLM call per video on the free-first chain: local models, then free tiers with your key, then keyless hosts (OVH, Pollinations). Paid rungs are excluded unless you pass `chain: { allowPaid: true }`. Keyless hosts allow roughly one request a minute per IP; with a free Groq or Gemini key the call is faster and less likely to be rate-limited. Small models are more conservative and leave more labels anonymous.
