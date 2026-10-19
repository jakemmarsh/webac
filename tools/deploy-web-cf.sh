#!/usr/bin/env bash
# Deploys playwebac.com's static web (the game client + the site pages) to Cloudflare Workers
# Static Assets from this Mac: builds <sha> in a clean worktree, assembles the release
# (tools/build-web-release.mjs) and uploads it with wrangler. The AWS host is not involved, so a
# web deploy can never touch the bridge or its players. docs/web-hosting-cloudflare-plan.md.
#
#   bash tools/deploy-web-cf.sh --ref <sha> [--env staging|production] [--urgent] [--skip-gate] [--dry-run]
#
# staging (default) deploys the Worker with only next.playwebac.com; production also carries the
# playwebac.com/* route (inert until that A record is proxied). Rollback: npx wrangler@4 rollback
# --config deploy/web/cloudflare/wrangler.jsonc [--env production] (instant; older versions stay).
# wrangler signs in with `npx wrangler@4 login` (browser OAuth); no key is stored in the repo.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/deploy-gate.sh
. "$REPO/tools/lib/deploy-gate.sh"
REF="" ENV=staging URGENT="" SKIP_GATE=0 DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --env) ENV="$2"; shift 2 ;;
    --urgent) URGENT="--urgent"; shift ;;
    --skip-gate) SKIP_GATE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "usage: deploy-web-cf.sh --ref <sha> [--env staging|production] [--urgent] [--skip-gate] [--dry-run]" >&2; exit 2 ;;
  esac
done
case "$ENV" in staging|production) ;; *) echo "--env must be staging or production" >&2; exit 2 ;; esac
[ -n "$REF" ] || { echo "--ref <sha> is required" >&2; exit 2; }
git -C "$REPO" fetch -q origin
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
gate_check "$REPO" "$SHA" "$SKIP_GATE"
BUILD="${SHA:0:12}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/webac-cf-${BUILD}-XXXX")"
cleanup() { git -C "$REPO" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
echo "[cf] building $BUILD in $WORK/src"
git -C "$REPO" worktree add -q --detach "$WORK/src" "$SHA"
# The main checkout's node_modules (the build needs no native modules; same lockfile check as CI).
MAIN="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)/.."
ln -s "$(cd "$MAIN" && pwd)/node_modules" "$WORK/src/node_modules"
(cd "$WORK/src" && NODE_OPTIONS=--max-old-space-size=4096 ACJS_BUILD_ID="$BUILD" npx vite build --outDir "$WORK/dist" --emptyOutDir >/dev/null)
# The release tooling and config come from this checkout; the client and its site pages from <sha>.
node "$REPO/tools/build-web-release.mjs" --dist "$WORK/dist" --site "$WORK/src/deploy/web/site" --out "$WORK/release" --build "$BUILD" $URGENT
if [ "$DRY" = 1 ]; then
  git -C "$REPO" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true
  echo "[cf] dry run: release assembled in $WORK/release (kept)"; trap - EXIT; exit 0
fi
# --assets replaces only assets.directory: the config's `main` (report-worker.mjs, run only for
# /__webac/* via assets.run_worker_first), the ASSETS binding and observability still deploy.
ARGS=(--config "$REPO/deploy/web/cloudflare/wrangler.jsonc" --assets "$WORK/release")
[ "$ENV" = production ] && ARGS+=(--env production)
(cd "$REPO" && npx --yes wrangler@4 deploy "${ARGS[@]}")
HOST=next.playwebac.com
echo "[cf] $HOST/version.json: $(curl -fsS "https://$HOST/version.json" || echo unreachable)"
