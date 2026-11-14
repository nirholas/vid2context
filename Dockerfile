# vid2context MCP server (stdio). Used by Glama's build check and the Docker MCP Catalog:
#   docker build -t vid2context-mcp . && docker run -i --rm vid2context-mcp
# Pass optional keys with -e, for example -e GROQ_API_KEY=... The full server image
# (HTTP API, yt-dlp, ffmpeg) is a separate deploy, see docs/ROADMAP.md item 49.
FROM node:22-slim AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund && npm run build:npm

FROM node:22-slim
ENV NODE_ENV=production
COPY --from=build /src/packages/discovery/dist/npm/vid2context-mcp /opt/vid2context-mcp
USER node
WORKDIR /home/node
ENTRYPOINT ["node", "/opt/vid2context-mcp/dist/vid2context-mcp.mjs"]
