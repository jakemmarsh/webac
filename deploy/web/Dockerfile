# Static web client (docs/release-plan.md Phase 1). Build from the repo root:
#   docker build -f deploy/web/Dockerfile -t acjs-web .
# Runtime env (written to /config.json at start, read by config/RuntimeConfig.ts):
#   ACJS_BRIDGE_URL  wss:// URL of the WS→UDP bridge   (required in production)
#   ACJS_ASSET_BASE  base URL of the hosted DATs        ('' = same origin)
#   PORT             listen port (Railway sets it; default 8080)
# The official images through AWS's public mirror: Docker Hub's anonymous pull limit (429)
# failed Railway builds twice on 2026-10-09, leaving playwebac.com on the old build.
FROM public.ecr.aws/docker/library/node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json vite.config.ts ./
COPY packages ./packages
COPY services ./services
# vite.config.ts imports its dev-server DAT HEAD plugin; the config must resolve to build.
COPY tools/lib/vite-head-from-stat.ts ./tools/lib/vite-head-from-stat.ts
# --ignore-scripts: the web build needs no native modules (better-sqlite3 is
# for tools/tests only).
RUN npm ci --ignore-scripts --no-audit --no-fund
# Update notifier build id. A GitHub-triggered Railway build (auto-deploy on
# push to main) gets the commit as RAILWAY_GIT_COMMIT_SHA, and that wins: the
# ACJS_BUILD_ID service variable is only refreshed by tools/deploy-railway.sh
# (a CLI upload, which has no git metadata) and would otherwise be stale.
# Neither set → a timestamped local build id.
ARG RAILWAY_GIT_COMMIT_SHA
ARG ACJS_BUILD_ID
RUN if [ -n "$RAILWAY_GIT_COMMIT_SHA" ]; then ACJS_BUILD_ID="$(printf '%.12s' "$RAILWAY_GIT_COMMIT_SHA")"; fi; \
    ACJS_BUILD_ID="$ACJS_BUILD_ID" npx vite build

FROM public.ecr.aws/docker/library/caddy:2-alpine
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY deploy/web/entrypoint.sh /usr/local/bin/acjs-entrypoint
COPY --from=build /app/dist/web /srv
# Static site files outside the bundle (the link-preview image named by index.html's og:image).
COPY deploy/web/site/ /srv/
RUN chmod +x /usr/local/bin/acjs-entrypoint
ENTRYPOINT ["/usr/local/bin/acjs-entrypoint"]
