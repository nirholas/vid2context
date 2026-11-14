# @vid2context/provider-share-links

Recordings shared as Google Drive, Dropbox, OneDrive or SharePoint links (lectures, meeting recordings, interviews) as a vid2context source. It reads the file's name, size and type, then hands speech-to-text a direct download URL. No key, plain `fetch`, runs on Node and Cloudflare Workers.

```sh
vid2context "https://www.dropbox.com/s/qte66a7haqspq2g/tapestry.wav?dl=0"
vid2context "https://drive.google.com/file/d/<id>/view?usp=sharing"
vid2context "https://1drv.ms/u/s!..."
```

## Links it understands

| Service | Platform slug | Forms | Ref id |
|---|---|---|---|
| Google Drive | `gdrive` | `drive.google.com/file/d/<id>/...`, `open?id=`, `uc?id=`, `/u/0/uc?id=`, `drive.usercontent.google.com/download?id=`; `resourcekey=` is kept | `gdrive:<file id>` |
| Dropbox | `dropbox` | `dropbox.com/s/<id>/<name>`, `/scl/fi/<id>/<name>?rlkey=...`, `/e/scl/fi/...` | `dropbox:<share id>` |
| OneDrive (personal) | `onedrive` | `1drv.ms/<t>/...`, `onedrive.live.com` redirects (the `redeem=` value is unwrapped), embed links with `resid` and `authkey` | `onedrive:<share token>` |
| SharePoint / OneDrive for work | `onedrive` | `<tenant>.sharepoint.com/:v:/` (or `:u:`) with `/g/<token>`, `/g/personal/<user>/<token>`, `/p/<user>/<token>`, `/s/<site>/<token>`, `/t/<team>/<token>` | `onedrive:<share token>` |

Folder links (Drive folders, Dropbox `/sh/` and `/scl/fo/`, OneDrive `/f/`) and SharePoint `/r/` path links are not matched; the yt-dlp provider (item 11) may handle some of them.

## How each service is read

- **Google Drive**: a one-byte ranged GET of `drive.usercontent.google.com/download?id=<id>&export=download`. Files too large for Google's virus scan answer with a "Download anyway" page; its `#download-form` is submitted as a GET (with its `confirm` and `uuid` inputs) and that URL becomes the download URL. Flow from yt-dlp's `GoogleDriveIE`.
- **Dropbox**: the share link with `dl=1` redirects to the file. Dropbox labels every file `application/binary`, so the type comes from the file extension. Deleted, disabled, private and `rlkey`-less links end on an HTML page whose title is mapped to an error.
- **OneDrive (personal)**: the anonymous `api.onedrive.com` shares endpoint now answers 401 because personal accounts moved to SharePoint storage. Like the OneDrive web viewer, the provider gets an anonymous token from `api-badgerp.svc.ms` and reads `my.microsoftpersonalcontent.com/_api/v2.0/shares/u!<base64url(link)>/driveitem` with `Prefer: autoredeem`. The item gives name, size, type, duration (videos and audio) and a pre-authenticated download URL valid for about an hour.
- **SharePoint**: anonymous sharing links download from `<site>/_layouts/15/download.aspx?share=<token>` without a cookie.

All requests go through `ctx.fetch`. getMetadata and getAudio share one resolution per `Ctx`, so a pipeline run costs one or two small requests before the download.

## Metadata

`title` is the filename without its extension. `durationSec` is set for OneDrive videos and audio. `extra` holds `service`, `filename`, `sizeBytes`, `mimeType` and, for OneDrive, `createdAt`, `modifiedAt`, `width` and `height`. `chapters` is always empty.

## Audio and size limits

`getAudio` returns `{ kind: 'url', url, mimeType }`; speech-to-text rungs download the file themselves. Video files are passed as they are (the OpenAI-compatible endpoints accept mp4 and webm).

| Env var | Default | Effect |
|---|---|---|
| `SHARE_LINKS_MAX_MB` | `25` | Largest file handed to speech-to-text. Larger files fail with `too-large`. 25 MB is what Groq's free tier and OpenAI accept per upload; the keyless OVH lane accepts 10 MB, so 10 to 25 MB files need a key (or a local rung). |

Long-audio splitting (roadmap item 04) works on audio bytes, not remote URLs, so larger recordings cannot be split yet. Until that lands, share an audio-only export, download the file and pass the local path, or raise `SHARE_LINKS_MAX_MB` when your rung accepts more.

## Errors

| Situation | Code | Hint |
|---|---|---|
| Deleted file or link, unknown id | `not-found` | check the link |
| Private link, sign-in page, disabled link, quota page, members-only SharePoint link | `unavailable` | make the link viewable by anyone with the link (per service steps) |
| Dropbox `/scl/fi/` link without `rlkey` | `unavailable` | paste the whole link including `rlkey=` |
| File is not audio or video | `unsupported-input` | share the recording itself |
| File larger than `SHARE_LINKS_MAX_MB` | `too-large` | names item 04 and the env var |

## Runtimes

`node` and `workers`. Browsers cannot read these cross-origin responses, so there is no browser build.

## Not covered

Zoom cloud recordings (passcode-protected), password-protected Dropbox links, Box, iCloud and other hosts, and folder listings.

## Tests

`npx vitest run providers/share-links` replays real responses (see `test/fixtures/README.md`). `LIVE=1` adds live checks: a public Dropbox speech sample transcribed end to end through the keyless OVH rung, and metadata from real Drive, Drive virus-scan, OneDrive and SharePoint links.
