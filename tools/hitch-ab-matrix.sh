#!/bin/zsh
# hitch-ab-matrix — cross-build A/B with tools/hitch-probe.ts --run (docs/perf-pass-2026-11-15.md):
# the base build's Vite and the branch's Vite, same account / bridge / production streaming set,
# real GPU, --pin-adapt, base and fix INTERLEAVED per round, for each route and throttle. One
# browser at a time (sequential). Compare afterwards with tools/hitch-ab.ts A=…-base-* B=…-fix-*.
#
# Usage: BASE_URL=http://localhost:3132/ FIX_URL=http://localhost:3131/ BRIDGE=ws://localhost:9131 \
#          ACCOUNT=testacjs3 ROUNDS=3 THROTTLES='10 6' ROUTES='academy holtburg' TAG=myfix \
#          zsh tools/hitch-ab-matrix.sh
set -u
cd "$(dirname "$0")/.."
: "${BASE_URL:?base build URL}" "${FIX_URL:?branch build URL}"
BRIDGE=${BRIDGE:-ws://localhost:9090}
ACCOUNT=${ACCOUNT:-testacjs3}
ROUNDS=${ROUNDS:-3}
THROTTLES=${THROTTLES:-10}
ROUTES=${ROUTES:-academy holtburg}
TAG=${TAG:-ab}
DATSET=${DATSET:-https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json}
q="?ace&bridge=${BRIDGE}&account=${ACCOUNT}&password=${ACCOUNT}&datSet=${DATSET}"

for th in ${=THROTTLES}; do
  for route in ${=ROUTES}; do
    for i in $(seq 1 $ROUNDS); do
      for side in base fix; do
        if [[ $side == base ]]; then url="${BASE_URL}${q}"; else url="${FIX_URL}${q}"; fi
        echo "== ${TAG} ${route} ${th}x round ${i} ${side}"
        if [[ $route == academy ]]; then
          AC_URL="$url" npx tsx tools/hitch-probe.ts --gpu --pin-adapt --throttle "$th" --stops academy \
            --start '@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0' --run 35 --steady 25 --yaw 0 \
            --tag "${TAG}-${route}${th}-${side}-${i}" 2>&1 | grep -E "^wrote|Error" || true
        else
          AC_URL="$url" npx tsx tools/hitch-probe.ts --gpu --pin-adapt --throttle "$th" --stops Holtburg \
            --run 60 --steady 20 --yaw 90 \
            --tag "${TAG}-${route}${th}-${side}-${i}" 2>&1 | grep -E "^wrote|Error" || true
        fi
      done
    done
  done
done
