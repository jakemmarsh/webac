#!/usr/bin/env bash
# Local AC1999 server (gitlab.com/adamplumb/ac1999, a Seedsow/GDLE fork that
# drives the Nov 1999 retail client) for the AC1999 work
# (docs/ac1999-support-scope.md, Phase 0).
#
#   bash tools/ac1999/start-ac1999.sh          # clone/build if needed, create/start acjs-ac1999-db + acjs-ac1999-server
#   bash tools/ac1999/start-ac1999.sh stop
#   bash tools/ac1999/start-ac1999.sh status
#   bash tools/ac1999/start-ac1999.sh reset    # remove both containers and the DB volume (world re-imports next start)
#
# Speaks the 1999 protocol on ONE UDP port: host 9310 -> container 9110. The
# real 1999 client: tools/ac1999/launch-ac1999-client-mac.sh. Accounts are
# auto-created on first login (auto_create_accounts=1); user:password must fit
# the client's 20-byte field.
#
# Everything is prefixed acjs-ac1999-: network acjs_ac1999_net, volume
# acjs-ac1999-db-data, DB on 127.0.0.1:3308 (for the world import tool). It
# Logs: docker logs acjs-ac1999-server. It never touches the ACE / ClassicACE / GDL containers, nor an ac1999-db that a
# personal AC1999 checkout runs (that one is on 3307).
#
# Source: reference/ac1999 (gitignored), pinned to AC1999_COMMIT. The server
# is AGPL-3.0 (Server/LICENSE); the rest of that repo is unlicensed, so it is
# reference only and nothing from it is copied into ours. The server builds
# natively for the host arch from tools/ac1999/Dockerfile (Debian; the
# upstream Alpine one no longer compiles, see that file) in ~5 min.
#
# DATs: the pristine retail portal.dat/cell.dat (iterations 102/67) from
# dat-sets/ac1999-retail (copied off the retail ISO; docs/ac1999-support.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
COMMIT="${AC1999_COMMIT:-4bdbcc910024c2e3d0421030f5c4e22c620c4686}"
SRC="$REPO/reference/ac1999"
DAT_DIR="${AC1999_DAT_DIR:-$REPO/dat-sets/ac1999-retail}"
NET="acjs_ac1999_net"
DB="acjs-ac1999-db"
SRV="acjs-ac1999-server"
VOL="acjs-ac1999-db-data"
PORT="${AC1999_PORT:-9310}"
DB_PORT="${AC1999_DB_PORT:-3308}"
DB_IMAGE="mariadb:11.4"

cmd="${1:-start}"
exists() { docker container inspect "$1" >/dev/null 2>&1; }

case "$cmd" in
  stop)
    # GDLE shuts down (and saves) on SIGINT; SIGTERM is ignored.
    docker stop --signal SIGINT --timeout 30 "$SRV" 2>/dev/null || true
    docker stop "$DB" 2>/dev/null || true
    exit 0 ;;
  status)
    docker ps -a --filter name='^acjs-ac1999-' --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
    exists "$SRV" && docker logs --tail 8 "$SRV" 2>&1 || true
    exit 0 ;;
  reset)
    docker rm -f "$SRV" "$DB" 2>/dev/null || true
    docker volume rm "$VOL" 2>/dev/null || true
    exit 0 ;;
  start) ;;
  *) echo "usage: $0 [start|stop|status|reset]" >&2; exit 2 ;;
esac

for f in portal.dat cell.dat; do
  [ -f "$DAT_DIR/$f" ] || { echo "missing $DAT_DIR/$f (the 1999 retail DATs; docs/ac1999-support.md)" >&2; exit 1; }
done

# --- source, pinned ---------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  echo "cloning AC1999 @ ${COMMIT:0:10} into reference/ac1999…"
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://gitlab.com/adamplumb/ac1999.git
fi
if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" != "$COMMIT" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$COMMIT"
  git -C "$SRC" checkout -q --detach FETCH_HEAD
fi
SHORT="${COMMIT:0:8}"
IMAGE="acjs-ac1999:$SHORT"
BIN="$SRC/Server/Bin"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE (native arch, ~5 min)…"
  docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$SRC/Server"
fi

# --- run directory (the server's Bin/, mounted at /gdle) ---------------------
DATA="$BIN/ServerModes/Release/Data"
mkdir -p "$DATA"
for f in portal.dat cell.dat; do
  # Copy, not symlink: the link would not resolve inside the container. cmp
  # keeps a re-run from recopying 145 MB.
  cmp -s "$DAT_DIR/$f" "$DATA/$f" 2>/dev/null || cp "$DAT_DIR/$f" "$DATA/$f"
done
sed -e "s/^database_host=.*/database_host=$DB/" \
    -e "s/^database_port=.*/database_port=3306/" \
    -e "s/^bind_port=.*/bind_port=9110/" \
    -e "s/^auto_create_accounts=.*/auto_create_accounts=1/" \
    "$BIN/server.cfg.example" > "$BIN/server.cfg"

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

# --- database ---------------------------------------------------------------
fresh_db=0
if ! exists "$DB"; then
  docker run -d --name "$DB" --network "$NET" \
    -e MARIADB_ROOT_PASSWORD=ac1999root -e MARIADB_DATABASE=ac1999_world_release \
    -e MARIADB_USER=ac1999 -e MARIADB_PASSWORD=ac1999 \
    -v "$VOL:/var/lib/mysql" \
    -v "$SRC/deploy/db/my.cnf:/etc/mysql/conf.d/ac1999.cnf:ro" \
    -v "$SRC/deploy/db/init:/docker-entrypoint-initdb.d:ro" \
    -p "127.0.0.1:$DB_PORT:3306" \
    "$DB_IMAGE" >/dev/null
  fresh_db=1
else
  docker start "$DB" >/dev/null
fi

echo -n "waiting for $DB"
for _ in $(seq 1 90); do
  # The init phase runs a socket-only server; wait for the TCP one.
  if docker exec "$DB" mariadb -h127.0.0.1 -uac1999 -pac1999 ac1999_world_release -e 'SELECT 1' >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n .; sleep 2
done

weenies="$(docker exec "$DB" mariadb -h127.0.0.1 -uac1999 -pac1999 ac1999_world_release -N -e 'SELECT COUNT(*) FROM weenie' 2>/dev/null || echo 0)"
if [ "$fresh_db" = 1 ] || [ "${weenies:-0}" = 0 ]; then
  # The world tools need PyMySQL; a venv inside the (gitignored) clone keeps it off the system Python.
  VENV="$SRC/.venv"
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install -q pymysql; }
  echo "importing the AC1999 world (Server/Database/AC1999-World)…"
  AC1999_DB_HOST=127.0.0.1 AC1999_DB_PORT="$DB_PORT" AC1999_DB_USER=ac1999 AC1999_DB_PASSWORD=ac1999 \
    AC1999_DB_SCHEMA=ac1999_world_release \
    "$VENV/bin/python" -I "$SRC/Server/tools/world_db/import_sql.py" --fresh
fi

# --- server -----------------------------------------------------------------
# /Database: the server creates its shard tables from ../Database/AC1999-Shard (relative to /gdle).
# servernews.txt / motd.txt: ours, not upstream's unlicensed text, because captures of this
# server (tests/fixtures/ac1999-session-*.jsonl.gz) are committed and carry the news bytes.
if exists "$SRV" && [ "$(docker inspect -f '{{.Config.Image}}' "$SRV")" != "$IMAGE" ]; then
  docker rm -f "$SRV" >/dev/null   # pin moved: recreate on the new image
fi
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! exists "$SRV"; then
  docker run -d --name "$SRV" --network "$NET" --stop-signal SIGINT --stop-timeout 30 \
    -p "$PORT:9110/udp" \
    -v "$BIN:/gdle" \
    -v "$SRC/Server/Database:/Database:ro" \
    -v "$HERE/servernews.txt:/gdle/Data/servernews.txt:ro" \
    -v "$HERE/motd.txt:/gdle/Data/motd.txt:ro" \
    "$IMAGE" >/dev/null
else
  docker start "$SRV" >/dev/null
fi

echo -n "waiting for $SRV to load the world"
for _ in $(seq 1 150); do
  # Logs go to stdout (upstream's start-server.sh tees them into server.log); only this start's count.
  if docker logs --since "$since" "$SRV" 2>&1 | grep -q 'The server is now online'; then echo " ok"; break; fi
  if ! docker ps --filter name="^$SRV\$" --format '{{.Names}}' | grep -q .; then echo " EXITED"; docker logs --tail 40 "$SRV"; exit 1; fi
  echo -n .; sleep 2
done
echo "AC1999 up on udp/$PORT (1999 protocol, one port). Real client: bash tools/ac1999/launch-ac1999-client-mac.sh"
