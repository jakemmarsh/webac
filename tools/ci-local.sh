#!/usr/bin/env bash
# ci-local.sh — run the CI job (.github/workflows/ci.yml) on this machine.
#
# GitHub Actions minutes run out now and then, and main CI then fails in
# seconds with no runner (the "infra signature"). When that happens this
# script is the gate for cloud and local sessions alike. It runs, in order:
#
#   1. `npm run build` (tsc -b) — the CI "Type check" step
#   2. full `npm test` in THIS checkout — DATs + reference present, the
#      superset suite
#   3. `npm test` in a CI-SHAPED worktree of HEAD — only git-tracked files
#      plus the ACE reference (CI clones pinned ACE), so no dat/, no
#      reference/client-eol, no images. This is what catches a test that
#      passes only because a gitignored file happens to exist here (the
#      describe.skipIf collection-time ENOENT landmine that broke main for
#      4 h on 2026-07-21).
#
# Dependencies: CI runs `npm ci` from package-lock.json. Before step 3 this
# compares HEAD's package-lock.json with what is installed here
# (node_modules/.package-lock.json, tools/lockfile-drift.mjs). In sync:
# the CI-shaped worktree reuses this node_modules (fast). Drift, or no
# hidden lockfile to compare: it runs `npm ci --prefer-offline` in the
# worktree instead, so step 3 tests the tree CI will install. It prints
# which it did. Steps 1-2 always use this checkout's node_modules; a drift
# warning is printed up front so a pass there is read with that in mind.
#
# Usage: bash tools/ci-local.sh            # all three
#        bash tools/ci-local.sh --ci-shape # step 3 only (after your own suite)
#
# Step 3 tests HEAD, so commit first. Exit status is non-zero on any failure.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

ONLY_SHAPE=0
[[ "${1:-}" == "--ci-shape" ]] && ONLY_SHAPE=1

# Lockfile drift: HEAD's lockfile vs the installed tree (exit 0 in sync,
# 1 drift, 2 can't tell). Never fatal on its own.
LOCK_TMP="$(mktemp "${TMPDIR:-/tmp}/acjs-lock.XXXXXX")"
git show HEAD:package-lock.json >"$LOCK_TMP"
DRIFT=0
node tools/lockfile-drift.mjs "$LOCK_TMP" "$ROOT/node_modules/.package-lock.json" || DRIFT=$?
rm -f "$LOCK_TMP"
if [[ $DRIFT -ne 0 && $ONLY_SHAPE -eq 0 ]]; then
  echo "[ci-local] WARNING: steps 1-2 use this checkout's node_modules, which does not match package-lock.json (run 'npm ci' to fix); step 3 installs from the lockfile."
fi

if [[ $ONLY_SHAPE -eq 0 ]]; then
  echo "[ci-local] 1/3 type check (npm run build)"
  npm run build
  echo "[ci-local] 2/3 full suite in this checkout"
  npm test
fi

echo "[ci-local] 3/3 suite in a CI-shaped worktree of $(git rev-parse --short HEAD)"
WT="$(mktemp -d "${TMPDIR:-/tmp}/acjs-ci-shape.XXXXXX")"
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; }
trap cleanup EXIT
git worktree add --detach --no-checkout -q "$WT" HEAD
# Same sparse checkout as CI (read from ci.yml's `sparse-checkout: |` block,
# so the two can't drift): verification images/html are left out.
SPARSE=()
while IFS= read -r pat; do SPARSE+=("$pat"); done < <(awk '/sparse-checkout: \|/{on=1; next} on && /^ *[\/!]/{sub(/^ +/, ""); print; next} on{exit}' "$ROOT/.github/workflows/ci.yml")
if [[ ${#SPARSE[@]} -gt 0 ]]; then
  git -C "$WT" sparse-checkout set --no-cone "${SPARSE[@]}"
fi
git -C "$WT" checkout -q --detach HEAD
if [[ $DRIFT -eq 0 ]]; then
  echo "[ci-local] deps: node_modules matches HEAD's package-lock.json, reusing it (symlinked)"
  ln -s "$ROOT/node_modules" "$WT/node_modules"
  for pkg in "$ROOT"/packages/*/node_modules "$ROOT"/services/*/node_modules; do
    [[ -d "$pkg" ]] || continue
    rel="${pkg#"$ROOT"/}"
    ln -s "$pkg" "$WT/$rel"
  done
else
  echo "[ci-local] deps: node_modules differs from HEAD's package-lock.json (or can't be compared), running npm ci --prefer-offline in the CI-shaped worktree"
  (cd "$WT" && npm ci --prefer-offline --no-audit --no-fund)
fi
# CI clones ACE at the pinned ref; everything else under reference/ is absent.
if [[ -d "$ROOT/reference/ACE" ]]; then
  mkdir -p "$WT/reference"
  ln -s "$ROOT/reference/ACE" "$WT/reference/ACE"
  PIN="$(grep -oE 'ACE_REF: [0-9a-f]{40}' .github/workflows/ci.yml | awk '{print $2}')"
  HAVE="$(git -C "$ROOT/reference/ACE" rev-parse HEAD 2>/dev/null || echo none)"
  [[ "$PIN" == "$HAVE" ]] || echo "[ci-local] note: reference/ACE is $HAVE, CI pins $PIN"
fi
(cd "$WT" && npm run build >/dev/null && npm test)
echo "[ci-local] PASS — type check, full suite, CI-shaped suite"
