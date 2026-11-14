# stt-whisper-cpp fixtures

All recorded on 2026-11-14 on the development VM (GCP, Linux x64, 31 CPU threads, no GPU) with the official prebuilt whisper.cpp 1.9.5 (`whisper-bin-ubuntu-x64.tar.gz` from release `b5454`, commit d1be6fde, SHA-256 a72becf1...781c verified). Audio: `tests/fixtures/media/apollo11-small-step.mp3` (public domain, NASA), converted with `ffmpeg -i apollo11-small-step.mp3 -ar 16000 -ac 1 -c:a pcm_s16le a.wav`. Models from huggingface.co/ggerganov/whisper.cpp, SHA-256 checked against the repository's tree API.

| File | What | How |
|---|---|---|
| `cli-base.en-apollo.json` | whisper-cli JSON output, two segments, "small step" | `whisper-cli -m ggml-base.en.bin -f a.wav -oj -of cli-base.en-apollo -l en -t 8 -np` |
| `cli-tiny-auto-apollo.json` | whisper-cli JSON output with language detection (`result.language: "en"`) | `whisper-cli -m ggml-tiny.bin -f a.wav -oj -of cli-tiny-auto-apollo -l auto -t 8 -np` |
| `server-base.en-apollo.verbose.json` | whisper-server `/inference` response, `verbose_json` (language as a name, "english") | `whisper-server -m ggml-base.en.bin --host 127.0.0.1 --port 25913 -t 8`, then `curl /inference -F file=@a.wav -F response_format=verbose_json -F language=en -F temperature=0.0`. The same server answered a non-audio upload with HTTP 400, `text/plain`, body `Invalid request` (used inline in the tests). |
| `stderr-model-not-found.txt` | first stderr line of whisper-cli with a missing model (exit 3) | `whisper-cli -m missing-model.bin -f a.wav -np` |
| `stderr-bad-audio.txt` | whisper-cli stderr for a file that is not audio (exit 11) | `whisper-cli -m ggml-tiny.bin -f not-audio.json -np` (a copy of the repo's package.json) |
| `apollo-16k-mono.wav.head` | the first 128 bytes of `a.wav` (RIFF header with a LIST chunk, then PCM); the full file is 771,684 bytes, 24.11 s | `head -c 128 a.wav` |
| `hf-tree-main.json` | Hugging Face tree API for the model repository: file sizes and SHA-256 (LFS oid) | `curl https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main` |
| `gh-release-latest.json` | GitHub latest release (v1.9.5, no assets, links nightly b5454) | `curl https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest`, trimmed to `tag_name`, `target_commitish`, `published_at`, the body before its changelog, and `assets` (`name`, `size`, `digest`, `browser_download_url`) |
| `gh-release-b5454.json` | GitHub nightly release b5454 with the prebuilt archives and their digests | same command for `releases/tags/b5454`, same trimming |
| `hardware-gcp-vm.json` | `detectHardware()` on this VM: no nvidia-smi, no vulkaninfo, so `vendor: "none"` | `npx tsx` running `detectHardware()` from `src/hardware.ts` |

No `nvidia-smi`, `vulkaninfo` or macOS samples are recorded: this VM has none of those tools. Add one only from a real machine (its raw command output), with a line here.
