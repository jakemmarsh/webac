#!/bin/bash
# Configure the webac EC2 host (docs/aws-hosting.md). Idempotent: user data runs it
# once at launch, and deploy-agent.sh re-runs it whenever deploy/aws/host changes.
#
# Reads (SSM Parameter Store, SecureString, region of the instance):
#   /webac/host/env         HOSTS lines: WEB_HOSTS="a b", BRIDGE_HOSTS="c d", CERT_EMAIL=…
#   /webac/cloudflare-token DNS-edit token for the zone (acme.sh dns_cf); absent = self-signed
#   /webac/bridge/env       the bridge container's env file
#   /webac/web/env          the web container's env file
set -euo pipefail
# SSM and systemd run this without a login environment; acme.sh and git read $HOME.
export HOME=/root
HOST_DIR="$(cd "$(dirname "$0")" && pwd)"
REGION="$(TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'); curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"
export AWS_DEFAULT_REGION="$REGION"
log() { echo "[bootstrap] $*"; }

# ── Packages ───────────────────────────────────────────
need=()
for p in docker nginx git jq python3 dnf-automatic; do rpm -q "$p" >/dev/null 2>&1 || need+=("$p"); done
[ ${#need[@]} -gt 0 ] && dnf install -y "${need[@]}"
systemctl enable --now docker

# Security updates daily, no automatic reboot (a reboot would drop every player).
sed -i 's/^upgrade_type = .*/upgrade_type = security/; s/^apply_updates = .*/apply_updates = yes/; s/^reboot = .*/reboot = never/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer

# ── Swap: the web build (vite) peaks near 2.7 GB on a 2 GB instance ──
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── State dirs (the bridge container runs as uid 1000) ──
install -d -m 755 /etc/webac /etc/webac/tls /var/lib/webac /var/lib/webac/state /etc/nginx/webac
install -d -m 750 -o 1000 -g 1000 /var/lib/webac/egress /var/lib/webac/routines

# ── Config from SSM ────────────────────────────────────
fetch_param() { # name dest mode
  local v
  if v="$(aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null)"; then
    umask 077; printf '%s\n' "$v" > "$2.tmp"; chmod "$3" "$2.tmp"; mv "$2.tmp" "$2"; return 0
  fi
  return 1
}
fetch_param /webac/host/env /etc/webac/host.env 600 || { log "missing /webac/host/env"; exit 1; }
fetch_param /webac/bridge/env /etc/webac/bridge.env 600 || log "no /webac/bridge/env yet"
fetch_param /webac/web/env /etc/webac/web.env 600 || log "no /webac/web/env yet"
# shellcheck disable=SC1091
. /etc/webac/host.env
: "${WEB_HOSTS:?}" "${BRIDGE_HOSTS:?}"

# ── TLS ────────────────────────────────────────────────
# One certificate for every name. With the Cloudflare token: Let's Encrypt over DNS-01,
# so a certificate exists before DNS points here (no gap at cutover). Without it: a
# self-signed placeholder so nginx can start.
CRT=/etc/webac/tls/webac.crt KEY=/etc/webac/tls/webac.key
NAMES="$WEB_HOSTS $BRIDGE_HOSTS"
if fetch_param /webac/cloudflare-token /etc/webac/cf.token 600; then
  if [ ! -x /root/.acme.sh/acme.sh ]; then
    # The release tarball, not the lone script: the install copies dnsapi/ (dns_cf) from beside it.
    rm -rf /tmp/acme.sh-src && mkdir -p /tmp/acme.sh-src
    curl -fsSL https://github.com/acmesh-official/acme.sh/archive/refs/tags/3.1.1.tar.gz | tar -xz -C /tmp/acme.sh-src --strip-components=1
    (cd /tmp/acme.sh-src && sh ./acme.sh --install --nocron --home /root/.acme.sh -m "${CERT_EMAIL:-admin@playwebac.com}" >/dev/null)
    rm -rf /tmp/acme.sh-src
  fi
  domains=(); for n in $NAMES; do domains+=(-d "$n"); done
  want="$(echo "$NAMES" | tr ' ' '\n' | sort | tr '\n' ' ')"
  have="$(cat /etc/webac/tls/names 2>/dev/null || true)"
  if [ "$want" != "$have" ] || ! grep -q 'BEGIN CERTIFICATE' "$CRT" 2>/dev/null || [ -f /etc/webac/tls/selfsigned ]; then
    CF_Token="$(cat /etc/webac/cf.token)" /root/.acme.sh/acme.sh --home /root/.acme.sh --issue --server letsencrypt --dns dns_cf \
      "${domains[@]}" --keylength ec-256 --force
    /root/.acme.sh/acme.sh --home /root/.acme.sh --install-cert --ecc -d "$(echo "$NAMES" | awk '{print $1}')" \
      --key-file "$KEY" --fullchain-file "$CRT" --reloadcmd "systemctl reload nginx"
    echo "$want" > /etc/webac/tls/names
    rm -f /etc/webac/tls/selfsigned
  fi
elif [ ! -f "$CRT" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
    -subj "/CN=$(echo "$NAMES" | awk '{print $1}')" -keyout "$KEY" -out "$CRT" 2>/dev/null
  touch /etc/webac/tls/selfsigned
fi

# ── nginx ──────────────────────────────────────────────
# Upstream files are owned by the deploy agent (it rewrites them on every switch);
# only create them when missing so a re-run never points traffic at a stopped port.
[ -f /etc/nginx/webac/bridge-upstream.conf ] || echo 'server 127.0.0.1:9091;' > /etc/nginx/webac/bridge-upstream.conf
[ -f /etc/nginx/webac/web-upstream.conf ] || echo 'server 127.0.0.1:8081;' > /etc/nginx/webac/web-upstream.conf
sed -e "s|@WEB_HOSTS@|$WEB_HOSTS|g" -e "s|@BRIDGE_HOSTS@|$BRIDGE_HOSTS|g" "$HOST_DIR/nginx-webac.conf" > /etc/nginx/conf.d/webac.conf
install -m 644 "$HOST_DIR/nginx-main.conf" /etc/nginx/nginx.conf
nginx -t
systemctl enable nginx
systemctl is-active --quiet nginx && systemctl reload nginx || systemctl start nginx

# ── systemd units: the deploy agent, cert renewal ──────
install -m 644 "$HOST_DIR"/systemd/*.service "$HOST_DIR"/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now webac-deploy.timer webac-certs.timer
log "done"
