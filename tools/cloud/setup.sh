#!/usr/bin/env bash
# setup.sh — the one entry point that gives a cloud Claude Code session (claude.ai/code) the
# investigative tools a local session has, minus the secrets Jake adds to the environment himself.
# docs/cloud-sessions.md has every env var, the token scopes and the claude.ai settings.
#
#   bash tools/cloud/setup.sh                  # do everything that is configured, then report
#   bash tools/cloud/setup.sh --status         # report only (no network, no installs)
#   bash tools/cloud/setup.sh --session-start  # the SessionStart hook: in a cloud session, report and
#                                              # run the full setup in the background (log below)
#   bash tools/cloud/setup.sh --dat-groups eol # fewer DAT groups (default: all, ~5.2 GB)
#
# Steps, each idempotent and skipped when done: the private reference archive (ACJS_REFERENCE_URL),
# tools/provision-remote-env.sh (npm deps, pinned reference/ACE, ACViewer, the end-of-retail DATs, the
# reference-bundle branch's decomp + screenshots, derived decomp files, git hooks), the era DAT sets,
# dat/world.sqlite (built from a pinned ACE-World-16PY), the AWS CLI. Then one line per capability:
# available, or missing and which env var / step enables it. Always exits 0 unless --strict (a cloud
# environment's setup must not fail the session over an optional piece).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$here/../.." && pwd)"
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/acjs"
LOG="$CACHE_ROOT/setup.log"
# ACE-World-16PY master as of the local dat/world.sqlite build (world-db-raw/ACE-World-16PY).
ACE_WORLD_REF=8bcf8f5f3f71dde51c9ebdbacdaf553dd8308aa5
mode=full strict=0 groups="${ACJS_DAT_GROUPS:-all}"
while [ $# -gt 0 ]; do
  case "$1" in
    --status) mode=status; shift ;;
    --session-start) mode=session; shift ;;
    --strict) strict=1; shift ;;
    --dat-groups) groups="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "setup: unknown argument $1" >&2; exit 2 ;;
  esac
done
# shellcheck source=tools/lib/install-aws-cli.sh
source "$REPO/tools/lib/install-aws-cli.sh"

line() { printf '  %-22s %-9s %s\n' "$1" "$2" "$3"; }
has() { [ -n "${!1:-}" ]; }

report() {
  local live="$1"
  echo "== acjs cloud capabilities ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  # Game data
  local g st
  for g in eol ac1999 classic-dereth customdm infiltration; do
    if bash "$here/fetch-dats.sh" --status --groups "$g" >/dev/null 2>&1; then st=available; else st=missing; fi
    line "DATs: $g" "$st" "$([ "$st" = missing ] && echo "bash tools/cloud/fetch-dats.sh --groups $g (needs dats.playwebac.com reachable)")"
  done
  if [ -e "$REPO/dat-sets/classic-dereth-1.0/client_portal.dat" ]; then line "DATs: classic 1.0" available ""
  else line "DATs: classic 1.0" missing "not hosted publicly; pack-reference.sh --with-classic-1.0 + ACJS_REFERENCE_URL"; fi
  if [ -s "$REPO/dat/world.sqlite" ]; then line "world DB" available "dat/world.sqlite"
  else line "world DB" missing "bash tools/cloud/setup.sh (builds it from ACE-World-16PY)"; fi
  # References
  [ -d "$REPO/reference/ACE/Source" ] && line "reference/ACE" available "" || line "reference/ACE" missing "bash tools/provision-remote-env.sh"
  [ -d "$REPO/reference/ACViewer/ACViewer" ] && line "reference/ACViewer" available "" || line "reference/ACViewer" missing "bash tools/provision-remote-env.sh"
  [ -f "$REPO/reference/client-eol/symbols/demangled.txt" ] && line "retail decomp" available "reference/client-eol" \
    || line "retail decomp" missing "reference-bundle branch (provision-remote-env.sh) or ACJS_REFERENCE_URL"
  local p
  for p in reference/ac1999 reference/classic reference/plugin-specs dat-sets/ac1999-retail/client.exe; do
    [ -e "$REPO/$p" ] && line "$p" available "" || line "$p" missing "ACJS_REFERENCE_URL (+ ACJS_REFERENCE_AUTH_HEADER)"
  done
  # Production logs
  if has AWS_ACCESS_KEY_ID && has AWS_SECRET_ACCESS_KEY; then
    if [ "$live" = 1 ]; then
      if ! ensure_aws_cli; then line "AWS logs" missing "AWS CLI v2 could not be installed"
      elif bash "$REPO/tools/aws-logs.sh" bridge --since 2m >/dev/null 2>"$CACHE_ROOT/aws-check.err"; then line "AWS logs" available "bash tools/aws-logs.sh bridge --since 1h"
      else line "AWS logs" missing "keys set but the read failed: $(tail -c 160 "$CACHE_ROOT/aws-check.err" | tr '\n' ' ')"; fi
    else line "AWS logs" set "keys present (bash tools/aws-logs.sh bridge --since 1h)"; fi
  else line "AWS logs" missing "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (read-only webac-monitor)"; fi
  # Cloudflare (no API call here: every failed auth counts toward a lockout)
  if has CLOUDFLARE_API_TOKEN && has CLOUDFLARE_ACCOUNT_ID; then
    line "Worker web_reports" set "token present, untested (bash tools/monitor/web-reports.sh --for 30)"
  elif has CLOUDFLARE_API_TOKEN; then line "Worker web_reports" partial "add CLOUDFLARE_ACCOUNT_ID"
  else line "Worker web_reports" missing "CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (Workers Tail: Read)"; fi
  line "deploys" local-only "bridge (AWS writes) and web (wrangler deploy) stay on Jake's Mac"
}

if [ "$mode" = status ]; then mkdir -p "$CACHE_ROOT"; report 0; exit 0; fi

if [ "$mode" = session ]; then
  # Local sessions never run this; only a cloud session (CLAUDE_CODE_REMOTE=true) does.
  [ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0
  mkdir -p "$CACHE_ROOT"
  if [ -f "$CACHE_ROOT/setup.pid" ] && kill -0 "$(cat "$CACHE_ROOT/setup.pid")" 2>/dev/null; then
    echo "acjs cloud setup is already running (log: $LOG)"
  else
    nohup bash "$0" --dat-groups "$groups" > "$LOG" 2>&1 < /dev/null &
    echo $! > "$CACHE_ROOT/setup.pid"
    echo "acjs cloud setup started in the background (DATs, references, world DB, AWS CLI); log: $LOG"
    echo "Check it with: bash tools/cloud/setup.sh --status   (DAT-gated tests skip until the DATs are in)"
  fi
  report 0
  exit 0
fi

# ---- full setup ----
mkdir -p "$CACHE_ROOT"
failed=()
step() { echo; echo "== $1"; }

step "reachability"
if curl -sfI -m 15 https://dats.playwebac.com/v1/raw/eol-p2072-c982-h497-l994/client_local_English.dat >/dev/null; then echo "dats.playwebac.com: reachable"
else echo "dats.playwebac.com: NOT reachable (add it to the environment's allowed domains: docs/cloud-sessions.md)"; fi

step "private reference archive"
bash "$here/fetch-reference.sh" || failed+=("reference archive")

step "provision-remote-env.sh (npm deps, reference/ACE + ACViewer, end-of-retail DATs, decomp bundle, hooks)"
bash "$REPO/tools/provision-remote-env.sh" || failed+=("provision-remote-env.sh")

step "DAT sets ($groups)"
bash "$here/fetch-dats.sh" --groups "$groups" || failed+=("DATs")

step "world DB"
[ -L "$REPO/dat/world.sqlite" ] && [ ! -e "$REPO/dat/world.sqlite" ] && rm -f "$REPO/dat/world.sqlite"
[ -e "$REPO/dat/world.sqlite" ] || { [ -s "$CACHE_ROOT/world.sqlite" ] && mkdir -p "$REPO/dat" && ln -s "$CACHE_ROOT/world.sqlite" "$REPO/dat/world.sqlite"; }
if [ -s "$REPO/dat/world.sqlite" ]; then echo "dat/world.sqlite: ok"
elif [ ! -d "$REPO/node_modules/better-sqlite3" ]; then echo "world DB: skipped (npm deps missing)"; failed+=("world DB")
else
  src="$CACHE_ROOT/ACE-World-16PY"
  if [ ! -d "$src/Database" ]; then
    rm -rf "$src"; mkdir -p "$src"
    git -C "$src" init -q && git -C "$src" remote add origin https://github.com/ACEmulator/ACE-World-16PY.git \
      && git -C "$src" fetch -q --depth=1 origin "$ACE_WORLD_REF" && git -C "$src" checkout -q FETCH_HEAD \
      || { echo "world DB: could not fetch ACE-World-16PY $ACE_WORLD_REF"; rm -rf "$src"; }
  fi
  if [ -d "$src/Database" ]; then
    mkdir -p "$REPO/world-db-raw" "$REPO/dat"
    [ -e "$REPO/world-db-raw/ACE-World-16PY" ] || ln -s "$src" "$REPO/world-db-raw/ACE-World-16PY"
    echo "world DB: converting ACE-World-16PY $ACE_WORLD_REF → dat/world.sqlite…"
    if (cd "$REPO" && npx tsx tools/world-db-convert.ts > "$CACHE_ROOT/world-db.log" 2>&1) && [ -s "$REPO/dat/world.sqlite" ]; then
      # Kept outside the checkout so a fresh clone only re-links it.
      mv -f "$REPO/dat/world.sqlite" "$CACHE_ROOT/world.sqlite" && ln -sfn "$CACHE_ROOT/world.sqlite" "$REPO/dat/world.sqlite"
      echo "world DB: built ($(( $(wc -c < "$CACHE_ROOT/world.sqlite") >> 20 )) MB)"
    else echo "world DB: conversion failed (log: $CACHE_ROOT/world-db.log)"; failed+=("world DB"); fi
  else failed+=("world DB"); fi
fi

step "AWS CLI"
if ensure_aws_cli; then echo "aws: $(aws --version 2>&1 | cut -d' ' -f1)"; else echo "aws: could not install"; failed+=("AWS CLI"); fi

echo
report 1
if [ ${#failed[@]} -gt 0 ]; then
  echo "setup: incomplete: ${failed[*]}"
  [ "$strict" = 1 ] && exit 1
fi
exit 0
