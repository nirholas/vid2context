# vid2context CLI

`vid2context` turns a video URL or file into context for an AI agent. It is the command a developer tries first and the one agents shell out to when MCP is not set up. Every command takes `--help` and `--json`.

```sh
npx vid2context https://www.youtube.com/watch?v=jNQXAC9IVRw
npm run -s cli -- <args>              # from a checkout (-s keeps npm's own banner off stdout)
npx tsx packages/cli/src/bin.ts <args>
```

Node 22 or newer. Keys are read from the environment and `./.env` (or `VID2CONTEXT_ENV_FILE`); shell variables win, and every key is optional. `vid2context doctor` tells you what is missing.

## Output rules

- stdout carries only program output: the transcript, the JSON, the list. `vid2context URL > out.txt` leaves just the transcript in the file.
- Progress, spinners, notes, errors, hints and the attempts list go to stderr. Spinners run only when stderr is a terminal and `--quiet` is off.
- `--out <file>` writes program output to the file instead. It refuses to overwrite an existing file unless `--force`, and checks before doing any work.
- `--json` switches stdout to JSON for every command. Errors are then a JSON object on stderr: `{"error":{"code","message","hint","exitCode","attempts"}}`.
- Errors always print the message and the hint. The attempts list (every provider and rung tried) is added with `--verbose` or `--json`.

## Commands

| Command | What it does |
|---|---|
| `vid2context <input>`, `get <input>` | Transcript and metadata for one video |
| `list <input>` | Expand a playlist, channel, feed or page into video refs |
| `formats` | The output formats, read from the formatter map at runtime |
| `pack <inputs...>` | One context pack (Markdown for an AI model) from one or many videos |
| `bundle <inputs...> -o file.zip` | A .zip with every format, the pack, a manifest and a README for agents |
| `search <query>` | Keyword search over transcripts saved in the library |
| `library ls`, `show <id>`, `rm <id>` | Saved video contexts |
| `collection create`, `add`, `ls`, `show`, `refresh`, `rm` | Named groups of videos in the library |
| `models` | Every rung by tier, whether it is enabled, and the env var names it needs |
| `doctor` | Checks Node, ffmpeg, yt-dlp, deno, GPU, the data directory, keys and the network |
| `config` | Resolved settings and where each came from, secrets masked |
| `serve` | Start the HTTP API |
| `mcp` | Start the stdio MCP server |
| `completion bash\|zsh\|fish` | Print a shell completion script |
| `help [command]` | Help for a command |

A first argument that is not a command runs `get`. A mistyped command (`vid2context doctr`) fails with a hint naming the closest one.

### get

```
vid2context get <input> [--comments [n]] [--refresh] [global flags]
```

`<input>` is a video URL, a YouTube id, a podcast episode or a local media file. With a persistent storage backend the result is saved to the library, and later runs answer from it unless `--refresh`. `--comments` fetches comments too (optionally at most `n`) and includes them in formats that show comments.

```
$ vid2context jNQXAC9IVRw --timestamps
[0:00] Alright, so here we are, one of the elephants.
[0:04] The cool thing about these guys is that they have
[0:07] really, really, really long
[0:11] trunks, and that's cool.
[0:16] And that's pretty much all there is to say.
```

That run came from a cloud VM whose IP YouTube blocks for captions, so the transcript was made by speech-to-text (yt-dlp audio, then Cloudflare Whisper). On a home connection the same command returns the creator captions. `--verbose` shows why:

```
Attempts:
  resolve  ok      youtube  youtube:jNQXAC9IVRw
  metadata ok      youtube
  captions error   youtube-captions  blocked: YouTube captions en: YouTube answered HTTP 429 (automated-traffic block).
  captions error   ytdlp-captions  rate-limited: yt-dlp captions: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests
  audio    ok      ytdlp
  stt      ok      stt/cloudflare/@cf/openai/whisper-large-v3-turbo
```

### list

```
vid2context list <input> [--limit n] [--json]
```

One video URL (or id, when there is no URL) per line; the count goes to stderr. `--json` prints the `VideoRef` array. A single video lists as itself.

```
$ vid2context list "https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b" --limit 3
https://www.youtube.com/watch?v=PzJL3aBRas8
https://www.youtube.com/watch?v=1Xx1fmHIsiA
https://www.youtube.com/watch?v=AS6LYBzFtEU
3 items
```

Pipe it back in: `vid2context list <playlist> | xargs -n1 vid2context get --format json`.

### formats

```
$ vid2context formats
ID        EXT   VIDEOS  DESCRIPTION
text      txt   one     Plain transcript text. With timestamps, one "[m:ss] line" per caption.
json      json  one     The full VideoContext as JSON: metadata, chapters, timed segments, and how it was produced.
markdown  md    one     Markdown transcript: title and metadata, chapters as headings, paragraphs prefixed with timestamp links. Options: linkTimestamps, includeComments, includeVisual.
srt       srt   one     SubRip (.srt) captions: at most 2 lines of 42 characters per cue, no overlaps, for players and editors.
vtt       vtt   one     WebVTT (.vtt) captions for the HTML <track> element, with speaker voice tags when known.
pack      md    many    Context pack: one Markdown file for one or many videos, written for an AI model to read, with citation instructions. Options: maxTokens, includeComments, includeVisual, linkTimestamps.
```

### pack

```
vid2context pack <inputs...> [--max-tokens n] [--comments [n]] [--refresh]
```

Playlists, channels and feeds are expanded first. If an input fails, the others still go into the pack, the failure is reported on stderr, and the exit code is that failure's code.

```
$ vid2context pack jNQXAC9IVRw --max-tokens 2000
# Video context pack

This document holds the transcripts and metadata of one video (0:19 in total), prepared by vid2context for an AI model to read. ...

Citation rule: when you use something from a video, cite it as [Title @ m:ss](link), ...

## Me at the zoo

- Channel: [jawed](https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A)
- Duration: 0:19
...
```

### bundle

```
vid2context bundle <inputs...> -o file.zip [--max-tokens n] [--comments [n]] [--name name]
```

Writes the zip described in `docs/bundle.md`. `--out` is required. With `--json`, the bundle manifest is printed on stdout (the zip goes to the file).

```
$ vid2context bundle jNQXAC9IVRw -o zoo.zip
10 files for 1 video in me-at-the-zoo/
wrote /home/user/zoo.zip (7380 bytes)
```

### search, library, collection

These work over the storage backend: the first enabled one (SQLite in `.vid2context/library.db` when that provider is installed, or Postgres, or D1). Without a persistent backend the library lives only for one process, so it starts empty on every run; the commands say so on stderr. `vid2context config` shows the backend in use.

```
$ vid2context search elephants
Me at the zoo [0:00] Alright, so here we are, one of the elephants.
  https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s
1 hit

$ vid2context library ls
ID                   ORIGIN  LANG  LENGTH  TITLE
youtube:jNQXAC9IVRw  stt     en    0:19    Me at the zoo
```

`search` takes `--collection <id>` and `--limit n`. `library ls` takes `--limit n`; `library show <id>` prints a saved video in `--format` without any network call; `library rm <id>` deletes it.

```
$ vid2context collection create "CLI docs sample" --description "Recorded for docs/cli.md"
cli-docs-sample-dc5ca00b
$ vid2context collection add cli-docs-sample-dc5ca00b youtube:jNQXAC9IVRw
CLI docs sample (cli-docs-sample-dc5ca00b)
Recorded for docs/cli.md
1 video
  youtube:jNQXAC9IVRw  Me at the zoo
$ vid2context collection ls
ID                        VIDEOS  NAME
cli-docs-sample-dc5ca00b  1       CLI docs sample
$ vid2context collection rm cli-docs-sample-dc5ca00b
deleted cli-docs-sample-dc5ca00b
```

`collection refresh <id> [--limit n]` expands the collection's `--source` playlists or feeds and ingests the videos it has not seen yet (through `@vid2context/library`). Per-video failures go to stderr and are retried on the next refresh; the command still exits 0.

```
$ vid2context collection create "refresh check" --source "https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b"
refresh-check-86c6c545
$ vid2context collection refresh refresh-check-86c6c545 --limit 1
refresh check (refresh-check-86c6c545): 1 added, 0 skipped, 0 failed, 8 left for the next run
  + youtube:PzJL3aBRas8  Why I'm Selling My DREAM G-Wagon (Custom Build 2015 Mercedes G550)
```

`collection add <id> <inputs...>` takes library ids (no network) or URLs; URLs and lists are fetched, saved and added. `collection create` takes `--source <input>` (repeatable) for the playlists or feeds it follows. `collection rm <id> <video-ids...>` removes videos; without video ids it deletes the collection.

### models

```
vid2context models [--kind llm|stt|embed|video|visual] [--json]
```

Only env var names are printed, never values. `--json` returns `ModelInfo` rows (`docs/prompts/SHARED-CONTRACTS.md` section 3) plus `missing`, the names that are not set.

```
$ vid2context models --kind stt
local (0 of 3 enabled)
  stt  stt/local                                     disabled  needs LOCAL_STT_BASE_URL, LOCAL_STT_MODEL
  stt  stt/transformers/onnx-community/whisper-base  disabled  needs TRANSFORMERS_STT_MODEL
  stt  stt/whisper-cpp                               disabled  needs WHISPER_CPP_MODEL

free (2 of 6 enabled)
  stt  stt/cloudflare-binding/@cf/openai/whisper-large-v3-turbo  disabled  needs CLOUDFLARE_AI_BINDING
  stt  stt/cloudflare-binding/@cf/openai/whisper                 disabled  needs CLOUDFLARE_AI_BINDING
  stt  stt/cloudflare/@cf/openai/whisper-large-v3-turbo          enabled
  stt  stt/cloudflare/@cf/openai/whisper                         enabled
  stt  stt/groq/whisper-large-v3-turbo                           disabled  needs GROQ_API_KEY
  stt  stt/mistral/voxtral-mini-transcribe-3                     disabled  needs MISTRAL_API_KEY

keyless (1 of 1 enabled)
  stt  stt/ovh/whisper-large-v3-turbo  enabled

paid (0 of 3 enabled)
  stt  stt/deepinfra/openai/whisper-large-v3-turbo  disabled  needs DEEPINFRA_API_KEY
  stt  stt/together/openai/whisper-large-v3         disabled  needs TOGETHER_API_KEY
  stt  stt/openai/whisper-1                         disabled  needs OPENAI_API_KEY
```

### doctor

Each check is `ok`, `warn` or `fail`, with a fix line when it is not ok. Exits 1 when any check fails. It makes two small network requests: the keyless OVH models list, and the captions of `jNQXAC9IVRw` on YouTube (which detects an IP block). `--json` prints the checks as an array.

```
$ vid2context doctor
ok    Node.js           v24.22.2 (22 or newer required)
ok    ffmpeg            7.0.2-static at /home/user/.local/bin/ffmpeg
ok    ffprobe           7.0.2-static at /home/user/.local/bin/ffprobe
ok    yt-dlp            2026.10.26 at /home/user/vid2context/vid2context/.vid2context/bin/yt-dlp
warn  deno              not found. yt-dlp uses a JavaScript runtime to solve YouTube player challenges.
                        fix: Install deno (curl -fsSL https://deno.land/install.sh | sh, or brew install deno).
warn  NVIDIA GPU        nvidia-smi not found: local speech-to-text and LLMs run on the CPU
                        fix: Optional. Free hosted and keyless rungs work without a GPU; install the NVIDIA driver to speed up local models.
ok    Data directory    /home/user/vid2context/vid2context/.vid2context is writable
ok    Keys              2 of 34 set: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
ok    Keyless hosts     OVH AI Endpoints reachable (21 models listed)
fail  YouTube captions  YouTube is blocking this machine's IP (blocked): YouTube captions en: YouTube answered HTTP 429 (automated-traffic block).
                        fix: YouTube is refusing requests from this IP address, which is common on cloud servers. Fixes, best first: run vid2context on your own machine; route the server through your home network (docs/guides/cloudflare-tunnel.md); set YOUTUBE_COOKIE to a signed-in Cookie header (ties requests to your account); or install the yt-dlp provider. Then wait for the block to clear (YOUTUBE_BLOCK_COOLDOWN_SEC).

10 checks: 7 ok, 2 warn, 1 fail
```

Binaries are looked up in the env var path (`FFMPEG_PATH`, `FFPROBE_PATH`, `YTDLP_PATH`), then `PATH`, then `~/.local/bin`, then `<data dir>/bin`. The data directory is `VID2CONTEXT_HOME`, else `./.vid2context`.

### config

```
vid2context config [--profile name] [--json]
```

Every effective setting, its value and where it came from (environment, config profile or default), with secrets masked, then the storage backend. With a config file (`vid2context.config.json`, see `packages/config`) it explains the selected profile; `--profile` picks another.

```
$ vid2context config
No config file: settings come from the environment and built-in defaults.
Precedence: environment, then config profile, then built-in default.

Setting                         Value                    Source
VID2CONTEXT_POLICY              free                     default
VID2CONTEXT_ALLOW_PAID          1                        default
VID2CONTEXT_KEYLESS             1                        default
VID2CONTEXT_SKIP                (none)                   default
VID2CONTEXT_STORAGE             (first enabled backend)  default
...

Storage backend: storage-sqlite
```

### serve and mcp

`vid2context serve [--port n] [--host h]` starts the HTTP API (`packages/server`) on `PORT` or 8787 and `HOST` or 127.0.0.1, and runs until Ctrl-C. `vid2context mcp` starts the stdio MCP server (`packages/mcp`); stdout then carries only the protocol.

## Global flags

| Flag | Meaning |
|---|---|
| `-f, --format <id>` | Output format (default `text`); any id from `vid2context formats` |
| `-t, --timestamps` | Prefix lines with timestamps where the format allows |
| `--mode <mode>` | `auto`, `captions`, `stt` or `video` (default `auto`) |
| `--lang <code>` | Preferred transcript language, e.g. `en`, `de`, `pt-BR` |
| `--policy <policy>` | Rung order: `free`, `local-only` or `quality` (default `VID2CONTEXT_POLICY`, else `free`) |
| `--only <ids>` | Use only these rung ids, services or providers (comma-separated, repeatable) |
| `--skip <ids>` | Never use these (added to `VID2CONTEXT_SKIP`) |
| `--allow-paid` | Allow paid rungs even when `VID2CONTEXT_ALLOW_PAID=0` |
| `--json` | JSON on stdout; errors as JSON on stderr |
| `-q, --quiet` | Only errors on stderr |
| `--verbose` | Progress logs and the attempts list on stderr |
| `-o, --out <file>` | Write program output to a file |
| `--force` | Overwrite the `--out` file |
| `-h, --help`, `-v, --version` | Help, version |

Command flags (`--limit`, `--max-tokens`, `--kind` and so on) are accepted only by their command. An unknown flag fails with a hint naming the closest valid one:

```
$ vid2context jNQXAC9IVRw --fromat json
error: Unknown flag --fromat.
hint: Did you mean --format? Run `vid2context --help` for every flag.
```

## Exit codes

Stable: scripts can branch on them. Each error code has its own number.

| Code | Name | Meaning |
|---|---|---|
| 0 | `ok` | success |
| 1 | `failure` | unexpected error, or a doctor check failed |
| 2 | `usage` | bad command line (unknown command or flag, wrong arguments) |
| 3 | `unsupported-input` | no source understands the input, or it is a list where a video was needed |
| 4 | `not-found` | the video, collection or library item does not exist |
| 5 | `unavailable` | the video exists but cannot be read (private, removed, members-only, age-restricted, live) |
| 6 | `no-transcript` | every way of getting a transcript failed; see the attempts list |
| 7 | `no-provider` | no provider or rung is installed or enabled for the step |
| 8 | `all-rungs-failed` | every rung in a fallback chain failed |
| 9 | `rate-limited` | an upstream service rate-limited the request |
| 10 | `auth` | a key was rejected or its account is out of credits |
| 11 | `blocked` | the platform blocked this machine (for example a datacenter IP) |
| 12 | `too-large` | the media or request is larger than allowed |
| 13 | `timeout` | an upstream call timed out |
| 14 | `upstream` | an upstream service returned an error |
| 15 | `bad-request` | the request is invalid (unknown format, bad option value) |
| 130 | `interrupted` | stopped with Ctrl-C |

The table lives in `packages/cli/src/exit-codes.ts`; a test checks that every core `ErrorCode` has a distinct number and a row here.

## Shell completion

The scripts are generated from the same command table as `--help`.

```sh
# bash
vid2context completion bash > ~/.local/share/bash-completion/completions/vid2context

# zsh: any directory on $fpath, then restart the shell
vid2context completion zsh > "${fpath[1]}/_vid2context"

# fish
vid2context completion fish > ~/.config/fish/completions/vid2context.fish
```
