#!/usr/bin/env bash
# Ships an assembled web release to the Cloudflare Worker `webac-web`, checks what players load,
# and rolls itself back when that fails. tools/deploy-web-cf.sh builds the release and runs this;
# run it alone to re-ship a release a --dry-run kept.
#
#   bash tools/web-cf-ship.sh --release <dir> --build <id> [--env staging|production] [--no-rollback]
#
# 1. Before deploying: the live Worker version id (`wrangler deployments status --json`) and the
#    build playwebac.com serves (version.json) are the rollback target. If either can't be read,
#    nothing is deployed (pass --no-rollback to deploy without a way back).
# 2. `wrangler deploy` with the release as the assets directory.
# 3. tools/verify-web-deploy.mjs on every host (WEBAC_CF_HOSTS, default playwebac.com AND
#    next.playwebac.com, for BOTH --env values: they are one Worker, so a "staging" deploy changes
#    what playwebac.com serves too): version.json = <build>, index.html = the release's, and every
#    /assets/*.js / *.css it references 200 within 15 s at the release file's size, retried over 60 s.
# 4. On failure: `wrangler rollback <previous id>`, the same check against the previous build, and
#    exit 1 (3 when the rollback's check fails too). --no-rollback: report and exit 1, live as is.
#
# Why (2026-11-04): a production deploy's new 4.9 MB entry bundle answered HTTP 500 after ~47 s for
# minutes while version.json and index.html looked fine; no new page load could boot the game.
# docs/web-hosting-cloudflare-plan.md, "Deploy verification and automatic rollback".
# Test knobs: WEBAC_CF_HOSTS, WEBAC_CF_VERIFY_WINDOW_MS / _INTERVAL_MS / _TIMEOUT_MS.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE="" BUILD="" ENV=staging ROLLBACK=1
usage() { echo "usage: web-cf-ship.sh --release <dir> --build <id> [--env staging|production] [--no-rollback]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --env) ENV="$2"; shift 2 ;;
    --no-rollback) ROLLBACK=0; shift ;;
    *) usage ;;
  esac
done
case "$ENV" in staging|production) ;; *) echo "--env must be staging or production" >&2; exit 2 ;; esac
[ -n "$RELEASE" ] && [ -n "$BUILD" ] || usage
[ -f "$RELEASE/index.html" ] || { echo "[cf] $RELEASE/index.html missing: not a release" >&2; exit 2; }
HOSTS="${WEBAC_CF_HOSTS:-https://playwebac.com,https://next.playwebac.com}"
FIRST_HOST="${HOSTS%%,*}"
CFG=(--config "$REPO/deploy/web/cloudflare/wrangler.jsonc")
[ "$ENV" = production ] && CFG+=(--env production)
wrangler() { (cd "$REPO" && npx --yes wrangler@4 "$@"); }
verify() { # build
  node "$REPO/tools/verify-web-deploy.mjs" --hosts "$HOSTS" --build "$1" --release "$RELEASE" "${@:2}" \
    --window-ms "${WEBAC_CF_VERIFY_WINDOW_MS:-60000}" --interval-ms "${WEBAC_CF_VERIFY_INTERVAL_MS:-10000}" \
    --timeout-ms "${WEBAC_CF_VERIFY_TIMEOUT_MS:-15000}"
}
loud() { printf '\n[cf] ########################################################################\n'; printf '[cf] %s\n' "$@"; printf '[cf] ########################################################################\n\n'; }

PREV_ID="" PREV_BUILD=""
if [ "$ROLLBACK" = 1 ]; then
  STATUS="$(wrangler deployments status --json "${CFG[@]}" 2>/dev/null || true)"
  PREV_ID="$(printf '%s' "$STATUS" | node --input-type=module -e "
    import { liveVersionId } from '$REPO/tools/lib/web-deploy-verify.mjs';
    let s = ''; for await (const c of process.stdin) s += c;
    process.stdout.write(liveVersionId(s.slice(s.indexOf('{'))) ?? '');")"
  PREV_BUILD="$(curl -fsS --max-time 15 "$FIRST_HOST/version.json" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).build??''))}catch{}})" || true)"
  if [ -z "$PREV_ID" ] || [ -z "$PREV_BUILD" ]; then
    echo "[cf] can't read the rollback target (live version id '${PREV_ID}', $FIRST_HOST build '${PREV_BUILD}'): not deploying." >&2
    echo "[cf] fix wrangler's login (npx wrangler@4 login) or pass --no-rollback to deploy without one." >&2
    exit 1
  fi
  echo "[cf] rollback target: version $PREV_ID (build $PREV_BUILD)"
fi

# --assets replaces only assets.directory: the config's `main` (report-worker.mjs, run only for
# /__webac/* via assets.run_worker_first), the ASSETS binding and observability still deploy.
wrangler deploy "${CFG[@]}" --assets "$RELEASE"

echo "[cf] verifying build $BUILD on $HOSTS"
if verify "$BUILD" --match-index; then
  echo "[cf] build $BUILD verified on $HOSTS"
  exit 0
fi

if [ "$ROLLBACK" = 0 ]; then
  loud "DEPLOY OF $BUILD FAILED ITS ASSET CHECK AND IS STILL LIVE (--no-rollback)." \
       "Players' page loads may not boot. Roll back by hand: npx wrangler@4 rollback <version-id> ${CFG[*]} -y"
  exit 1
fi

loud "DEPLOY OF $BUILD FAILED ITS ASSET CHECK: ROLLING BACK to version $PREV_ID (build $PREV_BUILD)."
wrangler rollback "$PREV_ID" "${CFG[@]}" -y -m "auto rollback: build $BUILD failed deploy-web-cf asset check"
echo "[cf] verifying the rollback (build $PREV_BUILD) on $HOSTS"
if verify "$PREV_BUILD"; then
  loud "ROLLED BACK: $HOSTS serve build $PREV_BUILD again, checked." \
       "Build $BUILD was NOT shipped. Redeploy it once the cause above is understood (a transient Cloudflare" \
       "asset fault clears on a redeploy, as on 2026-11-04)."
  exit 1
fi
loud "ROLLBACK TO $PREV_ID (build $PREV_BUILD) ALSO FAILED ITS CHECK. playwebac.com may be down for new page loads." \
     "Check by hand: curl -sS -o /dev/null -w '%{http_code} %{time_total}\\n' $FIRST_HOST/assets/<entry>.js" \
     "DNS fallback: bash tools/aws-cutover.sh web-aws (docs/web-hosting-cloudflare-plan.md)."
exit 3
