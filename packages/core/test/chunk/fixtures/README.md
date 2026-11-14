# Chunking and token fixtures

Real subtitle tracks used to measure `estimateTokens` against real tokenizers in scripts other than English. Downloaded on 2026-11-14 from Wikimedia Commons with `https://commons.wikimedia.org/w/index.php?action=raw&title=TimedText:<name>`, unchanged. YouTube caption requests from the recording machine were blocked (HTTP 429), so Commons was used instead.

The videos are public domain (NASA, and a US presidential radio address). Commons TimedText pages (the subtitle text) are user contributions under CC BY-SA 4.0; see the page history on Commons for authors.

| File | Commons page | Language |
| --- | --- | --- |
| `commons-ap11-final-approach.<lang>.srt` | `TimedText:AP11 FINAL APPROACH.ogv.<lang>.srt` (Apollo 11 landing, NASA, public domain) | en, es, fa, fr, hi, it, ja, pt, ru, zh-hans, zh-hant |
| `commons-reagan-radio-address-trade.ko.srt` | `TimedText:President Ronald Reagan's Radio Address to the Nation on Free and Fair Trade from Camp David, Maryland.webm.ko.srt` (public domain) | ko |

`../token-accuracy.json` is the output of `npx tsx packages/core/test/chunk/measure-tokens.ts`, run on 2026-11-14.
