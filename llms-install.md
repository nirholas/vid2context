# Installing vid2context

These steps are for AI agents (Cline, Claude Code, Cursor and others) setting up the vid2context MCP server for a user.

vid2context turns a video URL or a local media file into context: the transcript with timestamps, metadata and chapters. It needs Node.js 22 or newer and no API keys.

## 1. Add the server

Add this to the client's MCP settings (for Cline, `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "vid2context": {
      "command": "npx",
      "args": [
        "-y",
        "vid2context-mcp"
      ]
    }
  }
}
```

Claude Code users can run:

```sh
claude mcp add --scope user --transport stdio vid2context -- npx -y vid2context-mcp
```

## 2. Optional keys

Nothing is required: creator captions and auto-captions work with no key, and speech-to-text falls back to keyless hosts. Ask the user whether they have any of these, and if so add them under `"env"` in the server entry:

- `GROQ_API_KEY`: Groq free tier: fast Whisper speech-to-text and LLMs
- `GEMINI_API_KEY`: Google AI Studio free tier LLMs
- `OPENAI_API_KEY`: OpenAI, used last and only when set
- `OLLAMA_BASE_URL`: Local Ollama server, for example http://localhost:11434/v1
- `LOCAL_STT_BASE_URL`: Local OpenAI-compatible speech-to-text server, for example http://localhost:8000/v1

## 3. Verify

Call the `get_transcript` tool with `{"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "timestamps": true}`. The result starts with a header (title, channel, URL) followed by lines such as `[0:01] All right, so here we are, in front of the elephants`.

If a call fails, the error carries a `hint` that says how to recover. Source and docs: https://github.com/nirholas/vid2context
