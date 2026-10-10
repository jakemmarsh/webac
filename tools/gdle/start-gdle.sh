#!/usr/bin/env bash
# Local vanilla GDLE 1.34 server for the GDLE compat probe (docs/gdle-compat.md).
#
#   bash tools/gdle/start-gdle.sh          # build if needed, create/start gdle-db + gdle-server
#   bash tools/gdle/start-gdle.sh stop     # stop both (containers and DB volume are kept)
#   bash tools/gdle/start-gdle.sh status   # container state + last server log lines
#   bash tools/gdle/start-gdle.sh reset    # remove both containers and the DB volume
#
# Then bridge to it (never the ACE bridge on 9090):
#   npx tsx services/ws-tcp-bridge/src/bridge.ts 9092 127.0.0.1 9110 9111
# and open  http://localhost:<vite>/?ace&bridge=ws://localhost:9092&account=<new>&password=<pw>
# (auto_create_accounts=1: the first login creates the account; lower-case names).
#
# Everything is prefixed gdle-: network gdle_net, containers gdle-db / gdle-server,
# volume gdle-db-data. It never touches ace-server / ace-db / ace_default or
# ports 9000-9003 / 3306. GDLE is x86-only (MathLib.h includes <x86intrin.h>),
# so the server runs as linux/amd64 under Docker Desktop's emulation; MariaDB
# runs natively. The EoL DATs are mounted read-only from ./dat.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DAT_DIR="${GDLE_DAT_DIR:-$REPO/dat}"
IMAGE="gdle-server:1.34"
NET="gdle_net"
DB="gdle-db"
SRV="gdle-server"
VOL="gdle-db-data"
PORT="${GDLE_PORT:-9110}"   # GDLE binds PORT and PORT+1 (UDP)
DB_IMAGE="mariadb:10.11"

cmd="${1:-start}"

exists() { docker container inspect "$1" >/dev/null 2>&1; }

case "$cmd" in
  stop)
    # GDLE shuts down (and saves) on SIGINT only; SIGTERM is ignored, so a
    # plain docker stop waits 10 s and SIGKILLs it.
    docker stop --signal SIGINT --timeout 30 "$SRV" 2>/dev/null || true
    docker stop "$DB" 2>/dev/null || true
    exit 0 ;;
  status)
    docker ps -a --filter name='^gdle-' --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
    exists "$SRV" && docker logs --tail 15 "$SRV" 2>&1 || true
    exit 0 ;;
  reset)
    docker rm -f "$SRV" "$DB" 2>/dev/null || true
    docker volume rm "$VOL" 2>/dev/null || true
    exit 0 ;;
  start) ;;
  *) echo "usage: $0 [start|stop|status|reset]" >&2; exit 2 ;;
esac

for f in client_portal.dat client_cell_1.dat; do
  [ -f "$DAT_DIR/$f" ] || { echo "missing $DAT_DIR/$f (EoL DATs; GDLE expects the Jan 2017 files)" >&2; exit 1; }
done

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE (linux/amd64, ~6 min under emulation)…"
  docker build --platform linux/amd64 -t "$IMAGE" "$HERE"
fi

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

if ! exists "$DB"; then
  # Schema init: GDLE's gdle_db.sql already contains every 1_3x migration
  # except 1_34 (gag columns); the two stored procedures are needed for saves.
  INIT="$HERE/run/initdb"
  rm -rf "$INIT"; mkdir -p "$INIT"
  tmp="$(docker create --platform linux/amd64 "$IMAGE")"
  docker cp "$tmp:/opt/gdle-sql/." "$INIT/" >/dev/null
  docker rm "$tmp" >/dev/null
  mkdir -p "$INIT/use"
  { echo 'USE gdle;'; cat "$INIT/gdle_db.sql"; } > "$INIT/use/01_gdle_db.sql"
  { echo 'USE gdle;'; cat "$INIT/1_34.sql"; } > "$INIT/use/02_1_34.sql"
  { echo 'USE gdle;'; cat "$INIT/blob_update_house.sql"; echo; } > "$INIT/use/03_blob_update_house.sql"
  { echo 'USE gdle;'; cat "$INIT/blob_update_weenie.sql"; echo; } > "$INIT/use/04_blob_update_weenie.sql"
  docker run -d --name "$DB" --network "$NET" \
    -e MARIADB_ROOT_PASSWORD=gdle -e MARIADB_DATABASE=gdle \
    -e MARIADB_USER=gdle -e MARIADB_PASSWORD=gdle \
    -v "$VOL:/var/lib/mysql" \
    -v "$INIT/use:/docker-entrypoint-initdb.d:ro" \
    "$DB_IMAGE" >/dev/null
else
  docker start "$DB" >/dev/null
fi

echo -n "waiting for $DB"
for _ in $(seq 1 90); do
  if docker exec "$DB" mariadb -ugdle -pgdle gdle -e 'SELECT 1 FROM accounts LIMIT 1' >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n .; sleep 2
done

if ! exists "$SRV"; then
  docker run -d --name "$SRV" --platform linux/amd64 --network "$NET" --stop-signal SIGINT --stop-timeout 30 \
    -p "$PORT:$PORT/udp" -p "$((PORT + 1)):$((PORT + 1))/udp" \
    -v "$HERE/server.cfg:/gdle/server.cfg:ro" \
    -v "$DAT_DIR/client_portal.dat:/gdle/Data/client_portal.dat:ro" \
    -v "$DAT_DIR/client_cell_1.dat:/gdle/Data/client_cell_1.dat:ro" \
    "$IMAGE" >/dev/null
else
  docker start "$SRV" >/dev/null
fi

echo -n "waiting for $SRV to load the world"
for _ in $(seq 1 150); do
  if docker logs "$SRV" 2>&1 | grep -q 'The server is now online'; then echo " ok"; break; fi
  if ! docker ps --filter name="^$SRV\$" --format '{{.Names}}' | grep -q .; then echo " EXITED"; docker logs --tail 40 "$SRV"; exit 1; fi
  echo -n .; sleep 2
done
docker logs "$SRV" 2>&1 | grep -v "Spawned ID" | tail -4
echo "GDLE up on udp/$PORT-$((PORT + 1)). Bridge: npx tsx services/ws-tcp-bridge/src/bridge.ts 9092 127.0.0.1 $PORT $((PORT + 1))"
