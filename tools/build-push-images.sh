#!/usr/bin/env bash
# Build the webac images for one commit and push them to ECR (docs/aws-hosting.md,
# "Images"). The one build path: tools/deploy-aws.sh runs it on the laptop, CI runs
# it after the tests pass. The EC2 host never builds; its deploy agent only pulls.
#
#   bash tools/build-push-images.sh <commit> [--only web|bridge] [--skip-gate]
#   bash tools/build-push-images.sh --print-context-paths   # the build context's paths
#
# Every image carries the full sha of each commit it serves: the host deploys
# <registry>/webac-<svc>:<commit> and switches only when that tag's digest differs from
# the live one. An image is built once, for its source commit (tools/image-source.sh:
# the newest commit at or before <commit> that changed a file in the service's
# railway.json watchPatterns), tagged with that sha; a later commit that changed nothing
# the service is built from just gets its own tag added to the same image (no build, no
# upload). A commit tag already in the registry is skipped, so this is idempotent.
# The context is a `git archive` of <commit> (never the working tree).
#
# The gate: <commit> must have passed tools/ci-local.sh (its pass stamp,
# tools/lib/deploy-gate.sh); --skip-gate overrides with a loud warning. In GitHub Actions
# the workflow's test job is the gate.
#
# AWS: AWS_PROFILE (default webac, unless credentials are in the environment, as in
# CI) and AWS_REGION (default us-east-1). WEBAC_REGISTRY overrides the registry host.
set -euo pipefail

# The build context: the paths deploy/web/Dockerfile and services/ws-tcp-bridge/Dockerfile
# copy from (tests/verify-bridge-docker-inputs.ts runs --print-context-paths).
CONTEXT_PATHS=(package.json package-lock.json tsconfig.json vite.config.ts
  tools/lib/vite-head-from-stat.ts packages services deploy tools/ac-agent .dockerignore)

usage() { echo "usage: build-push-images.sh <commit> [--only web|bridge] [--skip-gate] | --print-context-paths" >&2; exit 2; }
COMMIT="" ONLY="" SKIP_GATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --print-context-paths) printf '%s\n' "${CONTEXT_PATHS[@]}"; exit 0 ;;
    --only) [ $# -ge 2 ] || usage; ONLY="$2"; shift 2 ;;
    --skip-gate) SKIP_GATE=1; shift ;;
    -*) usage ;;
    *) [ -z "$COMMIT" ] || usage; COMMIT="$1"; shift ;;
  esac
done
[ -n "$COMMIT" ] || usage
case "$ONLY" in ""|web|bridge) ;; *) usage ;; esac

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_PROFILE:-}" ]; then export AWS_PROFILE=webac; fi
export AWS_REGION="${AWS_REGION:-us-east-1}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --verify "$COMMIT^{commit}")"
# shellcheck source=tools/lib/deploy-gate.sh
. "$REPO/tools/lib/deploy-gate.sh"
gate_check "$REPO" "$SHA" "$SKIP_GATE" || exit 1
if [ -n "${WEBAC_REGISTRY:-}" ]; then
  REGISTRY="$WEBAC_REGISTRY"
else
  REGISTRY="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$AWS_REGION.amazonaws.com"
fi

# 0 = the tag is in the registry, 1 = it isn't, anything else = the lookup failed.
in_registry() { # repo tag
  local err
  if err="$(aws ecr describe-images --repository-name "$1" --image-ids "imageTag=$2" 2>&1 >/dev/null)"; then return 0; fi
  case "$err" in *ImageNotFoundException*) return 1 ;; esac
  echo "$err" >&2
  return 2
}

LOGGED_IN=0
login() {
  [ "$LOGGED_IN" = 1 ] && return 0
  aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  LOGGED_IN=1
}

CTX="" META=""
cleanup() { [ -z "$CTX" ] || rm -rf "$CTX"; [ -z "$META" ] || rm -f "$META"; }
trap cleanup EXIT

# Add tag <new> to the image tagged <have> (immutable tags: a new tag on the same manifest).
retag() { # repo have new
  local manifest err
  manifest="$(aws ecr batch-get-image --repository-name "$1" --image-ids "imageTag=$2" \
    --query 'images[0].imageManifest' --output text)"
  [ -n "$manifest" ] && [ "$manifest" != None ] || return 1
  if ! err="$(aws ecr put-image --repository-name "$1" --image-tag "$3" --image-manifest "$manifest" 2>&1 >/dev/null)"; then
    case "$err" in *ImageAlreadyExistsException*|*ImageTagAlreadyExistsException*) return 0 ;; esac
    echo "$err" >&2
    return 1
  fi
}

for svc in web bridge; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$svc" ] && continue
  repo="webac-$svc"
  image="$REGISTRY/$repo:$SHA"
  rc=0; in_registry "$repo" "$SHA" || rc=$?
  if [ "$rc" = 0 ]; then echo "[images] $svc: $image already in the registry"; continue; fi
  [ "$rc" = 1 ] || { echo "[images] $svc: could not query the registry" >&2; exit 1; }
  src="$(bash "$REPO/tools/image-source.sh" "$REPO" "$svc" "$SHA")"
  if [ "$src" != "$SHA" ]; then
    rc=0; in_registry "$repo" "$src" || rc=$?
    [ "$rc" -le 1 ] || { echo "[images] $svc: could not query the registry" >&2; exit 1; }
    if [ "$rc" = 0 ]; then
      # Cross-check the history walk before reusing an image: no file the service is
      # built from may differ between the two commits (a straight diff, renames as
      # delete + add). A mismatch means image-source.sh picked wrong; never retag then.
      if ! diff_out="$(bash "$REPO/tools/image-source.sh" --same-inputs "$REPO" "$svc" "$src" "$SHA")"; then
        echo "[images] $svc: refusing to tag $repo:${src:0:12} as ${SHA:0:12}: these inputs differ between them:" >&2
        printf '         %s\n' $diff_out >&2
        exit 1
      fi
      retag "$repo" "$src" "$SHA" || { echo "[images] $svc: could not tag $repo:${src:0:12} as ${SHA:0:12}" >&2; exit 1; }
      echo "[images] $svc: $image = $repo:${src:0:12} (nothing it is built from changed)"
      continue
    fi
  fi

  if [ -z "$CTX" ]; then
    CTX="$(mktemp -d "${TMPDIR:-/tmp}/webac-build.XXXXXX")"
    git -C "$REPO" archive "$SHA" "${CONTEXT_PATHS[@]}" | tar -x -C "$CTX"
  fi
  login
  # Tagged with the commit and, when they differ, the source commit later commits retag from.
  [ -n "$META" ] || META="$(mktemp "${TMPDIR:-/tmp}/webac-build-meta.XXXXXX")"
  : >"$META"
  build=(docker buildx build --platform linux/arm64 --provenance=false --sbom=false --push --metadata-file "$META" -t "$image")
  [ "$src" = "$SHA" ] || build+=(-t "$REGISTRY/$repo:$src")
  case "$svc" in
    web) build+=(--build-arg "ACJS_BUILD_ID=${src:0:12}" -f "$CTX/deploy/web/Dockerfile") ;;
    bridge) build+=(-f "$CTX/services/ws-tcp-bridge/Dockerfile") ;;
  esac
  echo "[images] $svc: building $image (source ${src:0:12})"
  if ! "${build[@]}" "$CTX"; then
    # Tags are immutable: a push that lost a race with another builder of the same tag fails.
    if in_registry "$repo" "$SHA"; then echo "[images] $svc: $image was pushed meanwhile"; continue; fi
    echo "[images] $svc: build or push of $image failed" >&2
    exit 1
  fi
  echo "[images] $svc: pushed $image"
  # A rebuild whose output is byte-identical (e.g. an esbuild bundle a new unused export
  # left unchanged) pushes the same digest, so the commit's tag joins an existing image.
  # Say so: it is a real build, not a retag (2026-10-19, ffbc7308 on e9135e09's image).
  digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("containerimage.digest",""))' "$META" 2>/dev/null || true)"
  if [ -n "$digest" ]; then
    tags="$(aws ecr describe-images --repository-name "$repo" --image-ids "imageDigest=$digest" \
      --query 'imageDetails[0].imageTags' --output text 2>/dev/null || true)"
    others="$(printf '%s\n' $tags | grep -v -x -e "$SHA" -e "$src" -e None | cut -c1-12 | tr '\n' ' ' || true)"
    if [ -n "${others// /}" ]; then
      echo "[images] $svc: $digest (built output identical to the image already tagged ${others% })"
    else
      echo "[images] $svc: $digest"
    fi
  fi
done
