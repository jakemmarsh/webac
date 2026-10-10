# shellcheck shell=bash
# local-gpu-perf-lib.sh — the decisions tools/local-gpu-perf.sh makes, split
# out so tests/verify-local-gpu-perf.ts can drive them with stubbed commands.
# Source it; it defines functions only.

# gpu_perf_bridge_sessions [port]
#   Prints how many ESTABLISHED TCP sockets touch the ws-tcp-bridge port
#   (default 9090). Any non-zero count means a client is connected through the
#   bridge — i.e. a live testacjs session may exist.
#
#   Why the bridge and not the ACE DB (OPS.gpu-perf-job-safety, 2026-09-26):
#   ACE's `account_login_boots_in_use` defaults TRUE
#   (reference/ACE/Source/ACE.Server/Managers/PropertyManager.cs:501; the
#   local ace_shard.config_properties_boolean row is empty, so the default
#   holds), so our measure-perf login BOOTS whoever is on testacjs
#   (AuthenticationHandler.cs:182) and then teleports +TestChar to Holtburg.
#   The shard has no reliable "online" column: character.last_Login_Timestamp
#   is only persisted with the next player save (Player_Networking.cs:33 sets
#   it on the in-memory Character), and LogoffTimestamp (PropertyFloat 60)
#   is written only on a clean logout (Player_Database.cs:59), so a crash or
#   a server restart leaves "logged in" rows forever. Every browser client
#   reaches ACE through the bridge, so an established socket on :9090 is the
#   direct signal. Not covered: a native client talking UDP straight to ACE
#   (not how this repo's clients connect).
gpu_perf_bridge_sessions() {
  local port="${1:-9090}"
  local out
  out=$(lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED -Fn 2>/dev/null) || true
  if [[ -z "$out" ]]; then echo 0; return 0; fi
  # -Fn prints one "n<local>-><remote>" line per socket.
  local n=0 line
  while IFS= read -r line; do [[ "$line" == n* ]] && n=$((n + 1)); done <<<"$out"
  echo "$n"
}

# gpu_perf_disposition <measure-perf exit code>
#   commit     — 0: run succeeded and the ratchet passed (or had no baseline)
#   regression — 2: the ratchet found a regression; the JSON (which records
#                ratchetVerdict: "regression") is quarantined, never committed,
#                so it cannot become the next run's baseline
#   no-gpu     — 3: --gpu got a software renderer; nothing to record
#   failure    — anything else: the run crashed/timed out; quarantine
gpu_perf_disposition() {
  case "$1" in
    0) echo commit ;;
    2) echo regression ;;
    3) echo no-gpu ;;
    *) echo failure ;;
  esac
}
