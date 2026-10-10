#!/usr/bin/env bash
# gpu-worker.sh — launchd entry for tools/gpu-worker.mjs (docs/gpu-worker.md).
# launchd gives a bare environment; tools/install-gpu-worker.sh bakes PATH.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/acjs"
mkdir -p "$LOG_DIR"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/sbin"
exec >>"$LOG_DIR/gpu-worker.log" 2>&1
cd "$REPO" || exit 1
# caffeinate -i: no idle sleep while a job runs (2026-10-03: a 3 h screen
# regression timed out when the Mac idle-slept mid-run). Closing the lid
# still sleeps the Mac; the next wake retries the job.
exec caffeinate -i node "$REPO/tools/gpu-worker.mjs" "$@"
