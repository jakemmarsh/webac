#!/usr/bin/env bash
# Deploys playwebac.com's static web (the game client + the site pages) to Cloudflare Workers
# Static Assets from this Mac: builds <sha> in a clean worktree, assembles the release
# (tools/build-web-release.mjs) and uploads it with wrangler. The AWS host is not involved, so a
# web deploy can never touch the bridge or its players. docs/web-hosting-cloudflare-plan.md.
#
#   bash tools/deploy-web-cf.sh --ref <sha> [--env staging|production] [--urgent] [--skip-gate] [--dry-run] [--no-rollback]
#
# Both --env values deploy the SAME Worker, `webac-web` (wrangler.jsonc's env.production sets
# name "webac-web" too), and a Worker has one live version that serves every hostname attached to
# it. playwebac.com/* is a zone route a production deploy attached; a staging deploy declares no
# zone routes, so wrangler leaves that route alone (it only PUTs the route list when the config has
# one) and the new version serves playwebac.com as well as next.playwebac.com. So "staging" is NOT
# isolated: every deploy is a production deploy (seen 2026-11-04). The only difference: production
# (re)attaches the playwebac.com/* route.
#
# After uploading, tools/web-cf-ship.sh checks what players load on both hosts (version.json,
# index.html, every JS / CSS it references: 200 within 15 s at the release's size, retried over
# 60 s) and, if that fails, rolls the Worker back to the version live before the deploy and checks
# that (--no-rollback skips it). Manual rollback: npx wrangler@4 rollback <version-id>
# --config deploy/web/cloudflare/wrangler.jsonc -y (instant; older versions stay;
# `npx wrangler@4 versions list --config …` lists them).
# wrangler signs in with `npx wrangler@4 login` (browser OAuth); no key is stored in the repo.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/deploy-gate.sh
. "$REPO/tools/lib/deploy-gate.sh"
REF="" ENV=staging URGENT="" SKIP_GATE=0 DRY=0 NO_ROLLBACK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --env) ENV="$2"; shift 2 ;;
    --urgent) URGENT="--urgent"; shift ;;
    --skip-gate) SKIP_GATE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-rollback) NO_ROLLBACK="--no-rollback"; shift ;;
    *) echo "usage: deploy-web-cf.sh --ref <sha> [--env staging|production] [--urgent] [--skip-gate] [--dry-run] [--no-rollback]" >&2; exit 2 ;;
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
  echo "[cf] dry run: release assembled in $WORK/release (kept; ship it with tools/web-cf-ship.sh --release $WORK/release --build $BUILD)"; trap - EXIT; exit 0
fi
# Deploy, check what players load, roll back on failure (exit non-zero).
bash "$REPO/tools/web-cf-ship.sh" --release "$WORK/release" --build "$BUILD" --env "$ENV" $NO_ROLLBACK
