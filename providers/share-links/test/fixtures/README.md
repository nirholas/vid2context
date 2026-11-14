# share-links fixtures

Real responses recorded from this repo's VM on 2026-11-14 with Node's `fetch` (redirects followed, as `ctx.fetch` does). Each file holds the request (method and URL), the host the request ended on, the status, the headers the provider reads (`content-type`, `content-length`, `content-range`, `content-disposition`) and the body. Tests replay them through `replayFetch` (`@vid2context/core/testing`), so unit tests never touch the network.

No media bytes are stored: every file request asked for one byte (`Range: bytes=0-0`) and the body is left empty.

| File | Request and source | License of the shared file |
|---|---|---|
| `dropbox-tapestry.json` | `GET https://www.dropbox.com/s/qte66a7haqspq2g/tapestry.wav?dl=1`: a 3 s speech sample ("A huge tapestry hung in her hallway") linked from kastnerkyle/tools and arielephrat/vid2speech. Byte-identical (git blob `2e41165f`) to `test_data/tapestry.wav` in google/speedy. | Apache-2.0 (google/speedy, MalcolmSlaney/python_auditory_toolbox) |
| `dropbox-invalid-link.json` | A Dropbox `/scl/fi/` link with an id that does not exist: page titled "Invalid Link" | no file |
| `dropbox-disabled.json` | `https://www.dropbox.com/s/7eznyazmc1pmw9h/case_closed.wav?dl=1` (linked from YuanGongND/whisper-at): page titled "Link Temporarily Disabled" | no file served |
| `dropbox-no-rlkey.json` | A real `/scl/fi/` link sent without its `rlkey`: page titled "Log in to Dropbox" | no file served |
| `gdrive-voice.json` | `drive.usercontent.google.com/download?id=1ucJCfKfKr00_09H8_FmW57xFYHYPzC2h&export=download`: `voice.mp3`, published by IIT Madras Speech Lab (Speech-Lab-IITM/docs, `docs/api_docs/asr.md`) as an English sample for testing speech recognition | no license stated; only headers are stored |
| `gdrive-bbb-interstitial.json` | Same endpoint for `0ByeS4oOUV-49Zzh4R1J6R09zazQ` (yt-dlp's Google Drive test file): the full "Virus scan warning" page with its `#download-form` | Big Buck Bunny, Blender Foundation, CC BY 3.0 |
| `gdrive-bbb-confirmed.json` | The form's GET target (`&confirm=t&uuid=...`): the 185,972,864-byte file | CC BY 3.0 |
| `gdrive-not-found.json` | Same endpoint for `1IP0o8dHcQrIHGgVyp0Ofvx2cGfLzyO1x` (a yt-dlp test file that is gone): the full HTTP 404 page | no file |
| `onedrive-badger-token.json` | `POST https://api-badgerp.svc.ms/v1.0/token` with the OneDrive web app id | not a file |
| `onedrive-driveitem-video.json` | `GET my.microsoftpersonalcontent.com/_api/v2.0/shares/u!.../driveitem` for `https://1drv.ms/v/c/7be8ecfc440137f7/IQAJInfVpuT2ToNqGbJ8iY87AY8SUyORWpN20ws6qYMlI5I` (a demo clip linked from the aurateam2026/AURA README) | no license stated; only metadata is stored |
| `onedrive-driveitem-checkpoint.json` | Same call for `https://1drv.ms/u/s!AqeByhGUtINrgcsFdbjgcEuDhwN3vg?e=EF3usb`, the SpeechLM checkpoint linked from microsoft/unilm | MIT (microsoft/unilm) |
| `onedrive-link-gone.json` | Same call for a 1drv.ms `s!` link that does not exist: HTTP 403 `accessDenied` | no file |
| `onedrive-not-found.json` | Same call for a 1drv.ms `c/` link that does not exist: HTTP 404 `itemNotFound` | no file |
| `onedrive-download-video.json` | The video item's `@content.downloadUrl` with a one-byte range | as the video item |
| `sharepoint-download.json` | `greaternyace.sharepoint.com/sites/acementornydrive/_layouts/15/download.aspx?share=ETski5...` for the yt-dlp SharePoint test link: a 351,866,951-byte mp4 | no license stated; only headers are stored |
| `sharepoint-error-page.json` | `izoobasisschool.sharepoint.com/_layouts/15/download.aspx?share=Eaqleq8...` (another yt-dlp test link, no longer shared): an HTML page titled "Fout" (Dutch for "Error") | no file |

Trimming, so nothing personal or secret lands in this public repo:

- HTML bodies are cut down to their `<title>` element, except the two short Google pages (`gdrive-bbb-interstitial.json`, `gdrive-not-found.json`), which are kept whole because the provider parses them.
- OneDrive item JSON drops `createdBy`, `lastModifiedBy`, `shared` (owner names and email addresses), `parentReference`, `webUrl`, tags, hashes and `media`. The `tempauth=` value in download URLs is replaced with `[removed]`, and the anonymous badger token with `[anonymous token removed]`.
- Final redirect URLs are not stored (Dropbox's signed `dl.dropboxusercontent.com` paths), only their host.
- None of these responses embed the requesting IP address; the files were grepped for it.

To re-record, repeat the same requests with `Range: bytes=0-0`, apply the same trimming, and grep the result for your public IP and for email addresses before committing.
