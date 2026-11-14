# syntax=docker/dockerfile:1
#
# vid2context HTTP API with yt-dlp, deno and ffmpeg (optional whisper.cpp).
#
#   docker build -f deploy/containers/Dockerfile -t vid2context .
#   docker build -f deploy/containers/Dockerfile --build-arg WITH_WHISPER=1 -t vid2context:whisper .
#   docker run --rm -p 127.0.0.1:8787:8787 -v vid2context-data:/data vid2context
#
# Guide: docs/deploy/docker.md. Run from the repository root (the build
# context). Pinned tool versions and checksums are build args; to bump one,
# follow "Updating pinned tools" in the guide.
# deploy/containers/railway/Dockerfile is generated from this file by
# deploy/containers/railway/gen-dockerfile.sh: rerun it after every change.

ARG NODE_IMAGE=node:24.22.2-trixie-slim
ARG DEBIAN_IMAGE=debian:trixie-slim
ARG WITH_WHISPER=0

# ---------------------------------------------------------------- source
# Narrow the monorepo to the server and the workspaces it imports.
FROM ${NODE_IMAGE} AS source
COPY . /repo
RUN node /repo/deploy/containers/prune-workspaces.mjs /repo /out

# ---------------------------------------------------------------- deps
# Production dependencies only. Rebuilt only when a kept manifest or the
# lock file changes. --ignore-scripts: no dependency runs code at install.
FROM ${NODE_IMAGE} AS deps
ARG TARGETARCH
WORKDIR /app
COPY --from=source /out/manifests/ ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 # onnxruntime-node (used by the local transformers.js speech-to-text rung)
 # bundles binaries for every OS; keep only this image's platform.
 && if [ -d node_modules/onnxruntime-node/bin ]; then \
      ort_arch="$(case "$TARGETARCH" in amd64) echo x64;; arm64) echo arm64;; *) echo "$TARGETARCH";; esac)"; \
      find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 -type d ! -name linux -exec rm -rf {} +; \
      find node_modules/onnxruntime-node/bin -mindepth 3 -maxdepth 3 -type d -path '*/linux/*' ! -name "$ort_arch" -exec rm -rf {} +; \
    fi \
 # transformers.js's Node build loads onnxruntime-node and bundles the web
 # runtime it needs, so the separate onnxruntime-web package (browser only,
 # about 140 MB) is never imported on Node.
 && rm -rf node_modules/onnxruntime-web

# ---------------------------------------------------------------- app
FROM deps AS app
COPY --from=source /out/app/ ./
# Generate the node provider registry, then import it and the app once so a
# provider with a missing entry file fails the build instead of the deploy.
RUN npm run gen \
 && node --import tsx --input-type=module -e "const r = await import('/app/packages/registry/src/node.ts'); await import('/app/packages/server/src/app.ts'); console.error('import check: ' + r.providers.length + ' providers from ' + r.providerPackages.length + ' packages');"

# ---------------------------------------------------------------- tools
# yt-dlp and deno from their official GitHub releases, pinned and verified.
FROM ${DEBIAN_IMAGE} AS tools
ARG TARGETARCH
# yt-dlp: the sha256 pins the release's SHA2-256SUMS file, which in turn
# pins the binary for every architecture.
ARG YTDLP_VERSION=2026.10.26
ARG YTDLP_SUMS_SHA256=0d7ec4303a02bcbe66154d478852cdf2e07688d39dc4597316e4424ac4e74356
# deno: yt-dlp's JavaScript runtime for YouTube's player challenges.
ARG DENO_VERSION=v2.9.8
ARG DENO_SHA256_AMD64=e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609
ARG DENO_SHA256_ARM64=d49596c20b9788cf8f5d8ddf644103d4bde56ed239753f0bdb92ba9361d51905
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
# yt-dlp's unpacked ("onedir") build, not the single-file one: the single
# file unpacks shared libraries into /tmp on every run, which fails when /tmp
# is mounted noexec (docker --read-only --tmpfs /tmp) and costs startup time.
RUN case "$TARGETARCH" in \
      amd64) ytdlp_asset=yt-dlp_linux; deno_triple=x86_64-unknown-linux-gnu; deno_sha="$DENO_SHA256_AMD64";; \
      arm64) ytdlp_asset=yt-dlp_linux_aarch64; deno_triple=aarch64-unknown-linux-gnu; deno_sha="$DENO_SHA256_ARM64";; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1;; \
    esac \
 && curl -fsSLo SHA2-256SUMS "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/SHA2-256SUMS" \
 && echo "${YTDLP_SUMS_SHA256}  SHA2-256SUMS" | sha256sum -c - \
 && curl -fsSLo yt-dlp.zip "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${ytdlp_asset}.zip" \
 && awk -v a="${ytdlp_asset}.zip" '$2 == a || $2 == "*" a { print $1 "  yt-dlp.zip"; found = 1 } END { exit !found }' SHA2-256SUMS | sha256sum -c - \
 && mkdir -p /out/opt/yt-dlp /out/bin \
 && unzip -q yt-dlp.zip -d /out/opt/yt-dlp \
 && mv "/out/opt/yt-dlp/${ytdlp_asset}" /out/opt/yt-dlp/yt-dlp \
 && chmod -R a+rX,go-w /out/opt/yt-dlp \
 && curl -fsSLo deno.zip "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-${deno_triple}.zip" \
 && echo "${deno_sha}  deno.zip" | sha256sum -c - \
 && unzip -q deno.zip deno \
 && install -m 0755 deno /out/bin/deno \
 && /out/bin/deno --version \
 && /out/opt/yt-dlp/yt-dlp --version

# ---------------------------------------------------------------- whisper.cpp
# Off by default. WITH_WHISPER=1 builds whisper-cli and whisper-server from
# the official source tag. Models are never baked in: they download at run
# time into /data/models/whisper.
FROM ${DEBIAN_IMAGE} AS whisper-0
RUN mkdir -p /opt/whisper.cpp/bin

FROM ${DEBIAN_IMAGE} AS whisper-1
ARG WHISPER_CPP_VERSION=v1.9.5
ARG WHISPER_CPP_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates cmake git \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_CPP_VERSION" https://github.com/ggml-org/whisper.cpp /src \
 && test "$(git -C /src rev-parse HEAD)" = "$WHISPER_CPP_COMMIT"
WORKDIR /src
# GGML_NATIVE=OFF with CPU_ALL_VARIANTS builds one CPU backend per
# instruction set and picks the best at run time, so the image runs on any
# host of its architecture instead of only on the build machine's CPU.
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH='$ORIGIN' \
 && cmake --build build -j"$(nproc)" --target whisper-cli whisper-server \
 && mkdir -p /opt/whisper.cpp/bin \
 && cp build/bin/whisper-cli build/bin/whisper-server /opt/whisper.cpp/bin/ \
 && find build -name '*.so*' \( -type f -o -type l \) -exec cp -P {} /opt/whisper.cpp/bin/ \; \
 && printf '{"version":"%s","commit":"%s","flags":"GGML_NATIVE=OFF GGML_BACKEND_DL=ON GGML_CPU_ALL_VARIANTS=ON"}\n' \
      "$WHISPER_CPP_VERSION" "$WHISPER_CPP_COMMIT" > /opt/whisper.cpp/build.json \
 && /opt/whisper.cpp/bin/whisper-cli --help > /dev/null

FROM whisper-${WITH_WHISPER} AS whisper

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="vid2context" \
      org.opencontainers.image.description="Turn any video into context for AI agents: the vid2context HTTP API with yt-dlp, deno and ffmpeg." \
      org.opencontainers.image.source="https://github.com/nirholas/vid2context" \
      org.opencontainers.image.url="https://github.com/nirholas/vid2context" \
      org.opencontainers.image.documentation="https://github.com/nirholas/vid2context/blob/main/docs/deploy/docker.md" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

# ffmpeg for audio, tini as PID 1 (reaps yt-dlp and ffmpeg children and
# forwards signals), libgomp1 for whisper.cpp's OpenMP threads. npm,
# corepack and yarn are removed: nothing runs them at run time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgomp1 tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data \
 && chown node:node /data

COPY --from=tools /out/opt/yt-dlp/ /opt/yt-dlp/
COPY --from=tools /out/bin/ /usr/local/bin/
COPY --from=whisper /opt/whisper.cpp/ /opt/whisper.cpp/
COPY --from=app /app/ /app/
COPY deploy/containers/healthcheck.mjs /usr/local/lib/vid2context/healthcheck.mjs

# All writes go to /data (library, models, media cache, yt-dlp and deno
# caches) and /tmp, so the root filesystem can be mounted read-only.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    VID2CONTEXT_HOME=/data \
    VID2CONTEXT_PUBLIC=1 \
    VID2CONTEXT_FFMPEG_DOWNLOAD=0 \
    YTDLP_PATH=/opt/yt-dlp/yt-dlp \
    YTDLP_AUTO_UPDATE=0 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    XDG_CACHE_HOME=/data/cache \
    DENO_DIR=/data/cache/deno \
    DENO_NO_UPDATE_CHECK=1 \
    PATH=/opt/whisper.cpp/bin:/opt/yt-dlp:$PATH

WORKDIR /app
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/usr/local/lib/vid2context/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
# tsx, not bare node: Node's type stripping rejects TypeScript the code uses
# (constructor parameter properties). See docs/deploy/docker.md.
CMD ["node", "--import", "tsx", "packages/server/src/node.ts"]
