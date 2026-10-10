#!/usr/bin/env bash
# local-gpu-perf.sh — a REAL-GPU measure-perf run on the dev Mac, committed to
# main so the cloud loop (which only ever sees SwiftShader) has fresh real-GPU
# numbers to steer by. Meant to run unattended from launchd
# (tools/install-local-gpu-perf.sh), but safe to run by hand.
#
#   0. SKIPS (exit 0, logged) if any client is connected through the
#      ws-tcp-bridge on :9090 — checked at start and again right before
#      measuring
#   1. force-checks-out a dedicated clone-free worktree at origin/main and
#      cleans verification/perf there
#   2. brings up what's missing: Docker Desktop, ace-db + ace-server, the
#      ws-tcp-bridge on :9090, a Vite server on :3190 for that worktree
#   3. `measure-perf.ts --gpu --ratchet` (headless, ANGLE Metal; no window)
#   4. commits the JSON (verification/perf/, CI-ignored) and pushes — ONLY
#      when measure-perf exits 0. A regression (exit 2) or failure (exit 1)
#      is moved to ~/Library/Logs/acjs/gpu-perf-quarantine/ and never
#      committed: a committed regressed run would become the next baseline.
#      (The JSON also records ratchetVerdict, which findBaseline skips.)
#
# ACE allows one session per account and its `account_login_boots_in_use`
# defaults TRUE (ACE PropertyManager.cs:501; our shard's config row is empty,
# so the default holds): logging in here BOOTS a live testacjs session, and
# measure-perf then teleports +TestChar to Holtburg. Hence step 0. Why the
# bridge rather than the ACE DB is the signal: tools/local-gpu-perf-lib.sh.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tools/local-gpu-perf-lib.sh
source "$REPO/tools/local-gpu-perf-lib.sh"
WT="$REPO/.claude/worktrees/gpu-perf"
LOG_DIR="$HOME/Library/Logs/acjs"
QUARANTINE="$LOG_DIR/gpu-perf-quarantine"
BRIDGE_PORT=9090
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/gpu-perf.log" 2>&1
echo "=== $(date -u +%FT%TZ) local-gpu-perf ==="
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/sbin"

die() { echo "*** local-gpu-perf FAILED: $*"; exit 1; }

skip_if_in_use() {
  local n
  n=$(gpu_perf_bridge_sessions "$BRIDGE_PORT")
  if [[ "$n" != 0 ]]; then
    echo "SKIP ($1): $n established connection(s) on the bridge port :$BRIDGE_PORT — a client may be logged in on testacjs, and our login would boot it (account_login_boots_in_use). Not measuring."
    exit 0
  fi
}
skip_if_in_use "before start"

# One GPU job at a time on this Mac: tools/gpu-worker.mjs holds the same lock
# (~/Library/Caches/acjs/gpu.lock, "<pid> <owner>").
GPU_LOCK="$HOME/Library/Caches/acjs/gpu.lock"
mkdir -p "$(dirname "$GPU_LOCK")"
# Held = an empty lock (another taker mid-write) or one whose pid is alive.
# Take it atomically (temp file + hard link) so nobody ever sees it empty.
lock_pid="$(cut -d' ' -f1 "$GPU_LOCK" 2>/dev/null)"
if [[ -f "$GPU_LOCK" ]] && { [[ -z "$lock_pid" ]] || kill -0 "$lock_pid" 2>/dev/null; }; then
  echo "SKIP: another GPU job holds $GPU_LOCK ($(cat "$GPU_LOCK"))"
  exit 0
fi
rm -f "$GPU_LOCK"
echo "$$ local-gpu-perf" >"$GPU_LOCK.$$"
if ! ln "$GPU_LOCK.$$" "$GPU_LOCK" 2>/dev/null; then rm -f "$GPU_LOCK.$$"; echo "SKIP: lost the race for $GPU_LOCK"; exit 0; fi
rm -f "$GPU_LOCK.$$"

command -v npx >/dev/null || die "npx not on PATH ($PATH); re-run tools/install-local-gpu-perf.sh from a shell where node works"

started=()
cleanup() {
  [[ "$(cut -d' ' -f1 "$GPU_LOCK" 2>/dev/null)" == "$$" ]] && rm -f "$GPU_LOCK"
  # Subshell PIDs don't own the npx children, so match on the command lines.
  pkill -f "vite --port 3190" 2>/dev/null
  [[ " ${started[*]:-} " == *" bridge "* ]] && pkill -f "$WT/services/ws-tcp-bridge" 2>/dev/null
  return 0
}
trap cleanup EXIT

# 1. worktree at origin/main (never touches Jake's checkout). --force + clean:
# a previous run's leftovers (an unpushed commit, a stray JSON) must not leak
# into this run's baseline set or commit.
git -C "$REPO" fetch -q origin main || die "git fetch origin main"
if [[ ! -d "$WT" ]]; then
  git -C "$REPO" worktree add -q --detach "$WT" origin/main || die "git worktree add $WT"
fi
git -C "$WT" checkout -q --force --detach origin/main || die "git checkout --force origin/main in $WT"
git -C "$WT" clean -fdxq -- verification/perf || die "git clean verification/perf in $WT"
for rel in node_modules dat reference; do [[ -e "$WT/$rel" ]] || ln -s "$REPO/$rel" "$WT/$rel"; done
for d in "$REPO"/packages/*/node_modules "$REPO"/services/*/node_modules; do
  [[ -d "$d" ]] || continue; rel="${d#"$REPO"/}"; [[ -e "$WT/$rel" ]] || ln -s "$d" "$WT/$rel"
done

# 2. stack
if ! docker info >/dev/null 2>&1; then
  open -ga Docker
  for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
fi
docker start ace-db >/dev/null 2>&1
for _ in $(seq 1 60); do [[ "$(docker inspect -f '{{.State.Health.Status}}' ace-db 2>/dev/null)" == healthy ]] && break; sleep 2; done
docker start ace-server >/dev/null 2>&1
for _ in $(seq 1 90); do [[ "$(docker inspect -f '{{.State.Health.Status}}' ace-server 2>/dev/null)" == healthy ]] && break; sleep 2; done
if ! lsof -iTCP:$BRIDGE_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  (cd "$WT" && npx tsx "$WT/services/ws-tcp-bridge/src/bridge.ts" >"$LOG_DIR/gpu-perf-bridge.log" 2>&1) &
  started+=(bridge)
  sleep 4
fi
(cd "$WT" && npx vite --port 3190 --strictPort >"$LOG_DIR/gpu-perf-vite.log" 2>&1) &
for _ in $(seq 1 60); do curl -sf http://localhost:3190/ >/dev/null && break; sleep 2; done

# The stack bring-up takes minutes; someone may have logged in meanwhile.
skip_if_in_use "before measuring"

# 3. measure
cd "$WT" || die "cd $WT"
AC_URL='http://localhost:3190/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=gpuperf' \
  npx tsx tools/measure-perf.ts --gpu --ratchet
rc=$?
echo "measure-perf exit $rc"

new=$(git status --porcelain -- verification/perf | awk '{print $2}')
quarantine() {
  [[ -z "$new" ]] && return 0
  mkdir -p "$QUARANTINE"
  local f
  for f in $new; do mv -f -- "$f" "$QUARANTINE/" && echo "quarantined $QUARANTINE/$(basename "$f")"; done
}
case "$(gpu_perf_disposition "$rc")" in
  no-gpu) quarantine; die "no real GPU — not recording" ;;
  regression)
    quarantine
    echo "*** local-gpu-perf: PERF REGRESSION (measure-perf exit 2) — NOT committed; the JSON (ratchetVerdict: regression) is in $QUARANTINE"
    exit 2 ;;
  failure) quarantine; die "measure-perf exit $rc — NOT committed; any partial JSON is in $QUARANTINE" ;;
  commit) ;;
esac

# 4. commit + push the new JSON (retry on a race with the cloud loop)
[[ -z "$new" ]] && { echo "no new perf JSON"; exit 0; }
git add -- verification/perf || die "git add verification/perf"
git commit -q -m "PERF: real-GPU measure-perf run (local Mac, --gpu, $(date -u +%F)) [skip-tests]

Scheduled by tools/local-gpu-perf.sh. The cloud loop only sees SwiftShader;
this is its real-GPU reference (docs/performance-budgets.md)." || die "git commit"
for _ in 1 2 3; do
  if git push -q origin HEAD:main; then echo "pushed $(git rev-parse --short HEAD)"; exit 0; fi
  git fetch -q origin main || { echo "fetch before retry failed"; continue; }
  if ! git rebase -q origin/main; then git rebase --abort; echo "rebase onto origin/main failed"; break; fi
done
# Never lose the run silently: the next run's `checkout --force` would drop
# this detached commit, so pin it to a branch in the main repo and say so.
keep="gpu-perf-unpushed-$(date -u +%Y%m%dT%H%M%SZ)"
if git branch -f "$keep" HEAD; then
  echo "*** local-gpu-perf: PUSH FAILED — the run is committed but NOT on origin/main. Kept as branch '$keep' ($(git rev-parse --short HEAD)); push it with: git push origin $keep:main (after rebasing onto origin/main)"
else
  echo "*** local-gpu-perf: PUSH FAILED and could not create branch '$keep'; the commit is $(git rev-parse HEAD) in $WT"
fi
exit 1
