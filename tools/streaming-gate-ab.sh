#!/bin/bash
# Interleaved portal-space gate A/B (docs/dat-streaming.md §6.12): R2's cold-edge latency swings
# by several times over an hour, so two builds only compare when their runs alternate.
#
#   BASE=<worktree>:<vite port> NEW=<worktree>:<vite port> BRIDGE=ws://localhost:<port> \
#     bash tools/streaming-gate-ab.sh <rounds> <out dir> [probe-dat-streaming args, e.g. --set <pointer url>]
#
# BASE_SET / NEW_SET (optional): a set pointer URL per side, to compare two sets on one build
# (e.g. the live pointer vs tools/stage-proxy.ts --pointer-only serving a staged one).
#
# Each run: tools/probe-dat-streaming.ts --gpu --edge-bust --req-log --teleports shoushi,holtburg, a fresh
# profile, the side's own account (abbase1 / abnew1). Never edit either worktree while it runs: Vite
# reloads the page under the probe and voids that run.
set -u
ROUNDS=$1; OUT=$2; shift 2
mkdir -p "$OUT"
for i in $(seq 1 "$ROUNDS"); do
  for side in base new; do
    spec=$([ "$side" = base ] && echo "$BASE" || echo "$NEW")
    wt=${spec%:*}; port=${spec##*:}
    set_url=$([ "$side" = base ] && echo "${BASE_SET:-}" || echo "${NEW_SET:-}")
    set_args=(); [ -n "$set_url" ] && set_args=(--set "$set_url")
    (cd "$wt" && AC_BASE="http://localhost:$port/" AC_BRIDGE="$BRIDGE" AC_ACCOUNT="ab${side}1" AC_CHAR_NAME="Ab${side}one" \
      npx tsx tools/probe-dat-streaming.ts --gpu --edge-bust --req-log --teleports shoushi,holtburg --out "$OUT/$side-$i" ${set_args[@]+"${set_args[@]}"} "$@" > "$OUT/$side-$i.log" 2>&1)
    echo "$side $i: $(grep '^gate:' "$OUT/$side-$i.log")"
  done
done
