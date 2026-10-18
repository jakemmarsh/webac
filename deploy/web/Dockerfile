# Static web client (docs/release-plan.md Phase 1). Build from the repo root:
#   docker build -f deploy/web/Dockerfile -t acjs-web .
# Runtime env (written to /config.json at start, read by config/RuntimeConfig.ts):
#   ACJS_BRIDGE_URL  wss:// URL of the WS→UDP bridge   (required in production)
#   ACJS_ASSET_BASE  base URL of the hosted DATs        ('' = same origin)
#   PORT             listen port (default 8080; the AWS deploy agent sets 8080)
# The official images through AWS's public mirror: Docker Hub's anonymous pull limit (429)
# failed Railway builds twice on 2026-10-09, leaving playwebac.com on the old build.
# The build stage runs on the builder's own platform (its output is platform-free JS and
# static files), so CI's x86 runner builds the arm64 image without emulating the build.
FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json vite.config.ts ./
COPY packages ./packages
COPY services ./services
# vite.config.ts imports its dev-server DAT HEAD plugin; the config must resolve to build.
COPY tools/lib/vite-head-from-stat.ts ./tools/lib/vite-head-from-stat.ts
# --ignore-scripts: the web build needs no native modules (better-sqlite3 is
# for tools/tests only).
RUN npm ci --ignore-scripts --no-audit --no-fund
# The vite build peaks near 2.7 GB. On a 2 GB host (with swap) Node's default heap
# limit, sized from physical memory, aborts it (exit 134); give it room explicitly.
ENV NODE_OPTIONS=--max-old-space-size=3584
# Update notifier build id: tools/build-push-images.sh
# passes the first 12 characters of the image's source commit as ACJS_BUILD_ID, for CI and
# tools/deploy-aws.sh deploys alike. Unset → a timestamped local build id.
ARG ACJS_BUILD_ID
RUN ACJS_BUILD_ID="$ACJS_BUILD_ID" npx vite build

FROM public.ecr.aws/docker/library/caddy:2-alpine
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY deploy/web/entrypoint.sh /usr/local/bin/acjs-entrypoint
COPY --from=build /app/dist/web /srv
# Static site files outside the bundle (the link-preview image named by index.html's og:image).
COPY deploy/web/site/ /srv/
RUN chmod +x /usr/local/bin/acjs-entrypoint
ENTRYPOINT ["/usr/local/bin/acjs-entrypoint"]
