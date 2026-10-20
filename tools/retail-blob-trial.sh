#!/usr/bin/env bash
# retail-blob-trial.sh — does the real retail client enter the world with a given
# stored PlayerModule GameplayOptions blob? (BUG.gameplay-options-entry-order,
# 2026-10-20; progress.md that day.)
#
#   bash tools/retail-blob-trial.sh <blob.hex|NULL|KEEP> <out.png> [character] [account] [slot]
#
# Sets `character.gameplay_Options` for <character> (default Obsprobe on testacjs3;
# KEEP leaves it), restarts ace-server (ACE serves characters from its biota cache,
# so a SQL edit only lands after a restart), launches retail
# (launch-retail-client-mac.sh, relaunched up to 3 times: the first launch after an
# ACE restart often fails), selects character-list slot <slot> (0-based, default 1),
# presses ENTER and captures the window 70 s later. A hanging blob shows a black
# world with empty vitals; a good one shows the world. Needs the local ACE stack and
# the Mac retail client prerequisites. Takes focus; nobody else may be in the local
# world (it restarts ACE).
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BLOB="${1:?blob.hex|NULL|KEEP}"; OUT="${2:?out.png}"
CHAR="${3:-Obsprobe}"; ACCOUNT="${4:-testacjs3}"; SLOT="${5:-1}"
D="$HOME/Library/Caches/acjs/retail-client/retail-drive"
WS=""
for d in "$HOME/Applications/Wine Stable.app" "/Applications/Wine Stable.app"; do
  [[ -x "$d/Contents/Resources/wine/bin/wineserver" ]] && WS="$d/Contents/Resources/wine/bin/wineserver" && break
done
LOG="${TMPDIR:-/tmp}/retail-blob-trial.launch.log"
mysql_shard() { docker exec ace-db sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" ace_shard -N -e '$1'" 2>/dev/null; }

[[ -n "$WS" ]] && WINEPREFIX=~/.acjs-retail "$WS" -k 2>/dev/null
# Wait for ACE to log the character out (a killed client times out).
until docker exec ace-server sh -c 'grep -h -E "LOGIN\]|LOGOUT\]" /ace/Logs/ACE_Log.txt | tail -1' | grep -q -v "entered the world"; do sleep 3; done
if [[ "$BLOB" != KEEP ]]; then
  if [[ "$BLOB" == NULL ]]; then V=NULL; else V="0x$(tr -d '[:space:]' < "$BLOB")"; fi
  mysql_shard "update \`character\` set gameplay_Options=$V where name=\"$CHAR\""
fi
docker restart ace-server >/dev/null
until docker exec ace-server sh -c 'grep -c "Starting ConnectionListener, host 0.0.0.0 port 9000" /ace/Logs/ACE_Log.txt' 2>/dev/null | grep -q -v '^0$'; do sleep 2; done
sleep 25
for _ in 1 2 3; do
  [[ -n "$WS" ]] && WINEPREFIX=~/.acjs-retail "$WS" -k 2>/dev/null; sleep 3
  AC_ACCOUNT="$ACCOUNT" AC_PASSWORD="$ACCOUNT" bash "$REPO/tools/launch-retail-client-mac.sh" >"$LOG" 2>&1
  "$D" win >/dev/null 2>&1 && grep -q running "$LOG" && break
  sleep 10
done
# Char-select (800x600 window at the screen's top-left, below the menu bar): list rows
# start at y≈253 and are ~30 px apart; ENTER is the round button.
read -r _ X Y _ _ < <("$D" win)
sleep 6; "$D" front; "$D" click $((X + 84)) $((Y + 220 + SLOT * 30)); sleep 2
"$D" front; "$D" click $((X + 344)) $((Y + 393))
T=$(( $(date +%s) + 70 )); until [ "$(date +%s)" -ge $T ]; do sleep 3; done
"$D" front; read -r _ X Y W H < <("$D" win); screencapture -x -R "$X,$Y,$W,$H" "$OUT"; sips -Z 900 "$OUT" >/dev/null
docker exec ace-server sh -c 'grep -h "LOGIN\]" /ace/Logs/ACE_Log.txt | tail -1'
