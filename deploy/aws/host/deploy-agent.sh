#!/bin/bash
# webac deploy agent (docs/aws-hosting.md). Runs every minute from webac-deploy.timer:
#
#   1. restarts the live containers if they aren't running (after a reboot);
#   2. picks the target commit: --ref <sha>, else /var/lib/webac/state/pin, else
#      origin/ci-green (CI moves that branch to each main commit it passed);
#   3. updates this host's own config (bootstrap.sh) when deploy/aws/host changed;
#   4. for web and bridge, when a file the service is built from changed (its
#      railway.json watchPatterns, the same rule Railway applied), builds the image,
#      starts it beside the live one, health-checks it, switches nginx to it, then
#      retires the old one: the web container stops, the bridge gets SIGTERM and
#      drains its sessions for up to BRIDGE_DRAIN_SECONDS before exiting.
#
#   deploy-agent.sh [--ref <commit>] [--only web|bridge] [--force]
#     --force   rebuild and switch even when nothing changed (also re-reads SSM config)
set -euo pipefail

exec 9>/run/webac-deploy.lock
flock -n 9 || { echo "[deploy] another run holds the lock"; exit 0; }

export HOME=/root
REPO=/opt/webac/repo
STATE=/var/lib/webac/state
HOST_DIR="$REPO/deploy/aws/host"
export GIT_SSH_COMMAND="ssh -i /root/.ssh/webac_deploy -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
IMDS_TOKEN="$(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
REGION="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"
export AWS_DEFAULT_REGION="$REGION"

REF="" ONLY="" FORCE=0 FAILED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
ARGS=("$@")

# One line to the journal, and to CloudWatch (/webac/host, stream "deploy") so
# tools/aws-logs.sh shows deploys next to the bridge's own lines.
log() {
  echo "[deploy] $*"
  local events
  events="$(jq -cn --arg m "$*" --argjson t "$(date +%s%3N)" '[{timestamp:$t,message:({event:"deploy",message:$m}|tojson)}]')"
  aws logs create-log-stream --log-group-name /webac/host --log-stream-name deploy >/dev/null 2>&1 || true
  aws logs put-log-events --log-group-name /webac/host --log-stream-name deploy --log-events "$events" >/dev/null 2>&1 || true
}

ports_for() { case "$1" in web) echo "8081 8082 8083 8084" ;; bridge) echo "9091 9092 9093 9094 9095 9096 9097 9098" ;; esac; }
watch_file() { case "$1" in web) echo deploy/web/railway.json ;; bridge) echo services/ws-tcp-bridge/railway.json ;; esac; }

# ── 1. keep the live containers up ─────────────────────
for svc in web bridge; do
  c="$(cat "$STATE/$svc.container" 2>/dev/null || true)"
  if [ -n "$c" ] && [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" != "true" ]; then
    log "$svc: live container $c not running; starting it"
    docker start "$c" >/dev/null || log "$svc: could not start $c"
  fi
done

# ── 2. target commit ───────────────────────────────────
git -C "$REPO" fetch -q origin '+refs/heads/main:refs/remotes/origin/main' 2>/dev/null || { log "git fetch failed"; exit 1; }
git -C "$REPO" fetch -q origin '+refs/heads/ci-green:refs/remotes/origin/ci-green' 2>/dev/null || true
if [ -n "$REF" ]; then
  # A commit only on another branch (a hotfix branch while CI is down) needs every head fetched.
  git -C "$REPO" cat-file -e "$REF^{commit}" 2>/dev/null \
    || git -C "$REPO" fetch -q origin '+refs/heads/*:refs/remotes/origin/*' 2>/dev/null || true
  TARGET="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
elif [ -s "$STATE/pin" ]; then
  TARGET="$(git -C "$REPO" rev-parse --verify "$(cat "$STATE/pin")^{commit}")"
elif git -C "$REPO" rev-parse -q --verify refs/remotes/origin/ci-green >/dev/null; then
  TARGET="$(git -C "$REPO" rev-parse refs/remotes/origin/ci-green)"
  # Act only when ci-green moves, as Railway did: a manual --ref deploy (a hotfix
  # while CI is down) stays live until CI passes a newer main commit.
  if [ "$FORCE" = 0 ] && [ "$(cat "$STATE/green.seen" 2>/dev/null || true)" = "$TARGET" ]; then exit 0; fi
  GREEN="$TARGET"
else
  exit 0
fi
SHORT="${TARGET:0:12}"

# ── 3. this host's config ──────────────────────────────
HOST_SHA="$(cat "$STATE/host.sha" 2>/dev/null || true)"
if [ "$FORCE" = 1 ] || [ -z "$HOST_SHA" ] || ! git -C "$REPO" diff --quiet "$HOST_SHA" "$TARGET" -- deploy/aws/host; then
  if [ "$HOST_SHA" != "$TARGET" ] || [ "$FORCE" = 1 ]; then
    log "host config → $SHORT"
    git -C "$REPO" checkout -q -f "$TARGET"
    bash "$HOST_DIR/bootstrap.sh"
    echo "$TARGET" > "$STATE/host.sha"
    # Run the (possibly new) agent; fd 9 keeps the lock.
    exec /bin/bash "$HOST_DIR/deploy-agent.sh" ${REF:+--ref "$REF"} ${ONLY:+--only "$ONLY"} ${ARGS[@]+"${ARGS[@]}"}
  fi
fi

# ── 4. services ────────────────────────────────────────
# Did any file the service is built from change between two commits? Patterns are
# Railway's watchPatterns (** spans directories, * stays inside one).
changed_for() { # svc from to
  local patterns
  patterns="$(git -C "$REPO" show "$3:$(watch_file "$1")" | jq -r '.build.watchPatterns[]')"
  git -C "$REPO" diff --name-only "$2" "$3" | PATTERNS="$patterns" python3 -c '
import os, re, sys
pats = [p for p in os.environ["PATTERNS"].splitlines() if p]
def rx(p):
    out, i = "", 0
    while i < len(p):
        if p.startswith("**", i): out += ".*"; i += 2
        elif p[i] == "*": out += "[^/]*"; i += 1
        else: out += re.escape(p[i]); i += 1
    return re.compile(out + r"\Z")
rs = [rx(p) for p in pats]
sys.exit(0 if any(r.match(f.strip()) for f in sys.stdin for r in rs) else 1)'
}

free_port() { # svc
  local p
  for p in $(ports_for "$1"); do
    ss -ltnH "sport = :$p" | grep -q . || { echo "$p"; return 0; }
  done
  return 1
}

health() { # port path
  local i
  for i in $(seq 1 90); do
    curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$1$2" && return 0
    sleep 1
  done
  return 1
}

switch_upstream() { # svc port
  local f="/etc/nginx/webac/$1-upstream.conf"
  cp "$f" "$f.prev"
  echo "server 127.0.0.1:$2;" > "$f"
  if nginx -t >/dev/null 2>&1 && systemctl reload nginx; then return 0; fi
  mv "$f.prev" "$f"; systemctl reload nginx || true
  return 1
}

deploy_svc() { # svc
  local svc="$1" ctx port name old image
  ctx="$(mktemp -d /var/tmp/webac-build.XXXXXX)"
  trap 'rm -rf "$ctx"' RETURN
  git -C "$REPO" archive "$TARGET" package.json package-lock.json tsconfig.json vite.config.ts \
    tools/lib/vite-head-from-stat.ts packages services deploy tools/ac-agent .dockerignore | tar -x -C "$ctx"
  image="webac-$svc:$SHORT"
  log "$svc: building $image"
  # deploy_svc runs under `||`, where bash ignores set -e: every step checks its own status.
  local built=0
  case "$svc" in
    bridge) docker build -q -f "$ctx/services/ws-tcp-bridge/Dockerfile" -t "$image" "$ctx" >/dev/null && built=1 ;;
    web) docker build -q --build-arg "ACJS_BUILD_ID=$SHORT" -f "$ctx/deploy/web/Dockerfile" -t "$image" "$ctx" >/dev/null && built=1 ;;
  esac
  [ "$built" = 1 ] || { log "$svc: build of $image failed"; return 1; }
  port="$(free_port "$svc")" || { log "$svc: no free port"; return 1; }
  name="webac-$svc-$SHORT-$(date +%s)"
  local logopts=(--log-driver awslogs --log-opt "awslogs-region=$REGION" --log-opt "awslogs-group=/webac/$svc"
    --log-opt "awslogs-stream=$name" --log-opt mode=non-blocking --log-opt max-buffer-size=4m)
  local started=0
  case "$svc" in
    bridge)
      docker run -d --name "$name" --network host --restart on-failure:10 "${logopts[@]}" \
        --env-file /etc/webac/bridge.env -e "PORT=$port" -e BRIDGE_HOST=127.0.0.1 \
        -e BRIDGE_EGRESS_DIR=/var/lib/webac/egress -v /var/lib/webac/egress:/var/lib/webac/egress \
        -e BRIDGE_ROUTINES_DIR=/var/lib/webac/routines -v /var/lib/webac/routines:/var/lib/webac/routines \
        "$image" >/dev/null && started=1 ;;
    web)
      docker run -d --name "$name" --restart on-failure:10 "${logopts[@]}" \
        --env-file /etc/webac/web.env -e PORT=8080 -p "127.0.0.1:$port:8080" "$image" >/dev/null && started=1 ;;
  esac
  [ "$started" = 1 ] || { log "$svc: docker run of $image failed"; return 1; }
  if ! health "$port" /healthz || { [ "$svc" = web ] && ! health "$port" /config.json; }; then
    log "$svc: $name failed its health check; keeping the live one"
    docker logs --tail 50 "$name" 2>&1 | sed 's/^/  /' || true
    docker rm -f "$name" >/dev/null 2>&1 || true
    return 1
  fi
  switch_upstream "$svc" "$port" || { log "$svc: nginx switch failed"; docker rm -f "$name" >/dev/null; return 1; }
  old="$(cat "$STATE/$svc.container" 2>/dev/null || true)"
  echo "$name" > "$STATE/$svc.container"
  echo "$port" > "$STATE/$svc.port"
  echo "$TARGET" > "$STATE/$svc.sha"
  rm -f "$STATE/$svc.failed"
  if [ -n "$old" ] && docker inspect "$old" >/dev/null 2>&1; then
    docker update --restart=no "$old" >/dev/null 2>&1 || true
    case "$svc" in
      # The bridge drains: open sessions play on; it exits by itself when they end.
      bridge) docker kill --signal TERM "$old" >/dev/null 2>&1 || true ;;
      web) docker stop "$old" >/dev/null 2>&1 || true ;;
    esac
  fi
  log "$svc: live on $name (port $port)${old:+, retired $old}"
}

for svc in web bridge; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$svc" ] && continue
  deployed="$(cat "$STATE/$svc.sha" 2>/dev/null || true)"
  [ "$FORCE" = 0 ] && [ "$deployed" = "$TARGET" ] && continue
  [ "$FORCE" = 0 ] && [ "$(cat "$STATE/$svc.failed" 2>/dev/null || true)" = "$TARGET" ] && continue
  if [ "$FORCE" = 0 ] && [ -n "$deployed" ] && [ -z "$REF" ] && ! changed_for "$svc" "$deployed" "$TARGET"; then
    echo "$TARGET" > "$STATE/$svc.sha"   # nothing it's built from changed
    continue
  fi
  deploy_svc "$svc" || { echo "$TARGET" > "$STATE/$svc.failed"; FAILED=1; }
done
# A failed build is retried only by --force or a newer commit, so ci-green counts as handled.
[ -n "${GREEN:-}" ] && echo "$GREEN" > "$STATE/green.seen"

# ── housekeeping ───────────────────────────────────────
# Exited webac containers (retired webs, bridges that finished draining), then
# images no container uses, and build cache beyond 3 GB.
docker ps -a --filter status=exited --format '{{.Names}}' | grep '^webac-' | xargs -r docker rm >/dev/null 2>&1 || true
docker image prune -af --filter "until=24h" >/dev/null 2>&1 || true
docker builder prune -f --keep-storage 3gb >/dev/null 2>&1 || true
[ "${FAILED:-0}" = 0 ] || exit 1
