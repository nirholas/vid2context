# Integrations

Ways to use vid2context from agents and chat apps. The user guide is [docs/guides/agents.md](../docs/guides/agents.md).

```
integrations/
  install/                  one-command installer for MCP clients (Node, no dependencies beyond the repo)
    src/bin.ts              CLI entry: parse flags, run, print text or JSON
    src/clients.ts          every client: config paths per OS and scope, the entry shape, docs links and dates
    src/install.ts          plan and apply an install or uninstall; the claude CLI path for Claude Code
    src/jsonc.ts            JSON-with-comments scanner that edits one member and leaves every other byte alone
    src/toml.ts             minimal TOML reader and table editor for Codex's config.toml
    src/command.ts          which command starts the local server, and why
    src/files.ts            timestamped backup and atomic write
    src/diff.ts             line diff for --dry-run
    test/                   tests; test/fixtures/ holds real client configs (see its README)
  claude-plugin/            Claude Code plugin: the MCP server plus the vid2context skill
    .claude-plugin/plugin.json
    skills/vid2context/SKILL.md
  chatgpt/
    custom-gpt-instructions.md   custom GPT instructions, starters and Action setup
    projects.md                  zero setup: context.md in a ChatGPT or Claude Project
    src/action.ts                writes gpt-action.openapi.json for your server
```

The marketplace that lists the plugin is the repo root's [.claude-plugin/marketplace.json](../.claude-plugin/marketplace.json).

## Commands

```sh
npx tsx integrations/install/src/bin.ts list                         # supported clients and their config paths here
npx tsx integrations/install/src/bin.ts <client> [--scope user|project] [--dry-run] [--uninstall] [--json]
npx tsx integrations/install/src/bin.ts <client> --remote https://your-host/mcp --token-env V2C_TOKEN
npx tsx integrations/chatgpt/src/action.ts --server https://your-host   # writes chatgpt/gpt-action.openapi.json
```

## Checks

The root `tsconfig.json` and `vitest.config.ts` only cover `packages/*` and `providers/*`, so this folder has its own:

```sh
npx tsc -p integrations/tsconfig.json --noEmit
npx vitest run --config integrations/vitest.config.ts
LIVE=1 npx vitest run --config integrations/vitest.config.ts   # also installs through the real claude CLI (needs claude on PATH)
npx biome check integrations .claude-plugin
claude plugin validate .                                        # the marketplace and plugin
```

## Adding a client

Add an entry to `CLIENTS` in `install/src/clients.ts` only after checking the client's official docs. Record each docs URL and the date you checked it. Then add a real config from that client (written by its own CLI, or copied verbatim from its docs) to `install/test/fixtures/`, list it in the fixtures README, and add a case to `install/test/install.test.ts`.
