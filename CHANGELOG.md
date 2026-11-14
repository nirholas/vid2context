# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@vid2context/core`: data model, provider contracts, the free-first rung chain with cooldowns and key pools, the video-to-context pipeline (`auto`, `captions`, `stt` and `video` modes), `text` and `json` formatters, in-memory storage.
- `@vid2context/registry`: provider registries generated per runtime (node, workers, browser).
- `@vid2context/cli`: minimal command line with `text` and `json` output, transcript modes and language selection.
- `youtube` provider: URL matching, metadata, description chapters, creator and auto captions. No API key.
- `media-file` provider: local audio and video files as speech-to-text sources.
- `stt-openai-compatible` provider: local servers, Groq, OVH (keyless) and OpenAI speech-to-text.
- `llm-openai-compatible` provider: Ollama, LM Studio, local servers, Groq, Cerebras, Mistral, GitHub Models, Gemini, OVH and Pollinations (keyless), and OpenAI.

[Unreleased]: https://github.com/nirholas/vid2context/commits/main
