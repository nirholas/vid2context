# @vid2context/discovery

Makes vid2context findable: builds the publishable npm packages and generates the registry and directory manifests. Private; not published itself.

```sh
npm run build:npm       # bundle vid2context-mcp and vid2context into dist/npm/
npm run discovery:gen   # write server.json, glama.json, gemini-extension.json, context7.json, llms-install.md
npm run discovery:logo  # render assets/logo.png from assets/logo.svg
```

- `src/meta.ts`: the facts every surface repeats (names, descriptions, keywords, optional keys). Change them here.
- `src/manifests.ts`: one function per manifest, plus the npm READMEs.
- `src/install.ts`: install commands and one-click links for each MCP client.
- `src/npm.ts`: esbuild bundling, the published `package.json`, third-party license notices.

Tests rebuild the bundles and talk to the MCP server over stdio with the official SDK client, and fail when a committed manifest or the README install section drifts from the generator. Release steps and directory submissions: [docs/guides/discovery.md](../../docs/guides/discovery.md).
