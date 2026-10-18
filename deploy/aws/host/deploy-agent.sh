#!/bin/bash
# webac deploy agent (docs/aws-hosting.md). Runs every minute from webac-deploy.timer:
#
#   1. restarts the live containers if they aren't running (after a reboot);
#   2. picks the target commit: --ref <sha|branch>, else /var/lib/webac/state/pin, else
#      origin/ci-green (CI moves that branch to each main commit it passed);
#   3. updates this host's own config (bootstrap.sh) when deploy/aws/host changed;
#   4. for web and bridge, looks up the commit's image (<registry>/webac-<svc>:<sha>) in
#      ECR. When its digest differs from the live one, pulls it, starts it beside the
#      live one, health-checks it, switches nginx to it, then retires the old one: the
#      web container stops, the bridge gets SIGTERM and drains its sessions for up to
#      BRIDGE_DRAIN_SECONDS before exiting. Then it deletes this service's older images,
#      keeping the live one and the previous one (rollback).
#
# This host never builds an image and needs no repo history: tools/build-push-images.sh
# (CI, or tools/deploy-aws.sh on the laptop) builds each image once and tags it with every
# commit it serves, so "did this service change" is "is the tag's digest the live one".
# Building here pushed the 2 GB instance into swap for minutes and stalled the live bridge
# (2026-10-17). A commit whose image isn't in the registry yet is logged once and retried
# every run; the live container stays. The repo checkout is shallow and sparse
# (deploy/aws/host only; bootstrap.sh converts an old full clone).
#
# Draining cap: a bridge deploy waits while MAX_DRAINING (2) or more retired bridges are
# still draining sessions (running webac-bridge-* containers other than the live one); it
# logs how many and their session counts, and --urgent overrides. Web deploys never wait.
#
# WEB_SERVICE=off in /webac/host/env (SSM; tools/aws-env.sh set host WEB_SERVICE=off) skips
# the web service: no pull, no switch, its container left running as a standby (the static
# web is moving to Cloudflare). Read from SSM on each deploy run, so it applies at once.
#
#   deploy-agent.sh [--ref <sha|branch|live>] [--only web|bridge] [--force] [--urgent]
#     --ref live   each service's live commit again: with --force, a restart that picks up
#                  changed SSM config (tools/aws-env.sh) without deploying anything new
#     --force   pull (if needed) and switch even when the image is the live one; re-runs
#               bootstrap.sh (re-reads SSM config)
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
ACCOUNT="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .accountId)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

REF="" ONLY="" FORCE=0 URGENT=0 FAILED=0 PENDING=0
MAX_DRAINING=2
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --urgent) URGENT=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

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

# ── 1. keep the live containers up ─────────────────────
for svc in web bridge; do
  c="$(cat "$STATE/$svc.container" 2>/dev/null || true)"
  if [ -n "$c" ] && [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" != "true" ]; then
    log "$svc: live container $c not running; starting it"
    docker start "$c" >/dev/null || log "$svc: could not start $c"
  fi
done

# ── 2. target commit ───────────────────────────────────
remote_sha() { git -C "$REPO" ls-remote origin "$1" | awk 'NR == 1 { print $1 }'; }
LIVE=0
if [ "$REF" = live ]; then
  LIVE=1 TARGET="live"
elif [ -n "$REF" ]; then
  if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then TARGET="$REF"
  else TARGET="$(remote_sha "refs/heads/$REF")" || { log "git ls-remote failed"; exit 1; }; fi
  [ -n "$TARGET" ] || { log "--ref $REF: give a full commit sha or a branch name"; exit 2; }
elif [ -s "$STATE/pin" ]; then
  TARGET="$(cat "$STATE/pin")"
else
  TARGET="$(remote_sha refs/heads/ci-green)" || { log "git ls-remote failed"; exit 1; }
  [ -n "$TARGET" ] || exit 0
  # Act only when ci-green moves, as Railway did: a manual --ref deploy (a hotfix
  # while CI is down) stays live until CI passes a newer main commit.
  if [ "$FORCE" = 0 ] && [ "$(cat "$STATE/green.seen" 2>/dev/null || true)" = "$TARGET" ]; then exit 0; fi
  GREEN="$TARGET"
fi
SHORT="${TARGET:0:12}"

# ── 3. this host's config ──────────────────────────────
if [ "$LIVE" = 1 ]; then
  # Same code, fresh config: re-run bootstrap from the current checkout (re-reads SSM).
  [ "$FORCE" = 1 ] && bash "$HOST_DIR/bootstrap.sh"
else
# One commit, no blobs but deploy/aws/host's (the sparse checkout).
git -C "$REPO" cat-file -e "$TARGET^{commit}" 2>/dev/null \
  || git -C "$REPO" fetch -q --depth 1 --filter=blob:none origin "$TARGET" 2>/dev/null \
  || { log "git fetch of $SHORT failed"; exit 1; }
HOST_TREE="$(git -C "$REPO" rev-parse "$TARGET:deploy/aws/host")"
if [ -z "${WEBAC_AGENT_REEXEC:-}" ] && { [ "$FORCE" = 1 ] || [ "$(cat "$STATE/host.tree" 2>/dev/null || true)" != "$HOST_TREE" ]; }; then
  log "host config → $SHORT"
  git -C "$REPO" checkout -q -f --detach "$TARGET"
  bash "$HOST_DIR/bootstrap.sh"
  echo "$HOST_TREE" > "$STATE/host.tree"
  # Run the (possibly new) agent for the same target; fd 9 keeps the lock.
  again=(); [ -n "$REF" ] && again+=(--ref "$TARGET"); [ -n "$ONLY" ] && again+=(--only "$ONLY")
  [ "$FORCE" = 1 ] && again+=(--force); [ "$URGENT" = 1 ] && again+=(--urgent)
  WEBAC_AGENT_REEXEC=1 exec /bin/bash "$HOST_DIR/deploy-agent.sh" ${again[@]+"${again[@]}"}
fi
fi

# ── 4. services ────────────────────────────────────────
free_port() { # svc
  local p
  for p in $(ports_for "$1"); do
    ss -ltnH "sport = :$p" | grep -q . || { echo "$p"; return 0; }
  done
  return 1
}

health() { # port path
  for _ in $(seq 1 90); do
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

LOGGED_IN=0
ecr_login() {
  [ "$LOGGED_IN" = 1 ] && return 0
  aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null 2>&1 || return 1
  LOGGED_IN=1
}

# The digest of webac-<svc>:$TARGET in the registry (stdout; its log lines go to stderr). Returns 1 when the tag isn't there
# (logged once per commit), 2 when the lookup failed.
registry_digest() { # svc
  local svc="$1" out
  if out="$(aws ecr describe-images --repository-name "webac-$svc" --image-ids "imageTag=$TARGET" \
      --query 'imageDetails[0].imageDigest' --output text 2>&1)"; then
    echo "$out"; return 0
  fi
  case "$out" in
    *ImageNotFoundException*)
      if [ "$(cat "$STATE/$svc.missing" 2>/dev/null || true)" != "$TARGET" ]; then
        log "$svc: image for $SHORT not in the registry yet; skipping" >&2
        echo "$TARGET" > "$STATE/$svc.missing"
      fi
      return 1 ;;
  esac
  log "$svc: registry lookup failed: $(echo "$out" | tail -1)" >&2
  return 2
}

# Delete this service's local images except the live one and the previous one (rollback).
# An image a container still uses (a draining bridge) fails to delete and goes next time.
prune_images() { # svc
  local svc="$1" keep ref id
  keep="$(docker image inspect -f '{{.Id}}' "$(cat "$STATE/$svc.image" 2>/dev/null || echo none)" \
    "$(cat "$STATE/$svc.image.prev" 2>/dev/null || echo none)" 2>/dev/null || true)"
  docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' | while read -r ref id; do
    case "$ref" in "$REGISTRY/webac-$svc:"*|"webac-$svc:"*) ;; *) continue ;; esac
    printf '%s\n' "$keep" | grep -qxF "$id" && continue
    docker rmi "$ref" >/dev/null 2>&1 || true
  done
}

# Retired bridges still draining: "<container> <sessions>" per line (the live one excluded).
draining_bridges() {
  local live c port n
  live="$(cat "$STATE/bridge.container" 2>/dev/null || true)"
  docker ps --filter status=running --format '{{.Names}}' | { grep '^webac-bridge-' || true; } | while read -r c; do
    [ "$c" = "$live" ] && continue
    port="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null | sed -n 's/^PORT=//p' | head -1)"
    n="$(curl -fsS --max-time 3 "http://127.0.0.1:${port:-0}/healthz" 2>/dev/null | jq -r '.sessions // "?"' 2>/dev/null || true)"
    echo "$c ${n:-?}"
  done
}

# WEB_SERVICE from /webac/host/env (SSM), else the copy bootstrap wrote.
host_setting() { # key
  { aws ssm get-parameter --name /webac/host/env --with-decryption --query Parameter.Value --output text 2>/dev/null \
      || cat /etc/webac/host.env 2>/dev/null || true; } | sed -n "s/^$1=//p" | tail -1 | tr -d "\"'"
}

deploy_svc() { # svc digest
  local svc="$1" digest="$2" port name old image
  image="$REGISTRY/webac-$svc:$TARGET"
  # deploy_svc runs under `||`, where bash ignores set -e: every step checks its own status.
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    ecr_login || { log "$svc: registry login failed"; return 2; }
    log "$svc: pulling $image"
    docker pull -q "$image" >/dev/null || { log "$svc: pull of $image failed"; return 2; }
  fi
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
  echo "$digest" > "$STATE/$svc.digest"
  [ -s "$STATE/$svc.image" ] && mv "$STATE/$svc.image" "$STATE/$svc.image.prev"
  echo "$image" > "$STATE/$svc.image"
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
  prune_images "$svc"
}

WEB_SERVICE="$(host_setting WEB_SERVICE)"
for svc in web bridge; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$svc" ] && continue
  if [ "$svc" = web ] && [ "$WEB_SERVICE" = off ]; then
    if [ ! -e "$STATE/web.off" ]; then
      log "web: WEB_SERVICE=off; not deploying it (the live container stays up as a standby)"
      touch "$STATE/web.off"
    fi
    continue
  fi
  [ "$svc" = web ] && rm -f "$STATE/web.off"
  if [ "$LIVE" = 1 ]; then
    TARGET="$(cat "$STATE/$svc.sha" 2>/dev/null || true)"
    [ -n "$TARGET" ] || { log "$svc: no live commit recorded"; FAILED=1; continue; }
    SHORT="${TARGET:0:12}"
  fi
  [ "$FORCE" = 0 ] && [ "$(cat "$STATE/$svc.sha" 2>/dev/null || true)" = "$TARGET" ] && continue
  [ "$FORCE" = 0 ] && [ "$(cat "$STATE/$svc.failed" 2>/dev/null || true)" = "$TARGET" ] && continue
  rc=0; digest="$(registry_digest "$svc")" || rc=$?
  [ "$rc" = 0 ] || { PENDING=1; continue; }   # no image yet: try again next run
  rm -f "$STATE/$svc.missing"
  if [ "$FORCE" = 0 ] && [ "$(cat "$STATE/$svc.digest" 2>/dev/null || true)" = "$digest" ]; then
    echo "$TARGET" > "$STATE/$svc.sha"   # the live image already: nothing it's built from changed
    continue
  fi
  if [ "$svc" = bridge ] && [ "$URGENT" = 0 ]; then
    draining="$(draining_bridges)"
    count="$(printf '%s' "$draining" | grep -c . || true)"
    if [ "$count" -ge "$MAX_DRAINING" ]; then
      detail="$(printf '%s\n' "$draining" | awk '{ printf "%s%s: %s sessions", (NR > 1 ? ", " : ""), $1, $2 }')"
      msg="bridge: $count old bridges still draining ($detail); not deploying $SHORT until fewer than $MAX_DRAINING remain (tools/deploy-aws.sh --urgent overrides)"
      if [ -n "$REF" ] || [ "$FORCE" = 1 ]; then log "$msg"
      elif [ "$(cat "$STATE/bridge.drainwait" 2>/dev/null || true)" != "$TARGET" ]; then log "$msg"; echo "$TARGET" > "$STATE/bridge.drainwait"; fi
      PENDING=1
      continue
    fi
  fi
  rc=0; deploy_svc "$svc" "$digest" || rc=$?
  case "$rc" in
    0) ;;
    2) PENDING=1 ;;   # pull failed: try again next run
    *) echo "$TARGET" > "$STATE/$svc.failed"; FAILED=1 ;;
  esac
done
# A failed deploy is retried only by --force or a newer commit, so ci-green counts as
# handled; a missing image keeps it unhandled so the next run looks again.
[ -n "${GREEN:-}" ] && [ "$PENDING" = 0 ] && echo "$GREEN" > "$STATE/green.seen"

# ── housekeeping ───────────────────────────────────────
# Exited webac containers (retired webs, bridges that finished draining), each service's
# images but the live and previous ones, dangling layers, any build cache left from when
# this host built images, and (daily) git objects of commits no longer checked out.
docker ps -a --filter status=exited --format '{{.Names}}' | grep '^webac-' | xargs -r docker rm >/dev/null 2>&1 || true
prune_images web; prune_images bridge
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true
if [ -z "$(find "$STATE/git-gc.stamp" -mtime -1 2>/dev/null)" ]; then
  git -C "$REPO" reflog expire --expire=now --all >/dev/null 2>&1 || true
  git -C "$REPO" gc -q --prune=now >/dev/null 2>&1 || true
  touch "$STATE/git-gc.stamp"
fi
[ "${FAILED:-0}" = 0 ] || exit 1
# A manual run (--ref / --force) that found no image reports it to tools/deploy-aws.sh.
{ [ -n "$REF" ] || [ "$FORCE" = 1 ]; } && [ "$PENDING" = 1 ] && exit 1
exit 0
