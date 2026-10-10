# WebSocket↔UDP bridge image. Build from the REPO ROOT (the root .dockerignore
# keeps dat/, verification/, reference/ and node_modules out of the context):
#
#   docker build -f services/ws-tcp-bridge/Dockerfile -t acjs-bridge .
#
# The bridge imports no workspace package, only dependency-free files
# (packages/network/src/era1999/Packet1999.ts, the 1999 Disconnect, and the
# Hash32.ts it imports; packages/shared/src/routines, the routine document
# /routines validates), so the
# build stage bundles src/bridge.ts + that file + ws into one CommonJS file and
# the runtime image is just node + that file (no node_modules). Env vars:
# services/ws-tcp-bridge/README.md.

FROM public.ecr.aws/docker/library/node:20-slim AS build
WORKDIR /build
# Versions pinned to the repo's package-lock.json.
RUN npm install --no-save --no-audit --no-fund esbuild@0.28.2 ws@8.22.0
# Repo-relative layout, so src/protocol.ts's ../../../packages import resolves.
COPY services/ws-tcp-bridge/src ./services/ws-tcp-bridge/src
COPY packages/network/src/era1999/Packet1999.ts ./packages/network/src/era1999/Packet1999.ts
COPY packages/network/src/Hash32.ts ./packages/network/src/Hash32.ts
COPY packages/shared/src/routines/index.ts ./packages/shared/src/routines/index.ts
COPY packages/shared/src/routines/RoutineDoc.ts ./packages/shared/src/routines/RoutineDoc.ts
COPY packages/shared/src/routines/validateRoutine.ts ./packages/shared/src/routines/validateRoutine.ts
COPY packages/shared/src/routines/exampleProfile.ts ./packages/shared/src/routines/exampleProfile.ts
COPY packages/shared/src/routines/vtank.ts ./packages/shared/src/routines/vtank.ts
COPY packages/shared/src/routines/vtankExpr.ts ./packages/shared/src/routines/vtankExpr.ts
COPY packages/shared/src/routines/vtankOptions.ts ./packages/shared/src/routines/vtankOptions.ts
COPY packages/shared/src/routines/vtankProfile.ts ./packages/shared/src/routines/vtankProfile.ts
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
