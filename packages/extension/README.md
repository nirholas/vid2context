# vid2context browser extension

vid2context one click away while you browse. On a YouTube watch page it adds three buttons under the title:

- **Copy for AI**: the transcript as a paste-ready agent prompt (citation instructions, metadata, chapters and a timestamped transcript within a token budget), or any other vid2context format.
- **Download .zip**: the full bundle (`context.md`, transcripts as text, Markdown, SRT and VTT, `context.json`, metadata, chapters, README and manifest).
- **Open in vid2context**: opens the web app at `<app base>/app/?url=<video>`, which can also transcribe videos without captions.

On YouTube all of this runs inside the page: the extension reads the player data the page already holds, downloads the caption track from youtube.com, and formats it with `@vid2context/core`. No server is involved and nothing leaves the browser.

Everywhere else, right-click a link, a page or a video:

- **Get context with vid2context** opens the web app with that URL.
- **Copy transcript (via API)** calls `GET <api base>/transcript?url=` on your vid2context server and copies the result, or shows the server's error and hint.

On the vid2context web app, the extension can fetch a YouTube transcript for the app from your own browser when the server cannot (see [Web app bridge](#web-app-bridge-get-it-from-my-browser)).

Manifest V3 for Chrome and Edge, with an equivalent Firefox build.

## Build

```sh
npm install                              # at the repo root
npm run build -w packages/extension      # writes dist/chrome and dist/firefox
```

The build runs Vite for the popup and options pages (React 19, Tailwind v4) and bundles the background, the YouTube content script, the page script and the web app bridge script (`bridge.js`) as self-contained files. Icons are drawn from the project logo at build time.

## Load it unpacked

- **Chrome**: open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `packages/extension/dist/chrome`.
- **Edge**: open `edge://extensions`, turn on Developer mode, click "Load unpacked" and pick `packages/extension/dist/chrome`.
- **Firefox** (140 or newer): open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on" and pick `packages/extension/dist/firefox/manifest.json`. Or run `npx web-ext run --source-dir packages/extension/dist/firefox`.

After loading, reload any YouTube tab that was already open (or open the popup there, which injects the scripts).

## Options

Open them from the popup's gear icon or the browser's extension menu. Stored in `storage.sync`.

| Option | Default | What it does |
|---|---|---|
| App base | `https://vid2context.com` | Where "Open in vid2context" and "Get context" send you |
| API base | `http://localhost:8787/api/v1` | The server "Copy transcript (via API)" calls. Start one with `npm run dev:server` |
| Default copy format | `agent` | `agent` for the agent prompt, or any formatter core ships (`text`, `markdown`, `pack`, `srt`, `vtt`, `json`); the list is read from core at build time |
| Copy template | `{{content}}` | Wraps the copied text. Placeholders: `{{content}}` (required), `{{title}}`, `{{url}}`, `{{channel}}` |
| Include timestamps | on | For the `text` format. The agent prompt and Markdown always cite with timestamps |

The last five items you copied, downloaded or opened are kept in `storage.local` and shown in the popup.

The **Web app connection** section lists where the bridge runs and lets you add your own web app, for a self-hosted vid2context (see below). Added origins are kept in `storage.local`, because the permission for them belongs to this browser.

## Permissions and why

| Permission | Why |
|---|---|
| `activeTab` | Read the current tab's URL in the popup, and show a result in the tab after a context-menu action |
| `contextMenus` | The two right-click items |
| `storage` | Options (`storage.sync`) and the last five items (`storage.local`) |
| `scripting` | Show the context-menu result in the page, add the YouTube scripts to tabs opened before the extension was installed, and register the bridge on web app origins you add |
| `declarativeNetRequestWithHostAccess` | One session rule that sets `Origin: https://www.youtube.com` on the background's own requests to www.youtube.com, for the web app bridge. innertube answers HTTP 403 to an extension Origin. No install warning; it can only act on hosts the extension already has |
| `https://www.youtube.com/*`, `https://m.youtube.com/*` | Run on watch pages and fetch caption tracks from youtube.com |
| Content script on `https://vid2context.com/*`, `https://*.vid2context.com/*`, `http://localhost/*`, `http://127.0.0.1/*` | The web app bridge (`bridge.js`). It only relays transcript requests; it reads nothing on those pages |
| Optional: `https://*/*`, `http://*/*` | Requested only for one host at a time: your API base's host, the first time you use "Copy transcript (via API)" (or press "Allow API access" in the options), and any web app origin you add for the bridge. Because the extension holds that permission, the API needs no CORS setup for it |

No remote code, no `eval`, no analytics and no third-party requests. The page CSP is `script-src 'self'; object-src 'self'`.

## How YouTube captions are fetched

1. A small script in the page's own JavaScript world (`src/page/index.ts`, manifest `world: "MAIN"`) reads the current player response, so it is right after YouTube's single-page navigation too. If that fails, the content script reads `ytInitialPlayerResponse` from the page, then refetches the watch page from youtube.com.
2. The track is picked with `chooseTrack` from `@vid2context/provider-youtube` (creator captions in the spoken language first, then the default track, then auto-captions).
3. The track is downloaded as srv3 and parsed with the provider's `parseTimedText`. Watch-page track URLs now often need the proof-of-origin token the web player attaches to its own caption requests; when the plain URL comes back empty, the page script borrows that token from the player's caption request (switching captions on for a moment if the player has not made one, then restoring them) and the download is retried with it.
4. Metadata comes from `videoDetails` and `microformat`, chapters from the provider's description parser, and the result is a `VideoContext` like every other vid2context surface produces.

## Web app bridge ("Get it from my browser")

YouTube refuses caption downloads from many cloud servers (HTTP 429, or "Sign in to confirm you're not a bot"), so a hosted vid2context server often cannot read a video's captions. When that happens the web app can ask this extension instead: it runs on your own internet connection, which YouTube usually serves. The web app then imports the transcript with `POST /api/v1/imports`. The full protocol is in [docs/contracts/transcript-import.md](../../docs/contracts/transcript-import.md).

Where it runs: `bridge.js` is a content script on `https://vid2context.com`, any `https://*.vid2context.com` subdomain, and `http://localhost` and `http://127.0.0.1` on any port (for development and local servers). To use it with a self-hosted web app, add its address under **Web app connection** in the options: the browser asks for permission for that one host, and the bridge is registered there with `scripting.registerContentScripts` (it survives restarts and is checked again on every browser start; removing the origin unregisters it and drops the permission unless the API base still needs it). Reload the app's open tabs afterwards.

What the page can do: send `ping` (answered with `pong`, the extension version and `capabilities: ['youtube-transcript']`; one `pong` is also posted when the script loads), and send `youtube-transcript` with an 11 character `videoId` and an optional BCP 47 `language`. The extension answers with zero or more `progress` messages and exactly one `youtube-transcript:result`. Messages from other frames or origins, our own messages and unknown shapes are ignored; a bad video id or language is answered with a `bad-request` result.

How the transcript is fetched, in order:

1. **From the background**, with the YouTube provider's own code (`fetchPlayer`, `chooseTrack` rules, `fetchTrack`): the innertube player call (ANDROID, then IOS client) and the caption download, from your IP address. Caption downloads carry your YouTube cookies like the player's own; the innertube app clients get none, since they do not use web session cookies. A session rule restores `Origin: https://www.youtube.com` on these requests: in a browser, fetch replaces that header with the extension's own origin, and innertube refuses `chrome-extension://` and `moz-extension://` with HTTP 403. This step has 30 seconds.
2. **From a YouTube tab** if step 1 is refused, blocked, comes back empty (YouTube wants a proof-of-origin token) or hits a sign-in, age or members-only wall your own session may pass: the watch page opens in a background tab (not focused, muted), the YouTube content script reads the captions exactly as "Copy for AI" does, including the player's proof-of-origin token, and the tab closes as soon as the answer arrives, on failure, after 45 seconds, or when the web page stops waiting. One tab at a time.

Answers that step 2 cannot improve end at step 1: a removed video (`not-found`), a live stream or premiere that has not ended (`unavailable`), a playable video without captions or without a track in the requested language (`no-captions`). Other failures map to `blocked`, `timeout` or `unavailable`, each with a hint for the person at the browser.

Known limits: where YouTube first shows a cookie consent page (consent.youtube.com, common in the EU for signed-out visitors), the tab cannot read captions until consent is given once in a normal tab; it times out instead. Step 1 needs Chrome 116 or newer (core's `fetchWithTimeout` uses `AbortSignal.any`); older versions go straight to step 2.

## Tests

```sh
npx vitest run packages/extension          # unit tests on recorded pages and responses, no network
npm run e2e -w packages/extension          # Playwright, live: loads dist/chrome in Chromium
```

The Playwright runs need a build first. `e2e/bridge.spec.ts` serves a page on `http://localhost` and talks to `bridge.js` like the web app: pong on load and on ping (within the web app's 800 ms), messages from a frame on another origin ignored, `bad-request` for a bad id, a transcript through step 1 with the recorded caption track served for the caption request (the innertube call is real), and a fully live request that must end in exactly one result with the YouTube tab closed. `e2e/copy.spec.ts` opens the real watch page for "Me at the zoo", checks the buttons appear once, clicks "Copy for AI" and reads the clipboard. It also runs the same flow with the recorded caption track served for the caption request, which checks the in-browser path on networks YouTube refuses captions to (datacenter IPs often get HTTP 429). `V2C_SCREENSHOTS=<dir>` saves screenshots of the buttons, popup and options page.

`npm run lint:firefox -w packages/extension` runs `web-ext lint` on the Firefox build. web-ext is fetched by `npx` at a pinned version instead of being a dependency, because its linter pulls in deepmerge, which has an unpatched advisory (GHSA-gcqx-w48m-w2h4) and would otherwise sit in every install.

## Store listing checklist

- [ ] Version bumped in `package.json` (the manifests read it).
- [ ] `npm run build -w packages/extension`, then zip the contents of `dist/chrome` (Chrome Web Store, Edge Add-ons) and `dist/firefox` (addons.mozilla.org).
- [ ] `web-ext lint` on `dist/firefox`: no errors (the two `innerHTML` warnings come from react-dom).
- [ ] Screenshots at 1280x800: the buttons under a YouTube title, the "Copied" status, the popup on a YouTube tab, the options page, the context menu on a link.
- [ ] Icon 128x128 (`dist/chrome/icons/128.png`) and a small promo tile 440x280.
- [ ] Privacy statement: "On YouTube pages, vid2context reads captions from the page and youtube.com and formats them in your browser. No data leaves the browser. 'Copy transcript (via API)' sends the URL you chose only to the API base you configured. On the vid2context web app (and web app addresses you add), the extension fetches a YouTube video's captions from youtube.com when the app asks and hands them to that page only. The extension collects no analytics and makes no third-party requests." Firefox: `data_collection_permissions` is `none`.
- [ ] Permission justifications from the table above (the Chrome Web Store asks for each one, and for `scripting` and host permissions separately).
- [ ] Single purpose (Chrome): "Turn the video in the current tab into context for AI agents."
- [ ] AMO: upload the source or point at this repository, with the build command, since the bundles are minified.
