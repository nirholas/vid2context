# Transcript cleanup

Code: `packages/core/src/clean/`. Every function takes segments (or a transcript) and returns new values plus a `CleanReport`; nothing is changed in place, so the raw transcript stays available. Cleaned text is an added layer.

## The report

`CleanReport` counts segments `merged`, `removed`, `flagged` (confidence lowered, text kept) and `rewritten`, lists the `steps` that ran, and keeps up to 20 `examples` (`{ atSec, before, after, rule }`) so a person can audit what changed. The LLM pass adds `llm: { chunks, accepted, rejected, failed, rungs, attempts }`.

## What runs automatically

Only the repetition guard. `transcribe()` in `packages/core/src/pipeline.ts` runs `guardRepetition` on every speech-to-text result and, when it changed something, adds this to `attempts`:

```json
{ "id": "clean/repetition-guard", "stage": "stt", "outcome": "ok", "detail": "collapsed 1 segments" }
```

Everything else is opt-in for surfaces through `cleanTranscript`.

## cleanTranscript order

`cleanTranscript(transcript, opts)` is async and returns `{ transcript, report }`. It keeps `ref`, `origin` and `producer`.

1. `normalizeCaptionText`: always.
2. `dedupeRollingCaptions`: `auto-captions` only.
3. `guardRepetition`: `stt` and `video-model` only.
4. `restoreSentences`: unless `sentences: false`. Skips itself on punctuated text.
5. `removeFillers`: only with `fillers: true`.
6. `punctuateWithLlm`: only with `llm: { registry, ctx }`. The only step that can use the network.

Without `llm`, it runs fully offline.

## Functions, thresholds and why

**normalizeCaptionText(segments, { tags, quotes })** decodes HTML entities with `decodeEntities`, collapses whitespace, and with `quotes: 'straight'` turns curly quotes into straight ones. Sound tags stay by default. With `tags: 'remove'` it deletes anything in square brackets (`[Music]`), known sound words in parentheses (`(inaudible)`, `(applause)`, ...), music notes, and cues that are only a parenthetical. Other parentheses can hold real speech, so they stay. Segments left empty are dropped.

**dedupeRollingCaptions(segments, { minWords = 2 })** finds the longest run of words that ends one segment and starts the next (compared lowercased, without punctuation) and drops it from the next, so those words keep the earlier start time. A segment left empty is merged into the previous one. A single shared word stays, because in the real data ("so this | this generation") that is as likely the speaker repeating themselves.

**guardRepetition(segments, { maxRepeats = 4, maxNgram = 6, lowConfidence = 0.2 })**:

- Loops: an n-gram (1 to 6 tokens) repeated more than 4 times in a row, inside a segment or running across neighbours, is cut to two occurrences. Japanese and Chinese characters count as one token each, because those scripts have no spaces. Changed segments get confidence 0.2; empty ones are dropped.
- Dominant token: a segment of 8 or more tokens where one token is over 70 percent is flagged.
- Sign-off hallucinations ("Thanks for watching", "Subtitles by", "Please subscribe", "I'll see you next time", ...) are flagged, never deleted, and only in the last two segments when they carry little information: under one word per second, or after a pause of 2 s or more.

Why 4: the 521 real auto-caption segments of `youtube-cCPsdFdlshc` contain "it it it happens", "really really well", "yes yes" and "I I'm"; all survive. Real loops are far longer: the recorded OVH loop repeats one token 19 times.

**restoreSentences(segments, { pauseSec = 0.8 })** handles unpunctuated text. A sentence ends where a segment ends and the next one starts after a pause of 0.8 s or more or opens with a discourse marker ("so", "okay", "well", "anyway", "yeah", ...), unless the segment ends on a word that cannot close a sentence ("the", "and", "of", ...). The last segment always ends one. Sentence starts and the pronoun "I" are capitalized. No word is added, removed or reordered. Text with 2 or more punctuation marks per 100 words is left alone, and so is text with no lowercase letters (Japanese, Chinese). Limitation: the YouTube parser clamps the gaps between auto-caption cues to zero, so on that text only discourse markers end sentences, and sentences come out long (8 periods across 521 segments of `cCPsdFdlshc`). Use the LLM pass for readable punctuation.

**groupParagraphs(segments, { pauseSec = 1.5, targetWords = 120 })** returns `{ startSec, endSec, text }[]`. A new paragraph starts after a pause of 1.5 s or more, at the first sentence end after 120 words, or before a paragraph would pass 180 words.

**removeFillers(segments)** is off by default. It drops standalone "um", "uh", "erm", "er", "hmm" and their stretched spellings, never "like", "so", "well", "ah" or "uh-huh".

**punctuateWithLlm(transcript, registry, ctx, { chunkWords = 1500, overlapWords = 8, chain })** sends chunks of about 1500 words, each with the 8 words before it as context, through the core `chat` rung chain (local, then free tiers, then keyless). It asks for punctuation and capitalization only. Every answer is checked: after lowercasing and stripping punctuation, its words must equal the input's. A chunk that fails keeps its original text and counts as `rejected`. Accepted words are mapped back onto segments by word index, so timings stay exact. With no LLM rung it fails with the chain's `no-provider` error and hint. The token budget is words times 4 plus 1024, because keyless gpt-oss models spend most of their tokens on hidden reasoning.

## Real before and after

Rolling dedupe, `timedtext-cCPsdFdlshc-en-asr.srv3.xml` at 5:38 (the track's only overlap of 2 or more words):

```
before  this generation was available with the | with the m113 yep up until 20 through
after   this generation was available with the | m113 yep up until 20 through
```

Repetition guard, `ovh-whisper-loop.verbose.json`:

```
before  ギギギギギギギギギギギギギギギギギギギ   (0 to 20 s)
after   ギギ                                    (confidence 0.2)
```

Hallucination flag, `ovh-whisper-tail-hallucination.verbose.json`: "I'll see you next time." at 37 to 67 s, over static, keeps its text and gets confidence 0.2. The two real lines before it are untouched.

Sentences, `youtube-cCPsdFdlshc.json` at 0:36:

```
before  click the link in the description right | now Joe thanks for being here man all
after   click the link in the description right. | Now Joe thanks for being here man all
```

Fillers, the same transcript at 0:23: "welcome to the U uh gwh and YouTube channel" becomes "welcome to the U gwh and YouTube channel".

LLM pass, recorded `gpt-oss-120b` answer for the first 117 words, accepted: "So you're going to buy G wagon, which year is best for you? Well, in this video we're going to do a year-by-year breakdown of the legendary w463 platform, ..." The recorded Llama 3.3 answer for the same words wrote "buy a G wagon", adding a word, so it was rejected and the original kept.

Creator captions (`youtube-jNQXAC9IVRw.json`) come back unchanged from `cleanTranscript`.

## Token effect on the real 18-minute transcript

`estimateTokens` on `youtube-cCPsdFdlshc` (3895 words, 521 segments):

| Steps | Tokens |
|---|---|
| raw | 4483 |
| default (normalize, dedupe, sentences) | 4489 |
| default plus `fillers: true` | 4466 |

That track has almost no rolling overlap left after the srv3 parser, which already skips the append cues. The added periods cost a few tokens, and filler removal saves more than that.
