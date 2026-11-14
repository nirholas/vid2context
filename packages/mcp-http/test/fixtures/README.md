# mcp-http fixtures

Real responses recorded from this repo's VM on 2026-11-14 with `curl`. Tests serve them through `replayFetch` (`@vid2context/core/testing`), so unit tests never touch the network. YouTube responses come from `providers/youtube/test/fixtures/` (see its README).

| File | Source |
|---|---|
| `cimd/chatgpt-client.json` | `GET https://chatgpt.com/oauth/client.json`: ChatGPT's Client ID Metadata Document (declares `private_key_jwt`, lists `none` as supported) |
| `cimd/claude-ai-client.json` | `GET https://claude.ai/oauth/mcp-oauth-client-metadata`: Claude.ai's document (redirect `https://claude.ai/api/mcp/auth_callback`, `none`) |
| `cimd/claude-code-client.json` | `GET https://claude.ai/oauth/claude-code-client-metadata`: Claude Code's document (loopback redirects without a port) |

Only the bodies are kept, byte for byte. The tests replay them with the headers the servers sent that day, `content-type: application/json` and `cache-control: public, max-age=300`. The full header dumps were not committed because they carried Cloudflare cookies. These documents are public and hold nothing personal.

To re-record, run `curl -s <url> -o <file>` for each URL above and check the diff.
