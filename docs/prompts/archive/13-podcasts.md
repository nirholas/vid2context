# 13. Podcasts: RSS, podcast:transcript, Apple and Spotify lookups

| | |
|---|---|
| Track | C. Other sources |
| You own | `providers/podcast/` |
| Shared edits allowed | Your own rows in `docs/providers.md` and variables in `.env.example` |
| Commit scope | `podcast` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. A lot of the best long-form material is in podcasts, and many podcasts already publish a transcript and chapters in their RSS feed (the Podcasting 2.0 `podcast:transcript` and `podcast:chapters` tags). When they do, vid2context should use it and skip speech-to-text entirely; when they do not, it should hand the episode audio to the free-first speech-to-text chain. People rarely paste RSS URLs, though: they paste Apple Podcasts or Spotify links, so this prompt resolves those to feeds too.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts` (`SourceProvider` with `listItems`, `CaptionsProvider`), and `packages/core/src/testing.ts`.
3. `docs/contracts/providers.md` (ref id rules: lists use `${platform}:${kind}:${nativeId}`; `listItems` streams), and `docs/contracts/http-api.md` (`GET /items` uses this provider for feeds).
4. `packages/core/src/pipeline.ts` (`expandInput`, `fetchAudio`, captions before audio).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7 (fixtures) and 8 (shared files).

## Goal

Feed URLs, Apple Podcasts links and Spotify links resolve to a podcast feed or episode. `listItems` streams episodes newest first. Episodes with a `podcast:transcript` get a `native-transcript` with no speech-to-text, chapters come from `podcast:chapters`, and everything else gets enclosure audio for the speech-to-text chain. It runs on Node and Workers.

## Requirements

### Inputs and matching (synchronous, no network)

- Feed URLs by heuristics: paths ending in `.rss` or `.xml`, containing `/feed` or `/rss`, and known feed hosts: `feeds.megaphone.fm`, `feeds.simplecast.com`, `rss.art19.com`, `feeds.buzzsprout.com`, `anchor.fm/s/.../podcast/rss`, `feeds.transistor.fm`, `omnycontent.com`, `feed.podbean.com`, `feeds.libsyn.com`, `feeds.acast.com`, `feeds.captivate.fm`. Also an explicit `podcast:<feed url>` form for feeds the heuristics miss (document it).
- Apple Podcasts: `podcasts.apple.com/<cc>/podcast/<slug>/id<N>` (show) and `...?i=<episodeId>` (episode).
- Spotify: `open.spotify.com/show/<id>` and `open.spotify.com/episode/<id>`.
- Refs: a feed ref (`kind: 'feed'`, id `podcast:feed:<sha256 of feed URL>`), and episode refs (`kind: 'video'`, platform `podcast`, nativeId a sha256 of feed URL plus guid, `url` the episode link or the enclosure). Apple and Spotify refs carry their native ids until resolved.

### Resolution

- Apple: the iTunes Lookup API (`https://itunes.apple.com/lookup?id=<N>&entity=podcastEpisode`) gives `feedUrl` and episode data; match the episode by `trackId`, then by guid or title.
- Spotify: Spotify has no public RSS. Best effort, keyless: oEmbed (`https://open.spotify.com/oembed?url=...`) for the show or episode title, then the iTunes Search API (`https://itunes.apple.com/search?media=podcast&term=...`) for candidate feeds. Accept a match only with high confidence (normalized show title and author agree, and for episodes the episode title matches an item in the feed); otherwise throw `unsupported-input` with a hint to paste the show's RSS feed. Never guess.
- Verify each endpoint live before relying on it and record what it returned; if one has changed, adapt or drop that path and report.

### Feed parsing

- A small XML parser that works on Workers (no Node built-ins, no DOM). Handle RSS 2.0 and Atom, CDATA, entities, namespaces (`itunes:`, `podcast:`, `content:`).
- Channel: title, author, image, description, language, link. Items: title, guid, pubDate (to ISO 8601), `itunes:duration` (`hh:mm:ss`, `mm:ss` or seconds), enclosure URL, type and length, description or `content:encoded`, image, `podcast:transcript` (all entries with type, language, rel), `podcast:chapters` (URL to the JSON chapters format), `podcast:person`.
- `getMetadata` for an episode: title, channel (show) with link, description, duration, publishedAt, thumbnail, language, chapters (fetched from `podcast:chapters` when present), `extra.persons`.
- `listItems` for a feed ref: episodes newest first, respecting `limit`, streaming as it parses.

### Captions provider `podcast-transcript`

- `supports(ref)` for podcast episode refs. Prefer transcript types with timing in this order: `text/vtt`, `application/x-subrip` (SRT), `application/json` (the Podcasting 2.0 JSON transcript format with segments), then `text/html` only when nothing timed exists (mark it without timing per paragraph, and say so in the producer field).
- Return `origin: 'native-transcript'`, language from the tag or the feed, `speaker` from the formats that carry it.

### Audio

- `getAudio` fetches the enclosure through `ctx.fetch`, following redirects through tracking prefixes (podtrac, chartable, pdst.fm and similar), with a size cap (`VID2CONTEXT_MAX_MEDIA_MB`, default 200) and abort on signal. Return bytes with the enclosure's mime type and a filename with a real audio extension (OVH Whisper rejects files without one).
- Large episodes are split by the long-audio orchestrator at pipeline level (prompt 04); do not split here.
- Runtimes `node` and `workers`. Browsers are blocked by CORS on most feeds, so do not declare `browser`.

## Prefer free and local

Everything here is keyless: RSS, the iTunes APIs and Spotify oEmbed need no account. A native transcript in the feed always beats speech-to-text, so the captions provider must run first (the pipeline already orders captions before audio).

## Out of scope

- Long-audio splitting: prompt 04. Speech-to-text rungs: prompts 17 to 20.
- Collections and watch lists that follow a feed: prompt 41 (library). Your `listItems` is what it calls.
- Web pages that embed a podcast player: prompt 14 (web pages).

## Tests

- Record real feeds into `providers/podcast/test/fixtures/` (trim long feeds to a handful of items, keeping the XML valid, and note the trimming in the README): at least one feed with `podcast:transcript` and `podcast:chapters` (the Podcast Index "Podcasting 2.0" feed is one known example; verify it still carries both), one plain iTunes-style feed, and one Atom feed if you can find a real one.
- Record the transcript files and chapters JSON those feeds point to, a real iTunes Lookup response, a real iTunes Search response, and a real Spotify oEmbed response.
- Assert: matching for every URL form (and that YouTube or random article URLs do not match), parsing of every field above, newest-first ordering and `limit`, transcript type preference, SRT, VTT and JSON transcript parsing to segments, chapters mapping, Spotify low-confidence rejection with the hint, redirect following and size cap through `replayFetch`.
- LIVE: resolve a real Apple episode link to a transcript or audio; resolve a real Spotify show link (or report the rejection reason); run the pipeline on an episode with a native transcript and confirm no speech-to-text attempt was made.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/podcast'` prints nothing.
- [ ] `npx vitest run providers/podcast` passes; `npx biome check providers/podcast` is clean.
- [ ] `npm run gen` lists the podcast providers in the node and workers registries only.
- [ ] `npm run cli -- <real feed URL with podcast:transcript>` style flow: `expandInput` lists episodes, and one episode returns a `native-transcript` with chapters (LIVE).
- [ ] An Apple Podcasts episode URL returns a transcript end to end (LIVE), via native transcript or keyless speech-to-text.

## Docs

- `docs/guides/podcasts.md`: supported inputs, how Apple and Spotify links are resolved (and when Spotify fails), native transcripts and chapters, size limits.
- Your rows in `docs/providers.md` (`podcast` source, `podcast-transcript` captions) and any new env var in `.env.example`.

## If credentials, tools or network are missing

No keys are needed. Without network, test only on recorded fixtures and list the LIVE checks as unverified. If a resolution path (Spotify especially) does not work keyless today, leave it out with a clear error and say so in the report.

## Repo rules (binding, same as AGENTS.md)

- Never use the em-dash or en-dash characters: not in code, comments, docs, UI copy or commit messages. Use commas, colons, periods or parentheses. No emojis.
- No mocks, fake data, placeholders, TODOs, stub functions or "coming soon" text. If a piece cannot be built for real now, leave it out and say so in your final report.
- Tests use real data only: fixtures recorded from the real service, replayed through `replayFetch` and `testContext` from `@vid2context/core/testing`, or live calls gated by `LIVE=1` (`describe.skipIf(!process.env.LIVE)`). A unit test must never reach the network. Every fixture gets a line in its folder's `README.md` saying where and when it was recorded.
- Core code and providers never read `process.env` or the global `fetch`: use the `ctx` passed to every call. Log through `ctx.log` (stderr). stdout is program output and the MCP stdio channel.
- Prefer plain `fetch` over vendor SDKs. `packages/core` and every provider that declares the `workers` or `browser` runtime must not import Node built-ins.
- Every error a user can see is a `Vid2ContextError` with a stable `code` and a `hint` that says how to recover.
- Free first: local, then free tiers with the user's own key, then keyless hosts, and paid services last, only when their key is set. Every model id is overridable by env. New env vars go into `.env.example` and `docs/providers.md` in the same commit.
- Keep raw transcripts. Cleaned text, summaries, translations and briefs are added layers, never replacements.
- TypeScript, ESM, explicit `.ts` import extensions, Biome formatting (`npx biome check --write <your paths>`).

## Working in a shared folder

You are one of 50 agents working at the same time in this folder, each owning different directories.

- Create and edit files only inside the directories this prompt says you own, plus the shared edits listed in its header. Keep shared edits small and additive, and re-read a shared file immediately before every edit: another agent may have changed it a minute ago. `docs/prompts/SHARED-CONTRACTS.md` section 8 lists who may edit which shared file.
- If the foundation code differs from what this prompt describes, the code wins: read it and adapt. If something you need from another prompt has not landed yet, build everything else first and check again before you finish. If it is still missing, leave that piece out and list it in your report. Never stub it.
- Dependencies go only into your own package's `package.json`. Install through the shared lock so parallel installs cannot corrupt `node_modules`: `mkdir -p .vid2context/locks && flock .vid2context/locks/npm npm install -w <your package dir> <name>@<version>`. Never hand-edit `package-lock.json`; if it conflicts, rerun the install through the lock. Never edit `packages/registry/src/generated/`; run `npm run gen` instead.
- Other agents' unfinished work can break the repo-wide `npm run typecheck` and `npm test`. Judge your own paths: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E '<your dirs>'` prints nothing, `npx vitest run <your dirs>` passes, `npx biome check <your dirs>` is clean. Do not fix other agents' files; mention breakage you saw in your report.
- Never run commands that touch other agents' work: `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset`, `git checkout -- <path>`, `git restore`, `git clean`, `git rebase`, `git push`.
- Servers you start for testing: pick a random port between 20000 and 29999, and stop them when you are done.

## Committing

The owner asks you to commit your own work as described here. Commit each coherent piece as soon as it works, not only at the end.

1. `git status --short` and check that every path you will commit is yours.
2. `flock .vid2context/locks/git git add <explicit paths>` (needed for new files).
3. Commit only your paths, which leaves anything other agents staged untouched:
   `flock .vid2context/locks/git git commit -m "<type>(<scope>): <what changed and why it matters>" -m "<body: what and why, in plain language>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <explicit paths>`
   (use the Co-Authored-By trailer your harness specifies if it names a different model).
4. `git show --stat HEAD` and confirm only your files are in the commit.

Types: feat, fix, refactor, perf, test, docs, chore. Never use subjects like "update" or "wip". Do not push. Never amend or rewrite a commit you did not make.

## Final report

Finish with a short report to the owner: what you built (paths), what you verified live and how, what you could not verify and why (missing key, tool or network), every shared-file edit you made, what the integration pass needs to wire up, and any breakage you noticed outside your directories.
