#!/usr/bin/env bash
# capture-ac1999-session.sh — record one scripted session of the REAL 1999
# client against the local AC1999 server: login → Quick Character (named
# $AC1999_CHAR) → enter world → walk / turn / jump → exit to char select → quit.
# Every datagram both ways lands in OUT (relay JSONL, gzipped):
#   {"t": ms, "d": "c2s"|"s2c", "c": "addr:port", "p": 0, "b": base64}
# This is the 1999 counterpart of tests/fixtures/ac-session-001.bin and the
# golden source for the 1999 transport and wire adapter
# (docs/ac1999-support-scope.md Phases 3–4; findings in docs/ac1999-support.md).
#
#   bash tools/ac1999/start-ac1999.sh        # first
#   bash tools/ac1999/capture-ac1999-session.sh tests/fixtures/ac1999-session-001.jsonl.gz
#
# Takes focus for about 90 s. Don't click other windows while it runs: under
# Wine on macOS the client minimises when it loses focus and its 3D view stays
# black afterwards (the session itself is unaffected). Click coordinates are
# the 1999 client's fixed 800x600 pre-world and in-world layout. Chat isn't
# driven: the 1999 chat line ignores injected keystrokes (they reach the
# game's key bindings instead).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: $0 <out.jsonl.gz>}"
# A fresh account and character per capture (accounts auto-create; names must be
# unique per server; "user:password" must fit the client's 19 characters).
SUFFIX="$(LC_ALL=C tr -dc 'a-z' </dev/urandom | head -c 4 || true)"  # tr exits on SIGPIPE
ACCOUNT="${AC1999_ACCOUNT:-acjs$SUFFIX}"
CHAR="${AC1999_CHAR:-Acjs$SUFFIX}"
DRIVE="$HOME/Library/Caches/acjs/retail-client/retail-drive"
if [[ ! -x "$DRIVE" || "$REPO/tools/retail-drive-mac.swift" -nt "$DRIVE" ]]; then
  mkdir -p "$(dirname "$DRIVE")"; swiftc -O "$REPO/tools/retail-drive-mac.swift" -o "$DRIVE"
fi
WBIN="$HOME/Applications/Wine Stable.app/Contents/Resources/wine/bin"
[[ -d "$WBIN" ]] || WBIN="/Applications/Wine Stable.app/Contents/Resources/wine/bin"
SRV=acjs-ac1999-server
RAW="$(mktemp -t ac1999-capture).jsonl"; rm -f "$RAW"

server_log() { docker logs --since "$1" "$SRV" 2>&1; }
wait_log() { # since pattern timeout_s
  local t=$SECONDS
  until server_log "$1" | grep -E "$2" >/dev/null; do   # not -q: an early exit SIGPIPEs docker logs, and pipefail fails the test
    (( SECONDS - t > $3 )) && { echo "[capture] timed out waiting for: $2" >&2; return 1; }
    sleep 1
  done
}
log() { echo "[capture] $*" >&2; }
xy() { read -r _ X Y _ _ < <("$DRIVE" win); }
front() { # the driver refuses input unless the client is frontmost; a click elsewhere minimises it
  local i; for i in 1 2 3 4 5; do "$DRIVE" front >/dev/null 2>&1 && return 0; sleep 1; done
  log "could not bring the client to the front"; return 1
}
click() { front; xy; "$DRIVE" click $((X + $1)) $((Y + $2)) || { log "click $1,$2 refused"; return 1; }; sleep 0.5; }
TMPD="$(mktemp -d -t ac1999-cap)"
SHOTS="${AC1999_CAPTURE_SHOTS:-}"; STEP=0
shot() { # AC1999_CAPTURE_SHOTS=<dir>: a full-window screenshot per step, for debugging the driver
  [[ -n "$SHOTS" ]] || return 0
  mkdir -p "$SHOTS"; STEP=$((STEP + 1)); front; xy
  screencapture -x -R "$X,$Y,800,600" "$SHOTS/$(printf %02d $STEP)-$1.png"
}
region() { # x y w h out — a window-relative screen region (the client must be in front)
  xy; screencapture -x -R "$((X + $1)),$((Y + $2)),$3,$4" "$5"
}
# Click until a static region changes: the first click after the window comes to
# the front can be eaten (Wine activation), and the char-select smoke animates,
# so only a region without animation tells whether the screen moved on.
click_until_changed() { # cx cy rx ry rw rh
  local i t
  for i in 1 2 3 4; do
    # The baseline must be settled: right after login the char-select art is still fading in,
    # and any later frame "differs" from a mid-fade one even when the click was eaten.
    front; region "$3" "$4" "$5" "$6" "$TMPD/before.png"
    t=$SECONDS
    while (( SECONDS - t < 10 )); do
      sleep 0.5; region "$3" "$4" "$5" "$6" "$TMPD/again.png"
      cmp -s "$TMPD/before.png" "$TMPD/again.png" && break
      mv "$TMPD/again.png" "$TMPD/before.png"
    done
    click "$1" "$2"
    t=$SECONDS
    while (( SECONDS - t < 6 )); do
      region "$3" "$4" "$5" "$6" "$TMPD/after.png"
      cmp -s "$TMPD/before.png" "$TMPD/after.png" || return 0
      sleep 1
    done
    log "click $1,$2 changed nothing (try $i)"
  done
  return 1
}
letters() { # A name as key names: first letter shifted, the rest lower case.
  local s="$1" out=() i c
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"; local u; u="$(tr '[:lower:]' '[:upper:]' <<<"$c")"
    if [[ $i -eq 0 ]]; then out+=("Shift+Key$u"); else out+=("Key$u"); fi
  done
  echo "${out[@]}"
}

START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
AC1999_CAPTURE="$RAW" AC1999_ACCOUNT="$ACCOUNT" bash "$REPO/tools/ac1999/launch-ac1999-client-mac.sh"
wait_log "$START" "CharSelect +\\( $ACCOUNT \\)" 90
until "$DRIVE" win >/dev/null 2>&1; do sleep 1; done
sleep 5   # char-select art finishes loading before it takes clicks
log "at char select as $ACCOUNT; creating $CHAR"

click_until_changed 512 175 280 5 240 45        # Quick Character (the title text changes; the ring at top right animates)
sleep 4                                         # the name screen fades in; earlier clicks miss the field
shot name-screen
click 450 194                                   # focus the name field ("Enter name")
sleep 1
front; "$DRIVE" key End $(printf 'Delete %.0s' {1..4}) $(printf 'Backspace %.0s' {1..12}) $(letters "$CHAR")
shot named
click 705 560                                   # Done
shot done
wait_log "$START" "0xF643 entry form" 20        # CharacterCreateResponse sent
log "created; entering the world"
sleep 2
click 60 145                                    # select the first character in the list
click 308 174                                   # Enter Game
wait_log "$START" "inner= 0xA1 +\\( LOGIN_COMPLETE \\)" 90
log "in world; moving"
sleep 4
front
"$DRIVE" seq '[[0,"down","KeyW"],[2500,"up","KeyW"],[2700,"down","KeyA"],[3700,"up","KeyA"],[3900,"down","KeyW"],[5400,"up","KeyW"],[5600,"down","Space"],[6400,"up","Space"]]' >/dev/null
sleep 3
click 785 12                                    # exit (top-right X)
sleep 1
click 580 478                                   # Yes
wait_log "$START" "InWorld +-> +CharSelect" 30
sleep 2
WINEPREFIX="${AC1999_WINEPREFIX:-$HOME/.acjs-ac1999}" "$WBIN/wineserver" -k || true
sleep 1
pkill -f "retail-client-udp-relay.mjs ${AC1999_RELAY_PORT:-9320} " || true
gzip -9 -c "$RAW" > "$OUT"
echo "[capture] $(wc -l < "$RAW" | tr -d ' ') datagrams -> $OUT ($(du -h "$OUT" | cut -f1))"
rm -rf "$RAW" "$TMPD"
