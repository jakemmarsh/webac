#!/usr/bin/env bash
# The web and bridge containers' environment, kept in SSM Parameter Store as one
# SecureString per service, /webac/<svc>/env, in docker --env-file format
# (KEY=value per line, no quoting). Replaces `railway variables` (docs/aws-hosting.md).
#
#   bash tools/aws-env.sh show bridge            # secrets masked
#   bash tools/aws-env.sh set bridge KEY=value [KEY2=value2 …]
#   bash tools/aws-env.sh unset bridge KEY [KEY2 …]
#
# The host reads it on a forced deploy: bash tools/deploy-aws.sh --force --only bridge
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-webac}" AWS_REGION="${AWS_REGION:-us-east-1}"
op="${1:?usage: aws-env.sh show|set|unset web|bridge …}"; svc="${2:?service: web|bridge}"; shift 2
name="/webac/$svc/env"
current="$(aws ssm get-parameter --name "$name" --with-decryption --query Parameter.Value --output text 2>/dev/null || true)"

case "$op" in
  show)
    printf '%s\n' "$current" | awk -F= 'NF {
      k=$1; v=substr($0, length(k)+2)
      if (k ~ /SECRET|TOKEN|PASSWORD|ACCOUNTS/) v="<" length(v) " chars>"
      print k "=" v }'
    exit 0 ;;
  set|unset) ;;
  *) echo "unknown op: $op" >&2; exit 2 ;;
esac

next="$(OP="$op" python3 -c '
import os, sys
cur = [l for l in sys.stdin.read().splitlines() if l.strip()]
env = {}
for l in cur:
    k, _, v = l.partition("=")
    env[k] = v
for a in sys.argv[1:]:
    if os.environ["OP"] == "set":
        k, sep, v = a.partition("=")
        if not sep or "\n" in v: sys.exit("bad KEY=value: " + a)
        env[k] = v
    else:
        env.pop(a, None)
print("\n".join(k + "=" + env[k] for k in sorted(env)))
' "$@" <<<"$current")"

aws ssm put-parameter --name "$name" --type SecureString --overwrite --value "$next" >/dev/null
echo "updated $name ($(printf '%s\n' "$next" | grep -c .) keys); apply: bash tools/deploy-aws.sh --force --only $svc"
