#!/usr/bin/env bash
# launch-ac1999-client-mac.sh — run the real Nov 1999 retail client.exe
# ("4.35752") under native macOS Wine against the local AC1999 server
# (tools/ac1999/start-ac1999.sh), through tools/retail-client-udp-relay.mjs so
# every datagram can be captured. The reference side of the AC1999 work
# (docs/ac1999-support-scope.md, Phase 0); counterpart of
# tools/launch-retail-client-mac.sh. Setup follows AC1999's README-Client-macOS.md.
#
# Prereqs: Gcenx's Wine Stable.app (~/Applications or /Applications), Rosetta,
# the retail ISO (AC1999_ISO, default ~/Games/AC1999/AC-Retail.iso), and
# reference/ac1999 (start-ac1999.sh clones it; ZTicketC.dll comes from its
# Stubs/, standing in for the MSN Zone sign-in the client shipped with).
#
# Usage:
#   bash tools/ac1999/launch-ac1999-client-mac.sh
#   AC1999_CAPTURE=/tmp/s.jsonl bash tools/ac1999/launch-ac1999-client-mac.sh   # record the session
#   AC1999_ACCOUNT=acjs1999b bash tools/ac1999/launch-ac1999-client-mac.sh
#
# Every launch restores the pristine retail DATs (iterations 102/67) unless
# AC1999_KEEP_DATS=1, so each session runs the server's full DAT patch push and
# sessions are comparable. Accounts auto-create; "user:password" must fit 19
# characters. Opens a real window on the desktop.
# Stop: WINEPREFIX=~/.acjs-ac1999 "<wine>/bin/wineserver" -k
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WINE_APP=""
for d in "$HOME/Applications/Wine Stable.app" "/Applications/Wine Stable.app"; do
  [[ -d "$d" ]] && WINE_APP="$d" && break
done
[[ -n "$WINE_APP" ]] || { echo "[ac1999] Wine Stable.app not found (AC1999 README-Client-macOS.md step 2)" >&2; exit 1; }
WBIN="$WINE_APP/Contents/Resources/wine/bin"
export WINEPREFIX="${AC1999_WINEPREFIX:-$HOME/.acjs-ac1999}"
CACHE="$HOME/Library/Caches/acjs/ac1999-client"; mkdir -p "$CACHE"
ISO="${AC1999_ISO:-$HOME/Games/AC1999/AC-Retail.iso}"
DAT_DIR="${AC1999_DAT_DIR:-$REPO/dat-sets/ac1999-retail}"
ZTICKET="$REPO/reference/ac1999/Stubs/ZTicketC/ZTicketC.dll"
ACCOUNT="${AC1999_ACCOUNT:-acjs1999}"; PASSWORD="${AC1999_PASSWORD:-$ACCOUNT}"
SERVER_PORT="${AC1999_PORT:-9310}"
RELAY_PORT="${AC1999_RELAY_PORT:-9320}"
RES="${AC1999_RESOLUTION:-800x600}"
(( ${#ACCOUNT} + 1 + ${#PASSWORD} <= 19 )) || { echo "[ac1999] '$ACCOUNT:$PASSWORD' is over the client's 19 characters" >&2; exit 1; }
[[ -f "$ZTICKET" ]] || { echo "[ac1999] no $ZTICKET (run tools/ac1999/start-ac1999.sh first)" >&2; exit 1; }
wine() { WINEDEBUG="${WINEDEBUG:--all}" "$WBIN/wine" "$@" </dev/null; }

# --- 1. Prefix ------------------------------------------------------------------
if [[ ! -f "$WINEPREFIX/system.reg" ]]; then
  echo "[ac1999] creating prefix $WINEPREFIX..."
  wine wineboot -u >/dev/null 2>&1
  U="$WINEPREFIX/drive_c/users/$(id -un)"
  for d in Desktop Documents Downloads Music Pictures Videos; do
    [[ -L "$U/$d" ]] && rm "$U/$d" && mkdir "$U/$d"
  done
fi
GAME="$WINEPREFIX/drive_c/AsheronsCall"
if [[ ! -f "$GAME/client.exe" ]]; then
  [[ -f "$ISO" ]] || { echo "[ac1999] no retail ISO at $ISO (accpp.net archive: Asheron's Call > Game Client > ISO)" >&2; exit 1; }
  echo "[ac1999] installing from $ISO..."
  MNT="$(hdiutil attach -readonly -nobrowse "$ISO" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
  [[ -n "$MNT" ]] || { echo "[ac1999] could not mount $ISO (already attached? hdiutil info)" >&2; exit 1; }
  mkdir -p "$GAME"; cp -R "$MNT/"* "$GAME/"; chmod -R u+w "$GAME"
  hdiutil detach -quiet "$MNT"
fi
cp -f "$ZTICKET" "$GAME/ZTicketC.dll"
if [[ "${AC1999_KEEP_DATS:-0}" != 1 ]]; then
  # The server's DAT push writes into these; start every session from retail.
  cp -f "$DAT_DIR/portal.dat" "$DAT_DIR/cell.dat" "$GAME/"
fi

# --- 2. Registry (the game's keys need the 32-bit reg.exe, or the client
# silently falls back to software rendering) ----------------------------------------
KEY="HKLM\\SOFTWARE\\Microsoft\\Microsoft Games\\Asheron's Call\\1.00"
greg() { wine 'C:\windows\syswow64\reg.exe' add "$KEY" "$@" /f >/dev/null 2>&1; }
greg /v UseHardware /t REG_DWORD /d 1
greg /v Portal_Dat /t REG_SZ /d 'C:\AsheronsCall\'
greg /v ScreenWidth /t REG_DWORD /d "${RES%x*}"
greg /v ScreenHeight /t REG_DWORD /d "${RES#*x}"
reg() { wine reg add "$@" /f >/dev/null 2>&1; }
reg 'HKCU\Software\Wine\Explorer' /v Desktop /t REG_SZ /d Default
reg 'HKCU\Software\Wine\Explorer\Desktops' /v Default /t REG_SZ /d "$RES"
reg 'HKCU\Software\Wine\Direct3D' /v csmt /t REG_DWORD /d 0   # world entry locks up without this
for kv in "AllowImmovableWindows N" "CursorClippingLocksWindows N" "UseConfinementCursorClipping Y" "WindowsFloatWhenInactive Y" "RetinaMode N"; do
  set -- $kv; reg 'HKCU\Software\Wine\Mac Driver' /v "$1" /t REG_SZ /d "$2"
done

# --- 3. Relay (restarted per launch so AC1999_CAPTURE applies) + launch --------------
pkill -f "retail-client-udp-relay.mjs $RELAY_PORT " 2>/dev/null || true
RELAY_CAPTURE="${AC1999_CAPTURE:-}" nohup node "$REPO/tools/retail-client-udp-relay.mjs" "$RELAY_PORT" 127.0.0.1 "$SERVER_PORT" \
  >"$CACHE/relay.log" 2>&1 &
sleep 1
# The client faults at startup about half the time ("Exception frame is not in stack limits"
# or a page fault, 2026-10-06), in any prefix including a long-used one, so it is the 1999 exe
# under Wine + Rosetta, not our settings. It happens
# before it sends anything; relaunch (10 tries: >99.9% at 50%).
launch() {
  "$WBIN/wineserver" -k </dev/null >/dev/null 2>&1 || true; "$WBIN/wineserver" -w </dev/null >/dev/null 2>&1 || true
  local start; start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[ac1999] launching as $ACCOUNT via relay :$RELAY_PORT -> AC1999 :$SERVER_PORT${AC1999_CAPTURE:+ (capturing to $AC1999_CAPTURE)}"
  (cd "$GAME" && WINEDEBUG="${WINEDEBUG:-err+all}" "$WBIN/wine" client.exe -h 127.0.0.1 -p "$RELAY_PORT" \
    -a "$ACCOUNT:$PASSWORD" -db </dev/null >"$CACHE/client.stdout" 2>&1 &)
  local t=$SECONDS
  while (( SECONDS - t < 60 )); do
    grep -E 'Unhandled page fault|Exception frame is not in stack' "$CACHE/client.stdout" >/dev/null 2>&1 && return 2
    docker logs --since "$start" acjs-ac1999-server 2>&1 | grep -E "Client $ACCOUNT .* connected on slot" >/dev/null && return 0
    sleep 1
  done
  return 1
}
for attempt in $(seq 1 10); do
  rc=0; launch || rc=$?
  [[ $rc == 0 ]] && break
  echo "[ac1999] launch $attempt failed ($([[ $rc == 2 ]] && echo 'client crashed at startup' || echo 'no login within 60 s')); retrying"
  [[ $attempt == 10 ]] && { echo "[ac1999] giving up; see $CACHE/client.stdout" >&2; exit 1; }
done
echo "[ac1999] client log: $CACHE/client.stdout; relay log: $CACHE/relay.log; server: docker logs -f acjs-ac1999-server"
