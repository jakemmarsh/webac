#!/usr/bin/env bash
# with-gpu-lock — run one command while holding the Mac's shared live-session
# lock (~/Library/Caches/acjs/gpu.lock, "<pid> <owner>"; the protocol of
# tools/gpu-worker.mjs and tools/local-gpu-perf.sh). Waits while another live
# job holds it, so a lead's live probe never runs on top of a GPU worker job
# and the worker never starts one on top of the probe.
#
#   bash tools/with-gpu-lock.sh [--owner NAME] [--max-wait SEC] -- <command…>
#
# Default owner "lead-live", default max wait 3 h (exit 75 when exceeded).
set -uo pipefail
OWNER=lead-live
MAX_WAIT=10800
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --max-wait) MAX_WAIT="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[[ $# -gt 0 ]] || { echo "usage: with-gpu-lock.sh [--owner NAME] [--max-wait SEC] -- <command…>" >&2; exit 2; }

LOCK="$HOME/Library/Caches/acjs/gpu.lock"
mkdir -p "$(dirname "$LOCK")"

# Atomic create with the pid already inside: write a temp file, then hard-link
# it into place (link(2) fails if LOCK exists). A create-then-write leaves an
# empty file for a moment, and gpu-worker.mjs once read that as pid 0 = stale
# and deleted a held lock (2026-10-03). An empty or unreadable lock counts as
# held; only a lock whose pid is dead is stale.
TMP="$LOCK.$$"
echo "$$ $OWNER" >"$TMP"
trap 'rm -f "$TMP"' EXIT
waited=0
until ln "$TMP" "$LOCK" 2>/dev/null; do
  pid="$(cut -d' ' -f1 "$LOCK" 2>/dev/null)"
  if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then rm -f "$LOCK"; continue; fi
  (( waited % 300 == 0 )) && echo "[with-gpu-lock] waiting: $(cat "$LOCK" 2>/dev/null) holds $LOCK (${waited}s)"
  (( waited >= MAX_WAIT )) && { echo "[with-gpu-lock] gave up after ${waited}s" >&2; exit 75; }
  sleep 15; waited=$((waited + 15))
done
rm -f "$TMP"
release() { [[ "$(cut -d' ' -f1 "$LOCK" 2>/dev/null)" == "$$" ]] && rm -f "$LOCK"; return 0; }
trap release EXIT
echo "[with-gpu-lock] acquired as $OWNER after ${waited}s"
"$@"
