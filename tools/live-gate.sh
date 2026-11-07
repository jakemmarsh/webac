#!/usr/bin/env bash
# live-gate.sh — the live gate: play HEAD in every era on the local servers before it may be deployed
# (Jake, 2026-11-07, after webac#25's fix broke AC1999 pack bars and the play-through and screen
# regression tools were never run before deploys). docs/verification-workflows.md, "The live gate".
#
#   bash tools/live-gate.sh --fast             # FAST tier (every deploy): smoke + what the diff touches, all eras
#   bash tools/live-gate.sh                    # FULL tier: every step, then the full stamp for HEAD
#   bash tools/live-gate.sh --resume           # rerun only the steps that didn't pass for this HEAD (either tier)
#   bash tools/live-gate.sh --plan [--fast]    # print the steps (and the fast scope) and what each needs; start nothing
#   bash tools/live-gate.sh --steps playthrough-eor,screen-eor   # some steps only (never stamps)
#   … --base <ref>        screen-regression base + the diff the fast scope reads (default: the live web build)
#   … --expect <list>     captures this deploy is MEANT to change (screen-regression --expect)
#   … --keep-servers / --no-keep-servers   leave what this run started up for the next run (default: on for --fast)
#   … --no-gpu            headless on SwiftShader (no GPU: the cloud); also LIVE_GATE_NO_GPU=1
#   … --no-base-cache     the fast tier captures the screen-regression base afresh instead of reusing the cache
#
# The two tiers (Jake, 2026-11-07): FAST on every deploy candidate (target 15-20 min), FULL nightly (a cloud
# routine once every era's server has native provisioning; the lead until then). A deploy passes when its
# commit has a fast or a full pass (tools/lib/deploy-gate.sh live_check). A full failure never blocks a
# deploy: it is a monitor finding (tools/monitor/live-gate-full.sh), fixed the same day. Every result is also
# a git note on the commit (refs/notes/live-gate), pushed to origin, so a run made elsewhere counts here.
#
# Fast tier: tools/live-gate-scope.ts maps `git diff --name-only <base>..HEAD` to play-through steps (`--only`) and
# screen captures (SCREEN_CAPTURES) via tools/lib/live-gate-scope.ts; the smoke (enter, inventory, a short walk,
# relog; HUD + inventory + the pre-world flow) always runs, in every era. Its steps: playthrough-eor, screen-eor,
# playthrough-classicace-customdm, screen-classic-dereth (Dark Majesty: the ClassicACE play-through and the
# GDL-Classic screens), playthrough-ac1999-retail, screen-ac1999-retail. The screen steps reuse the base side
# from <git common dir>/acjs-screen-cache (screen-regression --base-cache) and capture HEAD on this run's Vite
# (--head-port); the full tier refreshes that cache (--base-cache-mode refresh).
#
# Servers: LIVE_GATE_START_EOR / _CACE / _GDL / _AC1999 replace an era's start command (other provisioning).
#
# Steps, one after another (never in parallel; one browser at a time), grouped by server so each
# server is up only while its steps run:
#   playthrough-eor                tools/ac1999-playthrough.ts --era eor                  ACE           bridge :9097
#   screen-eor                     tools/screen-regression-eras.sh --ui (ERAS=eor)        ACE           bridge :9097
#   playthrough-classicace-customdm  … --era classicace-customdm                          ClassicACE    bridge :9098
#   screen-classicace-customdm     … (ERAS=classicace-customdm)                           ClassicACE    bridge :9098
#   screen-classic-dereth          … (ERAS=classic-dereth)                                GDL-Classic   bridge :9099
#   playthrough-ac1999-retail      … --era ac1999-retail (the tool's default era)         AC1999 server bridge :9312
#   screen-ac1999-retail           … (ERAS=ac1999-retail; AC1999 lane added 2026-11-07)  AC1999 server bridge :9312
# The play-throughs run on a Vite this script starts from this checkout (HEAD); the screen regression
# starts its own two (the base build and HEAD). Accounts: the play-through's per-era defaults
# (ptrun99 / testacjs3 / agentapp99dm; LIVE_GATE_ACCOUNT_<AC1999|EOR|DM> override) and the screen
# regression's acjsregress (ACJS_ACCOUNT), each needing a character on its server.
#
# Servers and bridges: what is already up is used (a bridge on the port must be pinned to the era's
# server: its command line names the server's port, or the step fails rather than test the wrong
# server). What is down is started the documented way (docker start ace-db ace-server; the
# start-classicace.sh / start-gdl-classic.sh / start-ac1999.sh scripts from the main checkout, which
# holds dat-sets/ and reference/; bridges as `npx tsx services/ws-tcp-bridge/src/bridge.ts <port>
# 127.0.0.1 <base> <world>` with BRIDGE_ERA) and stopped again after its era's steps: only what this
# run started, by container name and by PID (never a name pattern).
#
# Machine safety: one live gate at a time (/tmp/acjs-live-gate.lock); before each step it waits while
# a vitest run holds /tmp/acjs-vitest.lock and until 8 GB is free (LIVE_GATE_MIN_FREE_GB).
#
# The stamp: only when every step of the tier passed on a clean tree (tracked files) whose HEAD didn't
# move during the run: <git common dir>/acjs-gate/<sha>.live (full) or <sha>.live-fast (fast), plus a
# line in the commit's git note refs/notes/live-gate, pushed to origin when it can be (LIVE_GATE_NO_PUSH=1
# skips; tools/lib/deploy-gate.sh live_record). A FULL failure is recorded too (<sha>.live-full-fail +
# the note): the hourly monitor reports it until a later full run passes; it does not block deploys.
# tools/deploy-web-cf.sh, tools/deploy-aws.sh and tools/build-push-images.sh run live_check, which
# prints which result let a commit through (--skip-live "<reason>" overrides, logged). On a failure it
# names the step and its report and exits 1. Logs: verification/live-gate/<sha12>[-fast]/ (gitignored):
# run.log, state.tsv (step, result, seconds, report), scope.tsv (fast), each step's log and report.
#
# Test seams (tests/verify-live-gate.ts): LIVE_GATE_RUNNER=<cmd> runs `<cmd> <step> <command…>` in
# place of each step's command; LIVE_GATE_NO_STACK=1 skips servers, bridges, Vite and the machine
# waits; LIVE_GATE_NO_LOCK=1 skips the one-at-a-time lock.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# shellcheck source=tools/lib/deploy-gate.sh
. "$ROOT/tools/lib/deploy-gate.sh"
MAIN="$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"

ALL_STEPS=(playthrough-eor screen-eor playthrough-classicace-customdm screen-classicace-customdm screen-classic-dereth playthrough-ac1999-retail screen-ac1999-retail)
FAST_STEPS=(playthrough-eor screen-eor playthrough-classicace-customdm screen-classic-dereth playthrough-ac1999-retail screen-ac1999-retail)
PLAN=0 RESUME=0 BASE_REF="" EXPECT="" ONLY="" FAST=0 KEEP_SERVERS="" NO_GPU="${LIVE_GATE_NO_GPU:-}" BASE_CACHE_ON=1
usage() { sed -n '6,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN=1; shift ;;
    --resume) RESUME=1; shift ;;
    --fast) FAST=1; shift ;;
    --keep-servers) KEEP_SERVERS=1; shift ;;
    --no-keep-servers) KEEP_SERVERS=0; shift ;;
    --no-gpu) NO_GPU=1; shift ;;
    --no-base-cache) BASE_CACHE_ON=0; shift ;;
    --base) [ $# -ge 2 ] || usage; BASE_REF="$2"; shift 2 ;;
    --expect) [ $# -ge 2 ] || usage; EXPECT="$2"; shift 2 ;;
    --steps) [ $# -ge 2 ] || usage; ONLY="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "[live-gate] unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$KEEP_SERVERS" ] || KEEP_SERVERS="$FAST"
TIER=full
[ "$FAST" = 1 ] && TIER=fast
TIER_STEPS=("${ALL_STEPS[@]}")
[ "$FAST" = 1 ] && TIER_STEPS=("${FAST_STEPS[@]}")
STEPS=("${TIER_STEPS[@]}")
if [ -n "$ONLY" ]; then
  STEPS=()
  for s in ${ONLY//,/ }; do
    case " ${ALL_STEPS[*]} " in *" $s "*) STEPS+=("$s") ;; *) echo "[live-gate] unknown step $s (have: ${ALL_STEPS[*]})" >&2; exit 2 ;; esac
  done
fi

# ── Each step's era: server containers, start/stop, bridge port and target ──
step_era() { case "$1" in playthrough-*) echo "${1#playthrough-}" ;; screen-*) echo "${1#screen-}" ;; esac; }
era_containers() { case "$1" in
  eor) echo "ace-db ace-server" ;; classicace-customdm) echo "classicace-db classicace-server" ;;
  classic-dereth) echo "gdl-classic-db gdl-classic-server" ;; ac1999-retail) echo "acjs-ac1999-db acjs-ac1999-server" ;; esac; }
era_start() { case "$1" in
  eor) echo "${LIVE_GATE_START_EOR:-docker start ace-db ace-server}" ;; classicace-customdm) echo "${LIVE_GATE_START_CACE:-bash $MAIN/tools/classicace/start-classicace.sh}" ;;
  classic-dereth) echo "${LIVE_GATE_START_GDL:-bash $MAIN/tools/gdl-classic/start-gdl-classic.sh}" ;; ac1999-retail) echo "${LIVE_GATE_START_AC1999:-bash $MAIN/tools/ac1999/start-ac1999.sh}" ;; esac; }
# port base world BRIDGE_ERA
era_bridge() { case "$1" in
  eor) echo "${LIVE_GATE_EOR_BRIDGE_PORT:-9097} 9000 9001 -" ;;
  classicace-customdm) echo "${LIVE_GATE_CACE_BRIDGE_PORT:-9098} 9200 9201 classicace-customdm" ;;
  classic-dereth) echo "${LIVE_GATE_GDL_BRIDGE_PORT:-9099} 9210 9211 classic-dereth" ;;
  ac1999-retail) echo "${LIVE_GATE_AC1999_BRIDGE_PORT:-9312} 9310 9311 ac1999-retail" ;; esac; }
era_account() { case "$1" in
  eor) echo "${LIVE_GATE_ACCOUNT_EOR:-testacjs3}" ;; classicace-customdm) echo "${LIVE_GATE_ACCOUNT_DM:-agentapp99dm}" ;; ac1999-retail) echo "${LIVE_GATE_ACCOUNT_AC1999:-ptrun99}" ;; esac; }
# The play-throughs run with --admin (the regression steps spawn their items), so the era's local
# test account must be an admin there. Local test accounts only (standing OK, memory
# agent-say-skips-chat-commands); the agent tools demote them again when they play.
ensure_admin() {
  local era="$1" acct="$2"
  [ -n "$acct" ] || return 0
  [[ "$acct" =~ ^[A-Za-z0-9_]+$ ]] || { say "ensure_admin: odd account name '$acct'"; return 1; }
  case "$era" in
    eor) docker exec ace-db mysql -uroot -p1999asheron2017 -e "update ace_auth.account set accessLevel=5 where accountName='$acct';" >/dev/null 2>&1 ;;
    classicace-customdm) docker exec classicace-db mysql -uroot -pclassicace -e "update ace_auth_customdm.account set accessLevel=5 where accountName='$acct';" >/dev/null 2>&1 ;;
    ac1999-retail) docker exec acjs-ac1999-db mariadb -uroot -pac1999root ac1999_shard_release -e "update accounts set access=6 where username='$acct';" >/dev/null 2>&1 ;;
  esac
}

# The AC1999 screen lane's account (screen-regression-eras.sh AC1999_ACCOUNT) needs a character holding a
# filled side pack and a used kit on the toolbar. The first full run (2026-11-07) found acjsrg99 with none
# on the local AC1999 server ("never entered world within 240 s", 0 characters): the step failed on setup.
# When it has no live character, make it an admin and play the pack-bars step on it once (it creates the
# character and spawns the pack, the filler and the kit), before the screen step.
screen_account() { case "$1" in ac1999-retail) echo "${AC1999_ACCOUNT:-acjsrg99}" ;; *) echo "${ACJS_ACCOUNT:-acjsregress}" ;; esac; }
ensure_screen_character() { # era port
  local era="$1" port="$2" acct n out
  [ "$era" = ac1999-retail ] || return 0
  acct="$(screen_account "$era")"
  [[ "$acct" =~ ^[A-Za-z0-9_]+$ ]] || return 0
  n="$(docker exec acjs-ac1999-db mariadb -uroot -pac1999root ac1999_shard_release -N -e \
    "select count(*) from characters c join accounts a on a.id = c.account_id where a.username = '$acct' and c.ts_deleted = 0;" 2>/dev/null | tr -d '[:space:]')"
  [ "${n:-x}" = 0 ] || return 0
  say "screen-$era: $acct has no character on the AC1999 server; preparing one (pack-bars as an admin)"
  ensure_admin "$era" "$acct" || true
  out="$RUN/screen-prep-$era"
  rm -rf "$out"
  run_cmd "screen-prep-$era" "$RUN/screen-prep-$era.log" npx tsx tools/ac1999-playthrough.ts --era "$era" --base "http://localhost:${VITE_PORT:-0}/" \
    --bridge "ws://localhost:$port" --account "$acct" --admin --only pack-bars --out "$out" $([ -n "$NO_GPU" ] && echo --swiftshader) \
    || say "screen-$era: the preparation play-through did not pass (see ${out#"$ROOT"/}/report.md); the screen step runs anyway"
}

SHA="$(git rev-parse HEAD)"
SHORT="${SHA:0:12}"
RUN="$ROOT/verification/live-gate/$SHORT$([ "$FAST" = 1 ] && echo -fast)"
SCREEN_CACHE="$(git rev-parse --path-format=absolute --git-common-dir)/acjs-screen-cache"
resolve_base() {
  [ -n "$BASE_REF" ] && { git rev-parse --verify -q "$BASE_REF^{commit}"; return; }
  local live
  live="$(curl -s -m 10 https://playwebac.com/version.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("build",""))' 2>/dev/null || true)"
  if [ -n "$live" ]; then
    git rev-parse --verify -q "$live^{commit}" 2>/dev/null && return
    git fetch -q origin 2>/dev/null; git rev-parse --verify -q "$live^{commit}" 2>/dev/null && return
  fi
  git rev-parse --verify -q origin/main
}

# The fast tier's scope (tools/live-gate-scope.ts): sets SCOPE_AREAS, SCOPE_CAPTURES, SCOPE_FILES and
# scope_steps <era>. LIVE_GATE_SCOPE_CMD replaces the command (test seam).
SCOPE_TSV=""
compute_scope() { # base
  SCOPE_TSV="$(${LIVE_GATE_SCOPE_CMD:-npx tsx tools/live-gate-scope.ts} --base "$1" --head "$SHA" --explain 2>/dev/null)" || return 1
  SCOPE_AREAS="$(scope_field areas)"; SCOPE_CAPTURES="$(scope_field captures)"; SCOPE_FILES="$(scope_field files)"
  [ -n "$SCOPE_AREAS" ] && [ -n "$(scope_steps eor)" ]
}
scope_field() { printf '%s\n' "$SCOPE_TSV" | awk -F'\t' -v k="$1" '$1 == k {print $2; exit}'; }
scope_steps() { scope_field "steps-$1"; }

if [ "$PLAN" = 1 ]; then
  echo "[live-gate] $TIER plan for $SHORT (no stamp: --plan starts nothing)"
  if [ "$FAST" = 1 ]; then
    if b="$(resolve_base)" && compute_scope "$b"; then
      echo "  scope ($SCOPE_FILES changed files since ${b:0:12}): areas $SCOPE_AREAS"
      for e in eor classicace-customdm ac1999-retail; do echo "    play-through $e --only $(scope_steps "$e")"; done
      echo "    captures: $SCOPE_CAPTURES (+ the pre-world flow; each era within its own set)"
    else echo "  scope: could not be computed (the run would stop)"; fi
  fi
  for s in "${STEPS[@]}"; do
    era="$(step_era "$s")"; read -r port base world benv <<<"$(era_bridge "$era")"
    up=1; for c in $(era_containers "$era"); do [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || up=0; done
    srv="$(era_containers "$era") $([ "$up" = 1 ] && echo '(up)' || echo "(down: would run $(era_start "$era"))")"
    br="$([ -n "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)" ] && echo "(listening: reused if pinned to $base)" || echo '(would start)')"
    echo "  $s: server $srv; bridge :$port → 127.0.0.1:$base/$world$([ "$benv" = - ] || echo " BRIDGE_ERA=$benv") $br"
  done
  echo "  screen-regression base: $(resolve_base || echo '(unresolved)')${EXPECT:+, --expect $EXPECT}"
  exit 0
fi

# ── Preconditions: a clean tree (the stamp names HEAD; the steps test the working tree) ──
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "[live-gate] the working tree has uncommitted changes to tracked files: commit or stash them first (the stamp is for HEAD, the steps test the tree)." >&2
  git status --short --untracked-files=no >&2
  exit 2
fi
# A plain `git worktree add` has no node_modules / dat / reference (all gitignored): share the main checkout's.
if [ "$MAIN" != "$ROOT" ]; then
  for rel in node_modules dat reference; do
    [ -e "$ROOT/$rel" ] || [ -L "$ROOT/$rel" ] || [ ! -e "$MAIN/$rel" ] || ln -s "$MAIN/$rel" "$ROOT/$rel"
  done
  for d in "$MAIN"/packages/*/node_modules "$MAIN"/services/*/node_modules; do
    [ -d "$d" ] || continue
    rel="${d#"$MAIN"/}"
    [ -e "$ROOT/$rel" ] || [ ! -d "$(dirname "$ROOT/$rel")" ] || ln -s "$d" "$ROOT/$rel"
  done
fi
mkdir -p "$RUN"
LOG="$RUN/run.log"
STATE="$RUN/state.tsv"
say() { echo "[live-gate] $*" | tee -a "$LOG"; }
[ "$RESUME" = 1 ] || : > "$STATE"
touch "$STATE"

# ── One live gate at a time (a dir made atomically; a dead owner's lock is taken over) ──
LOCK=/tmp/acjs-live-gate.lock
take_lock() {
  local owner
  while ! mkdir "$LOCK" 2>/dev/null; do
    owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
    say "another live gate holds $LOCK (pid ${owner:-?}); waiting"
    sleep 30
  done
  echo $$ > "$LOCK/pid"
}
[ -n "${LIVE_GATE_NO_LOCK:-}" ] || take_lock

STARTED_CONTAINERS=() STARTED_BRIDGES=() VITE_PID=""
cleanup() {
  local e c
  [ -z "$VITE_PID" ] || stop_pid_tree "$VITE_PID"
  if [ "$KEEP_SERVERS" = 1 ]; then
    # --keep-servers (the fast tier's default): the next run reuses them (pinned bridges, running containers).
    [ ${#STARTED_BRIDGES[@]} -eq 0 ] && [ ${#STARTED_CONTAINERS[@]} -eq 0 ] \
      || say "left up for the next run (--keep-servers): ${STARTED_CONTAINERS[*]+"${STARTED_CONTAINERS[*]}"} ${STARTED_BRIDGES[*]+"bridges ${STARTED_BRIDGES[*]}"}"
  else
    for e in "${STARTED_BRIDGES[@]+"${STARTED_BRIDGES[@]}"}"; do stop_pid_tree "${e#*:}"; done
    for c in "${STARTED_CONTAINERS[@]+"${STARTED_CONTAINERS[@]}"}"; do stop_container "$c"; done
  fi
  [ -n "${LIVE_GATE_NO_LOCK:-}" ] || { [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"; }
}
trap cleanup EXIT
trap 'exit 130' INT TERM

stop_container() { # GDLE (the 1999 server) saves and exits on SIGINT; ClassicACE gets 30 s
  say "stopping $1 (this run started it)"
  case "$1" in
    acjs-ac1999-server) docker stop --signal SIGINT --timeout 30 "$1" >/dev/null 2>&1 ;;
    classicace-server) docker stop --timeout 30 "$1" >/dev/null 2>&1 ;;
    *) docker stop "$1" >/dev/null 2>&1 ;;
  esac
}
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
listener_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

# Bring up an era's server; records the containers this run started.
ensure_server() {
  local era="$1" c down=()
  docker info >/dev/null 2>&1 || { say "Docker is not running"; return 1; }
  for c in $(era_containers "$era"); do running "$c" || down+=("$c"); done
  [ ${#down[@]} -eq 0 ] && { say "$era server already up ($(era_containers "$era"))"; return 0; }
  say "starting the $era server: $(era_start "$era")"
  bash -c "$(era_start "$era")" >>"$RUN/server-$era.log" 2>&1 || { say "the $era server would not start (see $RUN/server-$era.log)"; return 1; }
  STARTED_CONTAINERS+=("${down[@]}")
  if [ "$era" = eor ]; then # ACE has a health check; wait for it (5 min)
    for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' ace-server 2>/dev/null)" = healthy ] && break; sleep 5; done
    [ "$(docker inspect -f '{{.State.Health.Status}}' ace-server 2>/dev/null)" = healthy ] || { say "ace-server never became healthy"; return 1; }
  fi
  for c in $(era_containers "$era"); do running "$c" || { say "$c is not running after the start"; return 1; }; done
}

# A bridge pinned to the era's server on its port: reuse one that names the server's port, else start one.
ensure_bridge() {
  local era="$1" port base world benv pid cmd
  read -r port base world benv <<<"$(era_bridge "$era")"
  pid="$(listener_pid "$port")"
  if [ -n "$pid" ]; then
    cmd="$(ps -o command= -p "$pid" 2>/dev/null; ps -o command= -p "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" 2>/dev/null)"
    if grep -qE "bridge\.ts $port 127\.0\.0\.1 $base( |$)" <<<"$cmd"; then say "bridge :$port (pid $pid) already pinned to $base"; return 0; fi
    say "port $port is taken by pid $pid, which is not a bridge to 127.0.0.1:$base ($(head -1 <<<"$cmd" | cut -c1-120)); free it or set LIVE_GATE_*_BRIDGE_PORT"
    return 1
  fi
  if [ "$benv" = - ]; then
    say "starting a bridge :$port → 127.0.0.1:$base/$world"
    nohup npx tsx services/ws-tcp-bridge/src/bridge.ts "$port" 127.0.0.1 "$base" "$world" >>"$RUN/bridge-$era.log" 2>&1 &
  else
    say "starting a bridge :$port → 127.0.0.1:$base/$world (BRIDGE_ERA=$benv)"
    BRIDGE_ERA="$benv" nohup npx tsx services/ws-tcp-bridge/src/bridge.ts "$port" 127.0.0.1 "$base" "$world" >>"$RUN/bridge-$era.log" 2>&1 &
  fi
  STARTED_BRIDGES+=("$era:$!")
  pid=$!
  for _ in $(seq 1 60); do [ -n "$(listener_pid "$port")" ] && return 0; kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  say "the bridge on :$port did not come up (see $RUN/bridge-$era.log)"; return 1
}

# A process and every descendant (npx → tsx → node), by PID, children first.
stop_pid_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do stop_pid_tree "$c"; done; kill -TERM "$1" 2>/dev/null; }
stop_era_bridge() { # the bridge this run started for an era, once its steps are done
  local era="$1" e kept=()
  for e in "${STARTED_BRIDGES[@]+"${STARTED_BRIDGES[@]}"}"; do
    if [ "${e%%:*}" = "$era" ]; then say "stopping the $era bridge (pid ${e#*:}; this run started it)"; stop_pid_tree "${e#*:}"
    else kept+=("$e"); fi
  done
  STARTED_BRIDGES=("${kept[@]+"${kept[@]}"}")
}
stop_era_server() { # the era's containers this run started, the server before its DB
  local era="$1" c kept=()
  for c in $(era_containers "$era" | awk '{for (i = NF; i > 0; i--) print $i}'); do
    case " ${STARTED_CONTAINERS[*]+"${STARTED_CONTAINERS[*]}"} " in *" $c "*) stop_container "$c" ;; esac
  done
  for c in "${STARTED_CONTAINERS[@]+"${STARTED_CONTAINERS[@]}"}"; do
    case " $(era_containers "$era") " in *" $c "*) ;; *) kept+=("$c") ;; esac
  done
  STARTED_CONTAINERS=("${kept[@]+"${kept[@]}"}")
}

VITE_PORT=""
ensure_vite() {
  [ -n "$VITE_PORT" ] && return 0
  local p=5391
  while [ -n "$(listener_pid "$p")" ]; do p=$((p + 1)); done
  say "starting Vite on :$p (this checkout, HEAD $SHORT)"
  # No HMR reloads (tools/lib/vite-no-reload.ts): the screen steps capture HEAD on this Vite too (--head-port).
  ACJS_VITE_NO_RELOAD=1 npx vite --port "$p" --strictPort >>"$RUN/vite.log" 2>&1 &
  VITE_PID=$!
  for _ in $(seq 1 120); do
    curl -s -m 2 -o /dev/null -w '%{http_code}' "http://localhost:$p/" 2>/dev/null | grep -q 200 && { VITE_PORT=$p; return 0; }
    sleep 0.5
  done
  say "Vite did not come up on :$p (see $RUN/vite.log)"; return 1
}

# Wait while a vitest run holds the machine-wide test lock, and until there is memory to spare.
wait_machine() {
  local owner free need logged=0
  need="${LIVE_GATE_MIN_FREE_GB:-8}"
  while [ -d /tmp/acjs-vitest.lock ]; do
    owner="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' /tmp/acjs-vitest.lock/owner.json 2>/dev/null || true)"
    [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null && break
    [ "$logged" = 1 ] || { say "a vitest run holds /tmp/acjs-vitest.lock (pid ${owner:-?}); waiting"; logged=1; }
    sleep 15
  done
  for _ in $(seq 1 40); do
    free="$(vm_stat 2>/dev/null | awk '/page size of/ {ps=$8} /Pages (free|inactive|speculative|purgeable)/ {gsub(/\./,"",$NF); n+=$NF} END {if (ps) printf "%d", n*ps/1073741824; else print 99}')"
    [ "${free:-99}" -ge "$need" ] && return 0
    say "${free} GB free, waiting for ${need} GB"; sleep 15
  done
  say "still under ${need} GB free after 10 min; going on"
}

step_status() { awk -F'\t' -v s="$1" '$1==s {r=$2} END {print r}' "$STATE"; }
record() { # step result seconds report
  awk -F'\t' -v s="$1" '$1!=s' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$STATE"
}
run_cmd() { # step log cmd…
  local step="$1" log="$2"; shift 2
  if [ -n "${LIVE_GATE_RUNNER:-}" ]; then $LIVE_GATE_RUNNER "$step" "$@" >>"$log" 2>&1; return; fi
  "$@" >>"$log" 2>&1
}

BASE_SHA=""
run_step() {
  local step="$1" era t0 rc report acct args=() log="$RUN/$1.log"
  era="$(step_era "$step")"
  if [ -z "${LIVE_GATE_NO_STACK:-}" ]; then
    ensure_server "$era" && ensure_bridge "$era" || return 1
  fi
  read -r port _ <<<"$(era_bridge "$era")"
  [ -n "${LIVE_GATE_NO_STACK:-}" ] || wait_machine
  t0=$(date +%s)
  case "$step" in
    playthrough-*)
      [ -n "${LIVE_GATE_NO_STACK:-}" ] || ensure_vite || return 1
      report="$RUN/playthrough-$era"
      rm -rf "$report"
      acct="$(era_account "$era")"
      ensure_admin "$era" "$acct" || say "$step: could not make $acct an admin (the regression steps will skip their spawns)"
      args=(--era "$era" --base "http://localhost:${VITE_PORT:-0}/" --bridge "ws://localhost:$port" --out "$report" --admin)  # the regression steps spawn what they need (local admin test accounts)
      [ -n "$acct" ] && args+=(--account "$acct")
      [ "$FAST" = 1 ] && args+=(--only "$(scope_steps "$era")")
      [ -n "$NO_GPU" ] && args+=(--swiftshader)
      say "$step: npx tsx tools/ac1999-playthrough.ts ${args[*]}"
      run_cmd "$step" "$log" npx tsx tools/ac1999-playthrough.ts "${args[@]}"; rc=$?
      report="$report/report.md" ;;
    screen-*)
      [ -n "${LIVE_GATE_NO_STACK:-}" ] || ensure_vite || return 1
      [ -n "${LIVE_GATE_NO_STACK:-}" ] || ensure_screen_character "$era" "$port"
      args=(--ui --base "$BASE_SHA")
      [ -n "$EXPECT" ] && args+=(--expect "$EXPECT")
      # The base side: the fast tier reuses the cache, the full tier re-takes it and refreshes the cache.
      if [ "$FAST" = 0 ]; then args+=(--base-cache "$SCREEN_CACHE" --base-cache-mode refresh)
      elif [ "$BASE_CACHE_ON" = 1 ]; then args+=(--base-cache "$SCREEN_CACHE"); fi
      [ -n "$VITE_PORT" ] && args+=(--head-port "$VITE_PORT")
      local caps=""
      [ "$FAST" = 1 ] && caps="$SCOPE_CAPTURES"
      say "$step: ERAS=$era${caps:+ SCREEN_CAPTURES=\"$caps\"} bash tools/screen-regression-eras.sh ${args[*]}"
      report="$ROOT/verification/screen-regression$([ "$era" = eor ] || echo "-$era")/report.md"
      rm -f "$report" "$RUN/$step-report.md" # never pass off an earlier run's report as this one's
      SCREEN_CAPTURES="$caps" ERAS="$era" EOR_BRIDGE="ws://localhost:$(era_bridge eor | cut -d' ' -f1)" CACE_BRIDGE="ws://localhost:$(era_bridge classicace-customdm | cut -d' ' -f1)" \
        GDL_BRIDGE="ws://localhost:$(era_bridge classic-dereth | cut -d' ' -f1)" AC1999_BRIDGE="ws://localhost:$(era_bridge ac1999-retail | cut -d' ' -f1)" run_cmd "$step" "$log" bash tools/screen-regression-eras.sh "${args[@]}"; rc=$?
      [ -f "$report" ] && cp "$report" "$RUN/$step-report.md" && report="$RUN/$step-report.md" ;;
  esac
  record "$step" "$([ "$rc" = 0 ] && echo pass || echo fail)" "$(( $(date +%s) - t0 ))" "${report#"$ROOT"/}"
  return "$rc"
}

BASE_SHA="$(resolve_base)" || BASE_SHA=""
[ -n "$BASE_SHA" ] || { say "could not resolve the screen-regression base (pass --base <ref>)"; exit 2; }
if [ "$FAST" = 1 ]; then
  compute_scope "$BASE_SHA" || { say "could not compute the fast tier's scope (tools/live-gate-scope.ts --base ${BASE_SHA:0:12}); run the full tier or fix the scope tool"; exit 2; }
  printf '%s\n' "$SCOPE_TSV" > "$RUN/scope.tsv"
  say "fast scope: $SCOPE_FILES changed file(s) since ${BASE_SHA:0:12} → areas $SCOPE_AREAS (per file: ${RUN#"$ROOT"/}/scope.tsv)"
  for e in eor classicace-customdm ac1999-retail; do say "  play-through $e --only $(scope_steps "$e")"; done
  say "  captures: $SCOPE_CAPTURES (+ the pre-world flow; each era within its own set)"
fi
say "live gate ($TIER tier) for $SHORT; screen-regression base ${BASE_SHA:0:12}${EXPECT:+, --expect $EXPECT}; steps: ${STEPS[*]}$([ "$KEEP_SERVERS" = 1 ] && echo '; servers kept up')"
FAILED=()
prev_era=""
for s in "${STEPS[@]}"; do
  era="$(step_era "$s")"
  if [ -n "$prev_era" ] && [ "$era" != "$prev_era" ] && [ -z "${LIVE_GATE_NO_STACK:-}" ] && [ "$KEEP_SERVERS" != 1 ]; then
    stop_era_bridge "$prev_era"; stop_era_server "$prev_era"
  fi
  prev_era="$era"
  if [ "$RESUME" = 1 ] && [ "$(step_status "$s")" = pass ]; then say "$s: passed earlier for $SHORT (--resume), skipped"; continue; fi
  if run_step "$s"; then
    say "$s: PASS ($(awk -F'\t' -v s="$s" '$1==s {print $3}' "$STATE") s)"
  else
    [ -n "$(step_status "$s")" ] || record "$s" fail 0 "$RUN/run.log"
    say "$s: FAIL. Log: ${RUN#"$ROOT"/}/$s.log; report: $(awk -F'\t' -v s="$s" '$1==s {print $4}' "$STATE")"
    FAILED+=("$s")
  fi
done

lines="$(awk -F'\t' '{printf "%s %s %ss %s\n", $1, $2, $3, $4}' "$STATE")"
summary="$(printf '%s\nbase %s%s' "$lines" "${BASE_SHA:0:12}" "${EXPECT:+ expect=$EXPECT}")"
if [ ${#FAILED[@]} -gt 0 ]; then
  if [ "$TIER" = full ] && [ -z "$ONLY" ]; then
    # A full failure is recorded (stamp file + git note): the monitor reports it until a later full run
    # passes (tools/monitor/live-gate-full.sh). It does not block deploys.
    live_record "$ROOT" "$SHA" full fail "$summary"
    say "FAIL (full tier): ${FAILED[*]}; recorded (the monitor reports it until a full run passes; fix it today). Fix, commit, rerun (or --resume on the same HEAD)"
  else
    say "FAIL: ${FAILED[*]} (no stamp; fix, commit, rerun — or --resume on the same HEAD to rerun only these)"
  fi
  exit 1
fi
# Every step of the tier, all passed, same HEAD, still clean: stamp.
missing=()
for s in "${TIER_STEPS[@]}"; do [ "$(step_status "$s")" = pass ] || missing+=("$s"); done
if [ ${#missing[@]} -gt 0 ]; then
  say "PASS for the steps run; not stamped: these $TIER-tier steps have not passed on $SHORT: ${missing[*]}"
  exit 0
fi
if [ "$(git rev-parse HEAD)" != "$SHA" ] || [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "HEAD or the tracked tree changed during the run: not stamped (rerun on a quiet tree)"
  exit 1
fi
[ "$FAST" = 1 ] && summary="$(printf '%s\nscope %s' "$summary" "$SCOPE_AREAS")"
live_record "$ROOT" "$SHA" "$TIER" pass "$summary"
say "PASS: every $TIER-tier step on $SHORT; $TIER stamp written ($(live_stamp_file "$ROOT" "$SHA" "$TIER" pass)) and noted (refs/notes/live-gate): it may be deployed"
