#!/usr/bin/env bash
# Point playwebac.com and bridge.playwebac.com at the AWS host, or back at Railway
# (docs/aws-hosting.md, "Cutover"). DNS-only records (no Cloudflare proxy), 60 s TTL.
#
#   bash tools/aws-cutover.sh status
#   bash tools/aws-cutover.sh aws        # A records → the stack's Elastic IP
#   bash tools/aws-cutover.sh railway    # rollback: the Railway CNAMEs these names had
#
# The Cloudflare token (DNS edit, playwebac.com only) is read from SSM /webac/cloudflare-token.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-webac}" AWS_REGION="${AWS_REGION:-us-east-1}"
ZONE_NAME=playwebac.com
# What Railway serves these names from (the records before the move, 2026-10-16).
NAMES="playwebac.com bridge.playwebac.com"
railway_target() { case "$1" in playwebac.com) echo 2wv1a0j4.up.railway.app ;; bridge.playwebac.com) echo uamtivcr.up.railway.app ;; esac; }
TOKEN="$(aws ssm get-parameter --name /webac/cloudflare-token --with-decryption --query Parameter.Value --output text)"
cf() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
API=https://api.cloudflare.com/client/v4
ZONE="$(cf "$API/zones?name=$ZONE_NAME" | jq -r '.result[0].id')"

record_id() { cf "$API/zones/$ZONE/dns_records?name=$1" | jq -r '[.result[] | select(.type=="A" or .type=="CNAME")][0].id'; }
show() { for n in $NAMES; do cf "$API/zones/$ZONE/dns_records?name=$n" | jq -r '.result[] | select(.type=="A" or .type=="CNAME") | "\(.name) \(.type) \(.content) ttl=\(.ttl) proxied=\(.proxied)"'; done; }

case "${1:-status}" in
  status) show ;;
  aws)
    ip="$(aws cloudformation describe-stacks --stack-name "${WEBAC_STACK:-webac}" --query "Stacks[0].Outputs[?OutputKey=='PublicIp'].OutputValue" --output text)"
    for n in $NAMES; do
      cf -X PUT "$API/zones/$ZONE/dns_records/$(record_id "$n")" \
        --data "$(jq -cn --arg n "$n" --arg ip "$ip" '{type:"A",name:$n,content:$ip,ttl:60,proxied:false}')" >/dev/null
    done
    show ;;
  railway)
    for n in $NAMES; do
      cf -X PUT "$API/zones/$ZONE/dns_records/$(record_id "$n")" \
        --data "$(jq -cn --arg n "$n" --arg t "$(railway_target "$n")" '{type:"CNAME",name:$n,content:$t,ttl:60,proxied:false}')" >/dev/null
    done
    show ;;
  *) echo "usage: aws-cutover.sh status|aws|railway" >&2; exit 2 ;;
esac
