#!/usr/bin/env bash
# Create or update the webac AWS stack (deploy/aws/webac.cfn.yaml; docs/aws-hosting.md).
#
#   bash tools/aws-stack.sh            # create, or update with the current parameter values
#   bash tools/aws-stack.sh EgressSlots=3 InstanceType=t4g.small
#
# AWS profile/region: AWS_PROFILE (default webac), AWS_REGION (default us-east-1).
# The AMI is resolved only on create: a new AMI on update would replace the instance.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-webac}" AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="${WEBAC_STACK:-webac}"
REPO="$(git rev-parse --show-toplevel)"
TEMPLATE="$REPO/deploy/aws/webac.cfn.yaml"

overrides=("$@")
if aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
  params=()
  for k in AmiId InstanceType AvailabilityZone EgressSlots RepoSsh BudgetEmail BudgetUsd; do
    v=""; for o in ${overrides[@]+"${overrides[@]}"}; do [[ "$o" == "$k="* ]] && v="${o#*=}"; done
    if [ -n "$v" ]; then params+=("ParameterKey=$k,ParameterValue=$v"); else params+=("ParameterKey=$k,UsePreviousValue=true"); fi
  done
  aws cloudformation update-stack --stack-name "$STACK" --template-body "file://$TEMPLATE" \
    --capabilities CAPABILITY_IAM --parameters "${params[@]}"
  aws cloudformation wait stack-update-complete --stack-name "$STACK"
else
  ami="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)"
  email="$(git config user.email)"
  params=("ParameterKey=AmiId,ParameterValue=$ami" "ParameterKey=BudgetEmail,ParameterValue=$email")
  for o in ${overrides[@]+"${overrides[@]}"}; do params+=("ParameterKey=${o%%=*},ParameterValue=${o#*=}"); done
  aws cloudformation create-stack --stack-name "$STACK" --template-body "file://$TEMPLATE" \
    --capabilities CAPABILITY_IAM --parameters "${params[@]}"
  aws cloudformation wait stack-create-complete --stack-name "$STACK"
fi
aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
