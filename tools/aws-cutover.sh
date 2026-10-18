#!/usr/bin/env bash
# Point playwebac.com and bridge.playwebac.com at the AWS host (docs/aws-hosting.md,
# "Cutover"). DNS-only records (no Cloudflare proxy), 60 s TTL. Railway, the host
# before, was deleted 2026-10-17, so there is no rollback target.
#
#   bash tools/aws-cutover.sh status
#   bash tools/aws-cutover.sh aws        # A records → the stack's Elastic IP
#   bash tools/aws-cutover.sh web-cf     # playwebac.com proxied: the Cloudflare Worker route serves the web
#   bash tools/aws-cutover.sh web-aws    # playwebac.com back to DNS-only: the AWS web container (rollback)
#
# web-cf / web-aws touch only the playwebac.com record; bridge.playwebac.com stays DNS-only on AWS
# (docs/web-hosting-cloudflare-plan.md). The A record's IP stays the AWS host's either way.
#
# The Cloudflare token (DNS edit, playwebac.com only) is read from SSM /webac/cloudflare-token.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-webac}" AWS_REGION="${AWS_REGION:-us-east-1}"
ZONE_NAME=playwebac.com
NAMES="playwebac.com bridge.playwebac.com"
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
  web-cf|web-aws)
    proxied=false; [ "$1" = web-cf ] && proxied=true
    id="$(record_id playwebac.com)"
    cur="$(cf "$API/zones/$ZONE/dns_records/$id" | jq -c '.result | {type,name,content,ttl}')"
    cf -X PATCH "$API/zones/$ZONE/dns_records/$id" --data "$(jq -cn --argjson p "$proxied" 'if $p then {proxied:true} else {proxied:false,ttl:60} end')" >/dev/null
    echo "playwebac.com was $cur; now proxied=$proxied"
    show ;;
  *) echo "usage: aws-cutover.sh status|aws|web-cf|web-aws" >&2; exit 2 ;;
esac
