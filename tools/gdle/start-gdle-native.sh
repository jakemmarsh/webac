#!/usr/bin/env bash
# Local vanilla GDLE 1.34 WITHOUT Docker, for cloud containers (Docker Hub
# rate-limits their pulls) and other x86_64 Linux hosts. Same server as
# tools/gdle/start-gdle.sh (same commit, same GCC 12 fix, same server.cfg
# apart from the database host), built natively and backed by the local
# MariaDB that tools/provision-ace-stack.sh installs (database `gdle`, user
# gdle/gdle; ACE's databases are untouched).
#
#   bash tools/gdle/start-gdle-native.sh          # build if needed (~10 min), create the DB, start
#   bash tools/gdle/start-gdle-native.sh stop     # SIGINT (GDLE ignores SIGTERM) and wait
#   bash tools/gdle/start-gdle-native.sh status
#   GDLE_TELEPORT=1 bash tools/gdle/start-gdle-native.sh   # with @teletown / @teleloc for probes
#
# Then: npx tsx services/ws-tcp-bridge/src/bridge.ts 9092 127.0.0.1 9110 9111
# or the agent tools with era=gdle (tools/ac-agent/eras.ts).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DAT_DIR="${GDLE_DAT_DIR:-$REPO/dat}"
# Outside the repo: CMake writes a compiler_depend.ts that tsc -b would pick up.
WORK="${GDLE_NATIVE_DIR:-$HOME/.cache/acjs-gdle-native}"
SRC="$WORK/src"
RUN="$WORK/gdle"
COMMIT=353cbab52ef7da2b7063bc3e3f008461d8531693
PIDFILE="$WORK/gdle.pid"
LOG="$WORK/gdle.log"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  stop)
    if running; then
      pid="$(cat "$PIDFILE")"; kill -INT "$pid"
      for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    fi
    rm -f "$PIDFILE"; exit 0 ;;
  status)
    running && echo "gdle running (pid $(cat "$PIDFILE"))" || echo "gdle not running"
    [ -f "$LOG" ] && grep -v "Spawned ID" "$LOG" | tail -15 || true
    exit 0 ;;
  start) ;;
  *) echo "usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac

running && { echo "gdle already running (pid $(cat "$PIDFILE"))"; exit 0; }
mkdir -p "$WORK"

if [ ! -x "$SRC/build/GDLEnhanced" ]; then
  command -v mysql_config >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q libmariadb-dev libmariadb-dev-compat build-essential cmake zlib1g-dev >/dev/null
  [ -d "$SRC/.git" ] || git clone -q https://gitlab.com/Scribble/gdlenhanced.git "$SRC"
  git -C "$SRC" checkout -q "$COMMIT"
  # GCC 12+ no longer pulls <cstring>/<strings.h> in transitively (see Dockerfile).
  grep -q -- '-include cstring' "$SRC/CMakeLists.txt" || sed -i 's|-fpermissive -w|-fpermissive -w -include cstring -include strings.h|' "$SRC/CMakeLists.txt"
  mkdir -p "$SRC/build"
  (cd "$SRC/build" && cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null && make --jobs "$(nproc)" >/dev/null)
fi

# Runtime layout, as the Dockerfile lays out /gdle: Data (DATs, cache.bin, json/)
# and lower-case data/misc, which GDLE opens by that name.
if [ ! -d "$RUN/Data" ]; then
  mkdir -p "$RUN"
  cp -r "$SRC/Bin/Data" "$RUN/Data"
  cp -r "$SRC/Data" "$RUN/data"
  cp "$SRC/Bin/GDLELogging.conf" "$RUN/"
fi
for f in client_portal.dat client_cell_1.dat; do
  [ -f "$DAT_DIR/$f" ] || { echo "missing $DAT_DIR/$f (EoL DATs)" >&2; exit 1; }
  ln -sf "$(readlink -f "$DAT_DIR/$f")" "$RUN/Data/$f"
done
# GDLE_TELEPORT=1 turns on GDLE's player teleport commands (@teletown, @teleloc) for
# probes that need to reach a vendor, a portal or a creature quickly.
sed -e 's/^database_ip=.*/database_ip=127.0.0.1/' \
    -e "s/^enable_teleport_commands=.*/enable_teleport_commands=${GDLE_TELEPORT:-0}/" "$HERE/server.cfg" > "$RUN/server.cfg"

if ! mariadb -ugdle -pgdle -h127.0.0.1 gdle -e 'SELECT 1 FROM accounts LIMIT 1' >/dev/null 2>&1; then
  sql="$SRC/Bin/sqldumps"
  mariadb -uroot -e "CREATE DATABASE IF NOT EXISTS gdle;
    CREATE USER IF NOT EXISTS 'gdle'@'localhost' IDENTIFIED BY 'gdle';
    CREATE USER IF NOT EXISTS 'gdle'@'127.0.0.1' IDENTIFIED BY 'gdle';
    GRANT ALL ON gdle.* TO 'gdle'@'localhost'; GRANT ALL ON gdle.* TO 'gdle'@'127.0.0.1'; FLUSH PRIVILEGES;"
  for f in gdle_db.sql 1_34.sql blob_update_house.sql blob_update_weenie.sql; do mariadb -uroot gdle < "$sql/$f"; done
fi

(cd "$RUN" && exec setsid "$SRC/build/GDLEnhanced" --config server.cfg < /dev/null > "$LOG" 2>&1) &
echo $! > "$PIDFILE"
echo -n "waiting for GDLE to load the world"
for _ in $(seq 1 150); do
  grep -q 'The server is now online' "$LOG" 2>/dev/null && { echo " ok"; break; }
  running || { echo " EXITED"; tail -40 "$LOG"; exit 1; }
  echo -n .; sleep 2
done
grep -v "Spawned ID" "$LOG" | tail -4
echo "GDLE up on udp/9110-9111. Bridge: npx tsx services/ws-tcp-bridge/src/bridge.ts 9092 127.0.0.1 9110 9111"
