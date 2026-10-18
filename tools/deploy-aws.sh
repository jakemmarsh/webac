#!/usr/bin/env bash
# Deploy to the webac host now (docs/aws-hosting.md). While CI works it is optional: CI
# pushes each passing commit's images and the host deploys origin/ci-green by itself.
# While CI is out (no minutes), this is how anything ships.
#
# It first builds and pushes the commit's images from here (tools/build-push-images.sh;
# a tag already in the registry is skipped), then runs the host's deploy agent through
# Systems Manager, which only pulls and switches. The host never builds.
#
#   bash tools/deploy-aws.sh                      # deploy origin/main's newest commit now
#   bash tools/deploy-aws.sh --ref <sha>          # deploy a specific commit (skips CI)
#   bash tools/deploy-aws.sh --ref <sha> --only web
#   bash tools/deploy-aws.sh --force [--only web] # restart the LIVE commit with re-read SSM config
#   bash tools/deploy-aws.sh --ref <sha> --force  # re-pull and switch that commit even if it's live
#   bash tools/deploy-aws.sh --pin <sha>|--unpin  # hold the host at a commit / resume ci-green
#   … --no-build                                  # skip the local build (CI already pushed)
#   … --urgent                                    # deploy the bridge even with 2+ old bridges draining
#   … --skip-gate                                 # deploy a commit that hasn't passed ci-local.sh (loud)
#
# Draining cap: the host refuses a BRIDGE deploy while 2 or more retired bridges are still
# draining their sessions (it prints how many, with their session counts), unless --urgent.
# Web-only deploys never wait. Each bridge deploy leaves the old process draining for up to
# 6 h on a 2 GB host, and there were ~15 deploys on 2026-10-17.
#
# The gate: the commit must have passed tools/ci-local.sh (its pass stamp; CI is out, so
# that is the gate). The refusal prints the exact command; --skip-gate overrides it.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-webac}" AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="${WEBAC_STACK:-webac}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

usage() { echo "usage: deploy-aws.sh [--ref <commit> | --pin <commit> | --unpin] [--only web|bridge] [--force] [--no-build] [--urgent] [--skip-gate]" >&2; exit 2; }
REF="" PIN="" UNPIN=0 ONLY="" FORCE=0 BUILD=1 URGENT=0 SKIP_GATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || usage; REF="$2"; shift 2 ;;
    --pin) [ $# -ge 2 ] || usage; PIN="$2"; shift 2 ;;
    --unpin) UNPIN=1; shift ;;
    --only) [ $# -ge 2 ] || usage; ONLY="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --no-build) BUILD=0; shift ;;
    --urgent) URGENT=1; shift ;;
    --skip-gate) SKIP_GATE=1; shift ;;
    *) usage ;;
  esac
done
case "$ONLY" in ""|web|bridge) ;; *) usage ;; esac

# --force alone restarts what is live with fresh config: nothing new to gate or build.
LIVE=0
[ "$FORCE" = 1 ] && [ -z "$REF$PIN" ] && [ "$UNPIN" = 0 ] && LIVE=1

if [ "$LIVE" = 0 ]; then
# The commit the host will deploy, as a full sha both sides agree on.
git -C "$REPO" fetch -q origin '+refs/heads/main:refs/remotes/origin/main'
want="${REF:-${PIN:-origin/main}}"
git -C "$REPO" cat-file -e "$want^{commit}" 2>/dev/null || git -C "$REPO" fetch -q origin
SHA="$(git -C "$REPO" rev-parse --verify "$want^{commit}")"
echo "deploying ${SHA:0:12} ($want)"

# shellcheck source=tools/lib/deploy-gate.sh
. "$REPO/tools/lib/deploy-gate.sh"
gate_check "$REPO" "$SHA" "$SKIP_GATE" || exit 1
fi

if [ "$BUILD" = 1 ] && [ "$LIVE" = 0 ]; then
  build=(bash "$REPO/tools/build-push-images.sh" "$SHA")
  [ -n "$ONLY" ] && build+=(--only "$ONLY")
  [ "$SKIP_GATE" = 1 ] && build+=(--skip-gate)
  "${build[@]}"
fi

instance="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"

cmd="bash /opt/webac/repo/deploy/aws/host/deploy-agent.sh"
[ "$URGENT" = 1 ] && cmd+=" --urgent"
# Always the exact commit gated and built here; it stays live until ci-green moves past it.
if [ "$LIVE" = 1 ]; then cmd+=" --ref live"
elif [ -z "$PIN" ] && [ "$UNPIN" = 0 ]; then cmd+=" --ref $SHA"; fi
[ -n "$ONLY" ] && cmd+=" --only $ONLY"
[ "$FORCE" = 1 ] && cmd+=" --force"
if [ -n "$PIN" ]; then
  cmd="echo $SHA > /var/lib/webac/state/pin && $cmd"
elif [ "$UNPIN" = 1 ]; then
  cmd="rm -f /var/lib/webac/state/pin && $cmd"
fi
# The agent may be mid-run from its timer; wait for its lock instead of skipping.
cmd="flock /run/webac-deploy.lock true; $cmd"

id="$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --parameters "$(jq -cn --arg c "$cmd" '{commands:[$c],executionTimeout:["3600"]}')" \
  --query Command.CommandId --output text)"
echo "command $id on $instance"
while :; do
  status="$(aws ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query Status --output text 2>/dev/null || echo Pending)"
  case "$status" in Pending|InProgress|Delayed) sleep 5 ;; *) break ;; esac
done
aws ssm get-command-invocation --command-id "$id" --instance-id "$instance" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text
echo "status: $status"
[ "$status" = Success ]
