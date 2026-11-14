# vid2context browser extension

vid2context one click away while you browse. On a YouTube watch page it adds three buttons under the title:

- **Copy for AI**: the transcript as a paste-ready agent prompt (citation instructions, metadata, chapters and a timestamped transcript within a token budget), or any other vid2context format.
- **Download .zip**: the full bundle (`context.md`, transcripts as text, Markdown, SRT and VTT, `context.json`, metadata, chapters, README and manifest).
- **Open in vid2context**: opens the web app at `<app base>/app/?url=<video>`, which can also transcribe videos without captions.

On YouTube all of this runs inside the page: the extension reads the player data the page already holds, downloads the caption track from youtube.com, and formats it with `@vid2context/core`. No server is involved and nothing leaves the browser.

Everywhere else, right-click a link, a page or a video:

- **Get context with vid2context** opens the web app with that URL.
- **Copy transcript (via API)** calls `GET <api base>/transcript?url=` on your vid2context server and copies the result, or shows the server's error and hint.

Manifest V3 for Chrome and Edge, with an equivalent Firefox build.

## Build

```sh
npm install                              # at the repo root
npm run build -w packages/extension      # writes dist/chrome and dist/firefox
```

The build runs Vite for the popup and options pages (React 19, Tailwind v4) and bundles the background, content script and page script as self-contained files. Icons are drawn from the project logo at build time.

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

## Permissions and why

| Permission | Why |
|---|---|
| `activeTab` | Read the current tab's URL in the popup, and show a result in the tab after a context-menu action |
| `contextMenus` | The two right-click items |
| `storage` | Options (`storage.sync`) and the last five items (`storage.local`) |
| `scripting` | Show the context-menu result in the page, and add the YouTube scripts to tabs opened before the extension was installed |
| `https://www.youtube.com/*`, `https://m.youtube.com/*` | Run on watch pages and fetch caption tracks from youtube.com |
| Optional: `https://*/*`, `http://*/*` | Requested only for your API base's host, the first time you use "Copy transcript (via API)" (or press "Allow API access" in the options). Because the extension holds that permission, the API needs no CORS setup for it |

No remote code, no `eval`, no analytics and no third-party requests. The page CSP is `script-src 'self'; object-src 'self'`.

## How YouTube captions are fetched

1. A small script in the page's own JavaScript world (`src/page/index.ts`, manifest `world: "MAIN"`) reads the current player response, so it is right after YouTube's single-page navigation too. If that fails, the content script reads `ytInitialPlayerResponse` from the page, then refetches the watch page from youtube.com.
2. The track is picked with `chooseTrack` from `@vid2context/provider-youtube` (creator captions in the spoken language first, then the default track, then auto-captions).
3. The track is downloaded as srv3 and parsed with the provider's `parseTimedText`. Watch-page track URLs now often need the proof-of-origin token the web player attaches to its own caption requests; when the plain URL comes back empty, the page script borrows that token from the player's caption request (switching captions on for a moment if the player has not made one, then restoring them) and the download is retried with it.
4. Metadata comes from `videoDetails` and `microformat`, chapters from the provider's description parser, and the result is a `VideoContext` like every other vid2context surface produces.

## Tests

```sh
npx vitest run packages/extension          # unit tests on recorded pages and responses, no network
npm run e2e -w packages/extension          # Playwright, live: loads dist/chrome in Chromium
```

The Playwright run needs a build first. It opens the real watch page for "Me at the zoo", checks the buttons appear once, clicks "Copy for AI" and reads the clipboard. It also runs the same flow with the recorded caption track served for the caption request, which checks the in-browser path on networks YouTube refuses captions to (datacenter IPs often get HTTP 429). `V2C_SCREENSHOTS=<dir>` saves screenshots of the buttons, popup and options page.

`npm run lint:firefox -w packages/extension` runs `web-ext lint` on the Firefox build.

## Store listing checklist

- [ ] Version bumped in `package.json` (the manifests read it).
- [ ] `npm run build -w packages/extension`, then zip the contents of `dist/chrome` (Chrome Web Store, Edge Add-ons) and `dist/firefox` (addons.mozilla.org).
- [ ] `web-ext lint` on `dist/firefox`: no errors (the two `innerHTML` warnings come from react-dom).
- [ ] Screenshots at 1280x800: the buttons under a YouTube title, the "Copied" status, the popup on a YouTube tab, the options page, the context menu on a link.
- [ ] Icon 128x128 (`dist/chrome/icons/128.png`) and a small promo tile 440x280.
- [ ] Privacy statement: "On YouTube pages, vid2context reads captions from the page and youtube.com and formats them in your browser. No data leaves the browser. 'Copy transcript (via API)' sends the URL you chose only to the API base you configured. The extension collects no analytics and makes no third-party requests." Firefox: `data_collection_permissions` is `none`.
- [ ] Permission justifications from the table above (the Chrome Web Store asks for each one, and for `scripting` and host permissions separately).
- [ ] Single purpose (Chrome): "Turn the video in the current tab into context for AI agents."
- [ ] AMO: upload the source or point at this repository, with the build command, since the bundles are minified.
