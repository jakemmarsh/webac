#!/usr/bin/env bash
# probe-impaired-network — core play through a remote player's network
# (HARNESS.bridge-network-impairment; scorecard flow-remote-network).
#
# Starts a second ws-tcp-bridge on :9091 with simulated latency / jitter / loss
# (the normal :9090 bridge stays clean for everyone else), then drives through it:
#   1. probe-two-client-social.ts  — two logins, teleports, tells, squelch,
#                                    fellowship invite + accept, trade
#   2. perf-soak.ts --stops N      — teleports, running + turning, every panel,
#                                    melee against a spawned monster, chat; its
#                                    frame/heap/DOM budgets still apply
# Logs and results go to verification/impaired-network/<profile>/.
#
#   bash tools/probe-impaired-network.sh [profile]     (run it under tools/with-gpu-lock.sh)
# Profiles (one-way, per direction; round trip = 2 × latency):
#   remote   75 ms ± 15, 2% loss   (~150 ms RTT, a cross-country player)
#   bad     150 ms ± 60, 5% loss   (~300 ms RTT with heavy reordering)
#   clean     0                    (the same probes through a clean :9091, a control)
set -uo pipefail
cd "$(dirname "$0")/.."
PROFILE="${1:-remote}"
case "$PROFILE" in
  remote) LAT=75; JIT=15; LOSS=2 ;;
  bad) LAT=150; JIT=60; LOSS=5 ;;
  clean) LAT=0; JIT=0; LOSS=0 ;;
  *) echo "unknown profile $PROFILE (remote|bad|clean)" >&2; exit 2 ;;
esac
OUT="verification/impaired-network/$PROFILE"
mkdir -p "$OUT"
STOPS="${IMPAIR_SOAK_STOPS:-3}"

BRIDGE_LATENCY_MS=$LAT BRIDGE_JITTER_MS=$JIT BRIDGE_LOSS_PCT=$LOSS BRIDGE_IMPAIR_SEED=1 \
  npx tsx services/ws-tcp-bridge/src/bridge.ts 9091 >"$OUT/bridge.log" 2>&1 &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID 2>/dev/null' EXIT
sleep 3
kill -0 $BRIDGE_PID 2>/dev/null || { echo "impaired bridge failed to start:"; cat "$OUT/bridge.log"; exit 1; }
head -8 "$OUT/bridge.log"

export AC_BRIDGE=ws://localhost:9091
status=0

echo "== two-client social ($PROFILE) =="
start=$(date +%s)
npx tsx tools/probe-two-client-social.ts >"$OUT/two-client.log" 2>&1; rc=$?
echo "rc=$rc in $(( $(date +%s) - start ))s"; grep -E "^(PASS|FAIL)|steps passed|Error" "$OUT/two-client.log"
cp verification/two-client/results.json "$OUT/two-client-results.json" 2>/dev/null
for f in verification/two-client/*.png; do [[ -f "$f" ]] && cp "$f" "$OUT/"; done
(( rc != 0 )) && status=1

echo "== session soak, $STOPS stops ($PROFILE) =="
start=$(date +%s)
AC_ACCOUNT=fxprobe3 AC_PASSWORD=fxprobe3 npx tsx tools/perf-soak.ts --stops "$STOPS" --swiftshader >"$OUT/soak.log" 2>&1; rc=$?
echo "rc=$rc in $(( $(date +%s) - start ))s"; tail -25 "$OUT/soak.log"
(( rc == 1 )) && status=1   # 2 = a perf budget breach (SwiftShader frames are meaningless), reported not failed

echo "bridge sessions:"; grep -E "connected|Closing" "$OUT/bridge.log" | tail -8
exit $status
