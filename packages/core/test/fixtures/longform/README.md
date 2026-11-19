# Long-audio fixtures

Real audio and real responses for `packages/core/test/longform/`.

## Audio

| File | Source | License |
|---|---|---|
| `doubleday-ch00-90s.mp3` | The first 90 s of "Chancellorsville and Gettysburg, Preface" by Abner Doubleday, read by Mark Smith for LibriVox ([archive.org item](https://archive.org/details/chancellorsville_gettysburg_ms_librivox), file `chancellorsvillegettysburg_00_doubleday_64kb.mp3`). Made with ffmpeg 7.0.2: `ffmpeg -i chancellorsvillegettysburg_00_doubleday_64kb.mp3 -t 90 -map_metadata -1 -ac 1 -ar 16000 -b:a 32k doubleday-ch00-90s.mp3`. 90.1 s, 360,512 bytes, MPEG-2 Layer III, with an ID3v2 tag and an Info frame. | Public domain (CC0, LibriVox) |
| `apollo11-small-step.wav` | `tests/fixtures/media/apollo11-small-step.mp3` decoded with ffmpeg 7.0.2: `ffmpeg -i apollo11-small-step.mp3 -ac 1 -ar 16000 -c:a pcm_s16le apollo11-small-step.wav`. 16-bit mono 16 kHz PCM; ffmpeg writes a 26-byte `LIST` chunk (odd-sized body, so padded) between `fmt ` and `data`. | Public domain (NASA) |

The tests also use a 58 s input, `doubleday-ch00-58s.mp3`, cut in code from the 90 s file on whole MP3 frames (`doubleday58()` in `test/longform/helpers.ts`), so it is not stored twice.

## OVH Whisper responses

Recorded on 2026-11-14 from OVH AI Endpoints, keyless (`whisper-large-v3-turbo`, `response_format=verbose_json`), by `npx tsx packages/core/test/longform/record-ovh.ts`, except the two `part2-part` rows (2026-11-19, `record-ovh.ts loop`) and the last row (curl, same request). Each file is the response body for the upload named after it; the status is in the name when it is not 200. Bodies hold no IP, account or personal data (the 429 responses that carried request ids were not kept).

| File | Upload | Response |
|---|---|---|
| `ovh-doubleday-ch00-58s-part1.json` | Chunk 1 of 3 of the 58 s input (0 to 19.4 s) | 200, one segment: Whisper skipped the LibriVox disclaimer in this chunk |
| `ovh-doubleday-ch00-58s-part2.json` | Chunk 2 of 3 (17.4 to 38.7 s) | 200, 3 segments |
| `ovh-doubleday-ch00-58s-part3.json` | Chunk 3 of 3 (36.7 to 58.0 s) | 200, 4 segments |
| `ovh-doubleday-ch00-58s.json` | The whole 58 s input in one request (single-pass baseline) | 200, 11 segments |
| `ovh-doubleday-ch00-90s-part1.413.json` | The 90 s file as one longform chunk | 413 `Audio duration too long, max duration allowed for unauthenticated users is 60 seconds` |
| `ovh-doubleday-ch00-90s-part1-part1.json` | Piece 1 of 2 after the re-split (0 to 45.1 s) | 200 |
| `ovh-doubleday-ch00-90s-part1-part2.json` | Piece 2 of 2 (43.1 to 90.1 s) | 200 |
| `ovh-doubleday-ch00-58s-part2-part1.json` | Half 1 of chunk 2 (0 to 10.69 s of the 21.31 s chunk), split the way a looped piece is re-sent (`loopRetryTargetSec`, 2 s overlap). Recorded 2026-11-19 by `record-ovh.ts loop` | 200, 4 segments ("This reading is by Mark Smith ...", "Campaigns of the Civil War") |
| `ovh-doubleday-ch00-58s-part2-part2.json` | Half 2 of chunk 2 (8.71 to 21.31 s of the chunk). Recorded 2026-11-19 by `record-ovh.ts loop` | 200, one segment ("... commanding the I Corps at Gettysburg.") |
| `ovh-doubleday-ch00-90s.413.json` | The 90 s file in one plain request (`curl -F file=@doubleday-ch00-90s.mp3 -F model=whisper-large-v3-turbo -F response_format=verbose_json .../v1/audio/transcriptions`) | 413, same message |

The keyless tier allows about 2 requests per minute per IP and caps audio at 60 seconds; the recorder waits through the 429s.
