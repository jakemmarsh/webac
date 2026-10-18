# WebSocket↔UDP bridge image. Build from the REPO ROOT (the root .dockerignore
# keeps dat/, verification/, reference/ and node_modules out of the context):
#
#   docker build -f services/ws-tcp-bridge/Dockerfile -t acjs-bridge .
#
# The bridge imports no workspace package, only dependency-free files
# (packages/network/src/era1999/Packet1999.ts, the 1999 Disconnect;
# Login1999.ts, the readiness probe's tracker login; and the
# Hash32.ts Packet1999 imports; packages/shared/src/routines, the routine document
# /routines validates and exports, with the Windows-1252 encoder the export
# writes files in), so the
# build stage bundles src/bridge.ts + that file + ws (+ @aws-sdk/client-ec2) into one CommonJS file and
# the runtime image is just node + that file (no node_modules). Env vars:
# services/ws-tcp-bridge/README.md.

# The build stage runs on the builder's own platform (its output is platform-free JS and
# static files), so CI's x86 runner builds the arm64 image without emulating the build.
FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:20-slim AS build
WORKDIR /build
# Versions pinned to the repo's package-lock.json (every dependency in
# services/ws-tcp-bridge/package.json, bundled: the runtime image has no node_modules).
# @aws-sdk/client-ec2 is the per-session egress provider's (src/egress.ts); it is
# loaded only when BRIDGE_EGRESS_SERVERS turns the feature on.
RUN npm install --no-save --no-audit --no-fund esbuild@0.28.2 ws@8.22.0 @aws-sdk/client-ec2@3.1145.0
# Repo-relative layout, so src/protocol.ts's ../../../packages import resolves.
COPY services/ws-tcp-bridge/src ./services/ws-tcp-bridge/src
COPY packages/network/src/era1999/Packet1999.ts ./packages/network/src/era1999/Packet1999.ts
COPY packages/network/src/era1999/Login1999.ts ./packages/network/src/era1999/Login1999.ts
COPY packages/network/src/Hash32.ts ./packages/network/src/Hash32.ts
# The whole routines folder: a new file there is copied without editing this list.
COPY packages/shared/src/routines ./packages/shared/src/routines
COPY packages/shared/src/encoding/Windows1252.ts ./packages/shared/src/encoding/Windows1252.ts
# The hosted connector's /mcp serves the ac-agent tool table (tools/ac-agent; no Playwright in it).
COPY packages/renderer/src/agent/format.ts ./packages/renderer/src/agent/format.ts
COPY packages/renderer/src/agent/gear.ts ./packages/renderer/src/agent/gear.ts
COPY tools/ac-agent/client.ts ./tools/ac-agent/client.ts
COPY tools/ac-agent/eras.ts ./tools/ac-agent/eras.ts
COPY tools/ac-agent/hostedGuide.ts ./tools/ac-agent/hostedGuide.ts
COPY tools/ac-agent/journal.ts ./tools/ac-agent/journal.ts
COPY tools/ac-agent/mcp-server.ts ./tools/ac-agent/mcp-server.ts
COPY tools/ac-agent/routineStore.ts ./tools/ac-agent/routineStore.ts
COPY tools/ac-agent/state.ts ./tools/ac-agent/state.ts
COPY tools/ac-agent/tools.ts ./tools/ac-agent/tools.ts
RUN npx esbuild services/ws-tcp-bridge/src/bridge.ts --bundle --platform=node --target=node20 --format=cjs \
      --outfile=dist/bridge.cjs --external:bufferutil --external:utf-8-validate

FROM public.ecr.aws/docker/library/node:20-slim
ENV NODE_ENV=production \
    BRIDGE_HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /build/dist/bridge.cjs ./bridge.cjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Exec form: node is PID 1 and receives SIGTERM directly (graceful Disconnects).
CMD ["node", "bridge.cjs"]
