#!/usr/bin/env bash
# Local GDL-Classic ("Classic Dereth", github.com/bDekaru/ClassicDereth) server
# for verifying the classic-dereth era profile (docs/dark-majesty-support.md):
# the closest public relative of Seedsow / Snowreap.
#
#   bash tools/gdl-classic/start-gdl-classic.sh          # build if needed, create/start gdl-classic-db + gdl-classic-server
#   bash tools/gdl-classic/start-gdl-classic.sh stop
#   bash tools/gdl-classic/start-gdl-classic.sh status
#   bash tools/gdl-classic/start-gdl-classic.sh reset    # remove both containers and the DB volume
#
# Then bridge to it (never the ACE bridge on 9090), telling the launcher its era:
#   BRIDGE_ERA=classic-dereth npx tsx services/ws-tcp-bridge/src/bridge.ts 9191 127.0.0.1 9210 9211
# (auto_create_accounts=1: the first login creates the account; lower-case names).
#
# Everything is prefixed gdl-classic-: network gdl_classic_net, volume
# gdl-classic-db-data, UDP 9210-9211; it never touches the ACE or GDLE
# containers. Like GDLE it is x86-only and runs as linux/amd64 under
# emulation. The Classic Dereth 1.1 portal/cell DATs (the set GDL-Classic's README
# requires; Seedsow's 2018 README links 1.0) are mounted read-only
# from dat-sets/classic-dereth-1.1 (the server compares the client's DDD
# iteration record against these exact files).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DAT_DIR="$(cd "${GDL_CLASSIC_DAT_DIR:-$REPO/dat-sets/classic-dereth-1.1}" && pwd -P)"
IMAGE="gdl-classic:0c05801"
NET="gdl_classic_net"
DB="gdl-classic-db"
SRV="gdl-classic-server"
VOL="gdl-classic-db-data"
PORT="${GDL_CLASSIC_PORT:-9210}"   # host ports; the server binds 9110/9111 inside
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
    docker ps -a --filter name='^gdl-classic-' --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
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
  [ -f "$DAT_DIR/$f" ] || { echo "missing $DAT_DIR/$f (Classic Dereth 1.1 DATs)" >&2; exit 1; }
done

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE (linux/amd64, ~6 min under emulation)…"
  docker build --platform linux/amd64 -t "$IMAGE" "$HERE"
fi

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

if ! exists "$DB"; then
  # Schema init, as GDLE: the base dump lacks only 1_34 (gag columns); the
  # two stored procedures are needed for saves.
  INIT="$HERE/run/initdb"
  rm -rf "$INIT"; mkdir -p "$INIT"
  tmp="$(docker create --platform linux/amd64 "$IMAGE")"
  docker cp "$tmp:/opt/gdl-sql/." "$INIT/" >/dev/null
  docker rm "$tmp" >/dev/null
  mkdir -p "$INIT/use"
  { echo 'USE classic_dereth;'; cat "$INIT/classic_Dereth_db.sql"; } > "$INIT/use/01_classic_dereth_db.sql"
  { echo 'USE classic_dereth;'; cat "$INIT/1_34.sql"; } > "$INIT/use/02_1_34.sql"
  { echo 'USE classic_dereth;'; cat "$INIT/blob_update_house.sql"; echo; } > "$INIT/use/03_blob_update_house.sql"
  { echo 'USE classic_dereth;'; cat "$INIT/blob_update_weenie.sql"; echo; } > "$INIT/use/04_blob_update_weenie.sql"
  docker run -d --name "$DB" --network "$NET" \
    -e MARIADB_ROOT_PASSWORD=gdle -e MARIADB_DATABASE=classic_dereth \
    -e MARIADB_USER=gdle -e MARIADB_PASSWORD=gdle \
    -v "$VOL:/var/lib/mysql" \
    -v "$INIT/use:/docker-entrypoint-initdb.d:ro" \
    "$DB_IMAGE" >/dev/null
else
  docker start "$DB" >/dev/null
fi

echo -n "waiting for $DB"
for _ in $(seq 1 90); do
  if docker exec "$DB" mariadb -ugdle -pgdle classic_dereth -e 'SELECT 1 FROM accounts LIMIT 1' >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n .; sleep 2
done

if ! exists "$SRV"; then
  docker run -d --name "$SRV" --platform linux/amd64 --network "$NET" --stop-signal SIGINT --stop-timeout 30 \
    -p "$PORT:9110/udp" -p "$((PORT + 1)):9111/udp" \
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
echo "GDL-Classic up on udp/$PORT-$((PORT + 1)). Bridge: BRIDGE_ERA=classic-dereth npx tsx services/ws-tcp-bridge/src/bridge.ts 9191 127.0.0.1 $PORT $((PORT + 1))"
