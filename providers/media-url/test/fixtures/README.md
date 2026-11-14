# providers/media-url test fixtures

Recorded from Wikimedia's upload servers on 2026-11-14 with curl. Response headers are trimmed to the ones the provider reads (`content-type`, `content-length`, `content-range`, `last-modified`, `etag`, `accept-ranges`, `date`, `age`, CORS headers). Removed: `x-client-ip` (the recording machine's IP), `set-cookie`, `x-request-id`, cache-node and rate-limit headers.

| File | Request | Source and license |
|---|---|---|
| `discovery.head.json` | `HEAD https://upload.wikimedia.org/wikipedia/commons/5/5a/Discovery_-_Nice_to_be_in_orbit.mp3` | [File:Discovery - Nice to be in orbit.mp3](https://commons.wikimedia.org/wiki/File:Discovery_-_Nice_to_be_in_orbit.mp3), NASA air-to-ground audio, public domain |
| `discovery.range.json` | `GET` of the same URL with `Range: bytes=0-0` (206 with `content-range: bytes 0-0/135296`) | same file |
| `discovery-nice-to-be-in-orbit.mp3` | `GET` of the same URL: the complete body, 135,296 bytes, 5.6 s | same file, public domain |
| `crew13.head.json` | `HEAD` of [File:NASA's SpaceX Crew-13 Live Launch Coverage - Program & LOS (...).mp3](https://commons.wikimedia.org/wiki/File:NASA%27s_SpaceX_Crew-13_Live_Launch_Coverage_-_Program_%26_LOS_(KSC-20261001-AU-LMM01-0001-SpaceX_Crew_13_Live_Launch_Coverage_Program_LOS-M26153).mp3): a real `content-length` of 206,115,140 bytes for the size-cap tests. The body was not downloaded. | NASA, public domain |
