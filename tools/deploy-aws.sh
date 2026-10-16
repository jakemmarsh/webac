#!/usr/bin/env bash
# Run the webac host's deploy agent now, through Systems Manager (docs/aws-hosting.md).
# Normally unnecessary: the host deploys every commit CI passed (origin/ci-green)
# within a minute. Use it when CI is down, to deploy a specific ref, or to apply
# changed SSM config.
#
#   bash tools/deploy-aws.sh                      # deploy the newest CI-green commit now
#   bash tools/deploy-aws.sh --ref <sha>          # deploy a specific commit (skips CI)
#   bash tools/deploy-aws.sh --ref <sha> --only web
#   bash tools/deploy-aws.sh --force              # rebuild both, re-read SSM config
#   bash tools/deploy-aws.sh --pin <sha>|--unpin  # hold the host at a commit / resume ci-green
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-webac}" AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="${WEBAC_STACK:-webac}"
instance="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"

cmd="bash /opt/webac/repo/deploy/aws/host/deploy-agent.sh"
case "${1:-}" in
  --pin) cmd="git -C /opt/webac/repo fetch -q origin && git -C /opt/webac/repo rev-parse --verify '$2^{commit}' > /var/lib/webac/state/pin && $cmd" ;;
  --unpin) cmd="rm -f /var/lib/webac/state/pin && $cmd" ;;
  *) for a in "$@"; do cmd+=" $(printf '%q' "$a")"; done ;;
esac
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
