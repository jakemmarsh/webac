#!/usr/bin/env bash
# Local ClassicACE server for verifying the classicace-customdm (default) and
# classicace-infiltration era profiles (docs/dark-majesty-support.md).
#
#   bash tools/classicace/start-classicace.sh          # build if needed, create/start classicace-db + classicace-server
#   CLASSICACE_RULESET=Infiltration bash tools/classicace/start-classicace.sh
#                                                      # a second instance: classicace-infiltration-db/-server, UDP 9220-9221
#   bash tools/classicace/start-classicace.sh stop
#   bash tools/classicace/start-classicace.sh status
#   bash tools/classicace/start-classicace.sh reset    # remove both containers and the DB volume
#
# Then bridge to it (never the ACE bridge on 9090), telling the launcher its era:
#   BRIDGE_ERA=classicace-customdm npx tsx services/ws-tcp-bridge/src/bridge.ts 9190 127.0.0.1 9200 9201
#
# Needs the CustomDM 1.60 data files in dat-sets/classicace-customdm-1.60/
# (client_portal / client_cell_1 / client_local_English / client_highres .dat,
# from the ClassicACE README's "Data Files - CustomDM 1.60" download) and the
# ClassicACE source at reference/classic/ClassicACE (its Database/ folder: the
# CustomDM base schemas and the CustomDM world dump .7z).
#
# Everything is prefixed classicace-: network classicace_net, containers
# classicace-db / classicace-server, volume classicace-db-data, UDP 9200-9201.
# The Infiltration instance is classicace-infiltration-db / -server, volume
# classicace-infiltration-db-data, UDP 9220-9221, data files
# dat-sets/classicace-infiltration-1.9 ("Data Files - Infiltration 1.9").
# It never touches ace-server / ace-db / ports 9000-9003 / 3306.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RULESET="${CLASSICACE_RULESET:-CustomDM}"
case "$RULESET" in
  CustomDM)     PREFIX="classicace";              DEFAULT_DATS="classicace-customdm-1.60";     DEFAULT_PORT=9200
                WORLD_DUMP="ACE-World-CE16PY-db-v0.7.18-CustomDM-v3.14.sql.7z" ;;
  Infiltration) PREFIX="classicace-infiltration"; DEFAULT_DATS="classicace-infiltration-1.9"; DEFAULT_PORT=9220
                WORLD_DUMP="ACE-World-CE16PY-db-v0.7.18-Infiltration-v0.13.sql.7z" ;;
  *) echo "CLASSICACE_RULESET must be CustomDM or Infiltration" >&2; exit 2 ;;
esac
DAT_DIR="$(cd "${CLASSICACE_DAT_DIR:-$REPO/dat-sets/$DEFAULT_DATS}" && pwd -P)"
SRC="$(cd "${CLASSICACE_SRC:-$REPO/reference/classic/ClassicACE}" && pwd -P)"
IMAGE="classicace:73ae37f"
NET="classicace_net"
DB="$PREFIX-db"
SRV="$PREFIX-server"
VOL="$PREFIX-db-data"
PORT="${CLASSICACE_PORT:-$DEFAULT_PORT}"
DB_IMAGE="mysql:8.0"

cmd="${1:-start}"
exists() { docker container inspect "$1" >/dev/null 2>&1; }

case "$cmd" in
  stop)
    docker stop --timeout 30 "$SRV" 2>/dev/null || true
    docker stop "$DB" 2>/dev/null || true
    exit 0 ;;
  status)
    docker ps -a --filter name="^$PREFIX-(db|server)\$" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
    exists "$SRV" && docker logs --tail 15 "$SRV" 2>&1 || true
    exit 0 ;;
  reset)
    docker rm -f "$SRV" "$DB" 2>/dev/null || true
    docker volume rm "$VOL" 2>/dev/null || true
    exit 0 ;;
  start) ;;
  *) echo "usage: $0 [start|stop|status|reset]" >&2; exit 2 ;;
esac

for f in client_portal.dat client_cell_1.dat client_local_English.dat client_highres.dat; do
  [ -f "$DAT_DIR/$f" ] || { echo "missing $DAT_DIR/$f ($RULESET data files)" >&2; exit 1; }
done

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE…"
  docker build -t "$IMAGE" "$HERE"
fi

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

# Readiness is asked of MySQL itself, and the server's from this start's log
# lines only: a restart's old "ready" lines passed a log grep instantly (the
# server raced MySQL and died), and a DB that was already running logs no
# new line at all (the wait then hung for 15 min) — 2026-10-06.
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if ! exists "$DB"; then
  INIT="$HERE/run/initdb-$RULESET"
  rm -rf "$INIT"; mkdir -p "$INIT"
  cp "$SRC/Database/Base/$RULESET/AuthenticationBase.sql" "$INIT/01_auth.sql"
  cp "$SRC/Database/Base/$RULESET/ShardBase.sql" "$INIT/02_shard.sql"
  7z e -so "$SRC/Database/$WORLD_DUMP" > "$INIT/03_world.sql"
  docker run -d --name "$DB" --network "$NET" \
    -e MYSQL_ROOT_PASSWORD=classicace \
    -v "$VOL:/var/lib/mysql" \
    -v "$INIT:/docker-entrypoint-initdb.d:ro" \
    "$DB_IMAGE" >/dev/null
else
  docker start "$DB" >/dev/null
fi

echo -n "waiting for $DB (first start imports the world, a few minutes)"
for _ in $(seq 1 300); do
  # The init phase runs a socket-only server (port: 0); the real one logs
  # "ready for connections ... port: 3306" once the world import is done.
  # mysqladmin over TCP: the init phase's socket-only server doesn't answer it.
  if docker exec "$DB" mysqladmin ping -h127.0.0.1 -uroot -pclassicace --silent >/dev/null 2>&1; then
    echo " ok"; break
  fi
  echo -n .; sleep 3
done

# The committed Config.js with this instance's ruleset and database host.
CONFIG="$HERE/run/Config-$RULESET.js"
mkdir -p "$HERE/run"
# with this ruleset's databases (ace_{auth,shard,world}_customdm → _infiltration).
LOWER="$(echo "$RULESET" | tr '[:upper:]' '[:lower:]')"
sed -e "s/\"WorldRuleset\": \"CustomDM\"/\"WorldRuleset\": \"$RULESET\"/" -e "s/\"classicace-db\"/\"$DB\"/g" \
    -e "s/\(ace_[a-z]*\)_customdm\"/\1_$LOWER\"/g" "$HERE/Config.js" > "$CONFIG"

SRV_WAS_RUNNING=false
[ "$(docker inspect -f '{{.State.Running}}' "$SRV" 2>/dev/null)" = true ] && SRV_WAS_RUNNING=true
if ! exists "$SRV"; then
  # -it: ACE reads its console prompt from stdin; with stdin closed the
  # prompt loop spins and floods the log ("ACE >> ACE >> …").
  docker run -dit --name "$SRV" --network "$NET" --stop-timeout 30 \
    -p "$PORT:9000/udp" -p "$((PORT + 1)):9001/udp" \
    -v "$CONFIG:/ace/Config.js:ro" \
    -v "$DAT_DIR:/ace/Dats:ro" \
    "$IMAGE" >/dev/null
else
  docker start "$SRV" >/dev/null
fi

echo -n "waiting for $SRV"
for _ in $(seq 1 150); do
  if $SRV_WAS_RUNNING || docker logs --since "$SINCE" "$SRV" 2>&1 | grep -qi 'End ACE Server Initialization\|Server is now online\|Ready'; then echo " ok"; break; fi
  if ! docker ps --filter name="^$SRV\$" --format '{{.Names}}' | grep -q .; then echo " EXITED"; docker logs --tail 40 "$SRV"; exit 1; fi
  echo -n .; sleep 2
done
docker logs "$SRV" 2>&1 | tail -4
ERA="classicace-$LOWER"
echo "ClassicACE $RULESET up on udp/$PORT-$((PORT + 1)). Bridge: BRIDGE_ERA=$ERA npx tsx services/ws-tcp-bridge/src/bridge.ts 9190 127.0.0.1 $PORT $((PORT + 1))"
