# Local speech-to-text with whisper.cpp

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) runs Whisper on your own machine. With it enabled, the default `free` policy transcribes locally before trying any hosted service, and `VID2CONTEXT_POLICY=local-only` can transcribe at all. Nothing leaves the machine, there are no rate limits, and local files have no upload size limit. Node only.

## Setup

```sh
npx tsx providers/stt-whisper-cpp/src/setup.ts            # recommended model for this machine
npx tsx providers/stt-whisper-cpp/src/setup.ts --lang en  # English-only model on CPU (faster, more accurate for English)
npx tsx providers/stt-whisper-cpp/src/setup.ts --model large-v3-turbo-q5_0
```

What it does:

1. Detects hardware (`nvidia-smi`, `system_profiler` and `sysctl` on macOS, `vulkaninfo`, CPU and memory).
2. Finds whisper.cpp: `WHISPER_CPP_BIN`, then `whisper-cli` on `PATH`, otherwise installs it into `.vid2context/bin/whisper.cpp/` (or under `VID2CONTEXT_HOME`):
   - Linux x64 and arm64, Windows: the official prebuilt binary from the latest release. Version releases (`v1.9.5`) carry no files; the binaries are on the matching nightly release (`b5454`, same commit). The archive's SHA-256 is checked against the digest GitHub publishes.
   - macOS (Metal on Apple Silicon), Linux with an NVIDIA GPU and `nvcc` (CUDA), Linux with a Vulkan GPU and `glslc` (Vulkan): built from the release tag's source with CMake. Needs CMake and a C++ compiler; about 90 seconds on a 31-thread CPU.
   - `build.json` next to the binary records the version, commit, source (prebuilt or source), backend and CMake flags. A lock in `.vid2context/locks/` keeps two processes from installing at once.
3. Downloads the model from [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp) into `.vid2context/models/whisper/`. The SHA-256 comes from the repository's tree API (the Git LFS object id). Interrupted downloads resume; a file only appears under its final name after its checksum matches.
4. Transcribes `tests/fixtures/media/apollo11-small-step.mp3` as a smoke test and reports the realtime factor.
5. Prints the lines to add to `.env` (stdout), for example:

```
WHISPER_CPP_BIN=/path/to/.vid2context/bin/whisper.cpp/whisper-cli
WHISPER_CPP_MODEL=small
WHISPER_CPP_GPU=0
```

Flags: `--model <name|path>`, `--lang <code>`, `--force-cpu` (CPU build and a CPU-sized model), `--server` (also test server mode and print `WHISPER_CPP_SERVER=1`), `--from-source` (build even where a prebuilt binary exists), `--force` (reinstall and re-download), `--no-smoke`.

The CLI's `setup` and `doctor` commands can call the same code: `setupWhisperCpp(options, ctx)` from `@vid2context/provider-stt-whisper-cpp/setup` and `detectHardware()` from `@vid2context/provider-stt-whisper-cpp`.

The rung is enabled when `WHISPER_CPP_MODEL` is set (decided from env alone). Paths are checked when a transcription runs; a missing binary or model fails with a hint naming the setup command.

## Models

| Model | Size | Notes |
|---|---|---|
| `tiny`, `tiny.en` | 78 MB | rough; fine for a quick check |
| `base`, `base.en` | 148 MB | small CPUs |
| `small`, `small.en` | 488 MB | default on CPUs with 8 or more threads and 8 GB of memory |
| `medium`, `medium.en` | 1.5 GB | |
| `large-v3-turbo` | 1.6 GB | default with an NVIDIA GPU (6 GB VRAM or more) or Apple Silicon |
| `large-v3` | 3.1 GB | best quality, slowest |

Quantized variants are smaller and faster with little quality loss: `-q5_1` and `-q8_0` for tiny, base and small; `-q5_0` and `-q8_0` for medium, large-v3-turbo (`large-v3-turbo-q5_0`, 574 MB) and large-v3 (`-q5_0` only). English-only models (`.en`) are more accurate for English but cannot detect language or translate; the rung drops those capabilities and refuses other languages so the chain moves on to another rung.

`WHISPER_CPP_MODEL` also accepts an absolute path to any ggml `.bin` file.

## Hardware recommendations

| Hardware | Build | Model |
|---|---|---|
| NVIDIA GPU, 6 GB or more VRAM, CUDA toolkit installed | CUDA (source) | `large-v3-turbo` |
| NVIDIA GPU without `nvcc` | CPU prebuilt (setup notes how to get CUDA) | CPU model |
| Apple Silicon | Metal (source) | `large-v3-turbo` |
| CPU only, 8 or more threads | prebuilt CPU | `small` (`small.en` for English) |
| Smaller CPU | prebuilt CPU | `base` (`base.en`) |

Measured on 2026-11-14 on the development VM (31 CPU threads, 126 GB memory, no GPU), 24 s Apollo clip, 8 threads: `base.en` about 25x realtime, `small` about 5x. Every transcription reports its realtime factor (audio seconds per wall-clock second) in the result's `detail` and in the info log.

When setup built for a GPU it prints `WHISPER_CPP_GPU=1`, which moves whisper.cpp ahead of other local rungs (an OpenAI-compatible local server). On CPU it runs after them, still before any hosted rung.

## Server mode

One-shot mode starts `whisper-cli` per transcription and loads the model each time (under a second for small models, several seconds for large ones on CPU). For many calls in one process:

- `WHISPER_CPP_SERVER=1`: vid2context starts `whisper-server` on a random local port the first time it is needed and stops it when the process exits.
- `WHISPER_CPP_SERVER_URL=http://host:port`: use a server you run yourself (`whisper-server -m model.bin --host 127.0.0.1 --port 8080`). The rung posts 16 kHz WAV to its `/inference` endpoint.

## Translation

whisper.cpp can translate speech into English (`-tr`). Pass `translate: true` in the options to `transcribeWhisperCpp`; the rung advertises the `translate` capability for multilingual models. Raw transcripts stay the default.

## Troubleshooting

| Problem | Fix |
|---|---|
| `whisper-cli was not found` | Run setup, or set `WHISPER_CPP_BIN`. |
| `model not found` | `setup.ts --model <name>`, or point `WHISPER_CPP_MODEL` at an existing file. Names resolve under `.vid2context/models/whisper/` in the current directory unless `VID2CONTEXT_HOME` is set. |
| `ffmpeg is needed` | Install ffmpeg or set `FFMPEG_PATH`. |
| `Building whisper.cpp needs CMake` | Install CMake and a compiler (`xcode-select --install` and `brew install cmake`; `apt install cmake build-essential`; or `pip install cmake`). |
| Out of memory | Use a quantized or smaller model (`large-v3-turbo-q5_0`, `small`). |
| Too slow on CPU | Use `base.en` or a `-q5_1` model, or raise `WHISPER_CPP_THREADS`. |
| Want a CUDA build after installing the toolkit | `setup.ts --force`. |
| `Timed out waiting for the lock` | Another process is installing; wait, or delete the file under `.vid2context/locks/` if it is gone. |

## Open question for the owner

Do you have an NVIDIA GPU (or an Apple Silicon Mac) where vid2context runs? On a GPU, whisper.cpp with `large-v3-turbo` is fast and matches hosted Whisper quality, so it should lead the default speech-to-text chain. On CPU only (like the development VM, which has no GPU), `small` runs at about 5x realtime: fine for clips, slow for hour-long videos, so the hosted free rungs (Groq with your key, OVH keyless) may be the better default for long audio, with whisper.cpp as the private, unlimited choice. `npx tsx providers/stt-whisper-cpp/src/setup.ts --no-smoke` prints the detected hardware on any machine.
