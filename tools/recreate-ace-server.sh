#!/usr/bin/env bash
# recreate-ace-server.sh — recreate the ace-server container with stdin OPEN.
#
# Without `-i` ACE's console thread reads EOF from stdin and spins
# (`ACE >> ACE >> …`), burning a full core in the Docker VM at all times and
# flooding the container log (2026-09-30: 102–108% CPU at idle, 11 MB of
# prompt spam in 5 minutes). Upstream ACE #4502 makes the console exit on a
# closed stdin; until the pin moves past it, keep stdin open.
#
# Every mounted volume (named and anonymous: Config, Content, Dats, Logs,
# Mods) is re-attached by name, so no data moves. Refuses to run while a
# bridge session is active (it would kick a live player). The old container
# is kept as ace-server-old until the new one is healthy, then removed.
set -euo pipefail
NAME=ace-server
docker inspect "$NAME" >/dev/null
if [[ "$(docker inspect -f '{{.Config.OpenStdin}}' "$NAME")" == "true" && "${1:-}" != "--force" ]]; then
  echo "[recreate-ace-server] $NAME already has stdin open; nothing to do"; exit 0
fi
# The health probe itself counts as one bridge session.
sessions=$(node -e "const W=require('ws');const w=new W('ws://127.0.0.1:9090');w.on('open',()=>w.send('health'));w.on('message',d=>{console.log(JSON.parse(d).sessions);process.exit(0)});w.on('error',()=>{console.log(1);process.exit(0)});setTimeout(()=>{console.log(1);process.exit(0)},3000)")
if (( sessions > 1 )); then echo "[recreate-ace-server] $((sessions-1)) live bridge session(s) — not recreating"; exit 2; fi
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$NAME")
NET=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$NAME")
VOLS=$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}-v {{.Name}}:{{.Destination}} {{end}}{{end}}' "$NAME")
PORTS=$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}-p {{.HostPort}}:{{$p}} {{end}}{{end}}' "$NAME")
echo "[recreate-ace-server] image=$IMAGE net=$NET"; echo "  $VOLS"; echo "  $PORTS"
docker rm -f "$NAME-old" >/dev/null 2>&1 || true
docker stop "$NAME" >/dev/null && docker rename "$NAME" "$NAME-old"
# shellcheck disable=SC2086
docker run -d -i --name "$NAME" --network "$NET" $PORTS $VOLS "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo none)" == healthy ]] && break; sleep 3
done
status=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo none)
if [[ "$status" != healthy && "$status" != none ]]; then
  echo "[recreate-ace-server] new container is '$status' — restoring the old one"
  docker rm -f "$NAME" >/dev/null; docker rename "$NAME-old" "$NAME"; docker start "$NAME" >/dev/null; exit 1
fi
docker rm "$NAME-old" >/dev/null
echo "[recreate-ace-server] done (stdin open: $(docker inspect -f '{{.Config.OpenStdin}}' "$NAME"))"
