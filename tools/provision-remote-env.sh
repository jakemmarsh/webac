#!/usr/bin/env bash
# provision-remote-env.sh — bootstrap a fresh (remote/ephemeral) clone to the
# point where the test suite is fully green and the client boots in a browser.
#
# A fresh clone is missing two gitignored layers:
#   1. reference/ACE — the ACE C# server source. 85 test files read enum/
#      handler sources from it; it is also the mandatory research target for
#      FAITHFUL/FORMULA work. Public repo, shallow clone suffices.
#   2. dat/ — the End-of-Retail DAT files. Without them the client fatals at
#      boot and 695 DAT-gated tests skip. Fetched + validated by
#      tools/fetch-eor-dats.mjs (see its header for provenance).
#
# Idempotent — safe to run on every session start (e.g. from a SessionStart
# hook). Verified 2026-07-04 in Claude Code on the web: took a cold container
# from "85 broken test files, client won't render" to "10,528 tests passing,
# client boots to character select".
#
# reference/client-eol (decompiled retail client) + reference/images (retail
# screenshot corpus) are fetched from a PRIVATE tarball when
# ACJS_REFERENCE_BUNDLE_URL is set (see below); without it they stay absent and
# VISUAL-lane work is fenced off (a `.provision-lanes` marker records which
# lanes are usable). These are the authoritative references for VISUAL work.
#
# NOT covered here (still needs local/user setup): the ACE server + MySQL
# stack (docker-compose on the primary dev machine), world-db-raw/.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -d "$REPO/node_modules" ]]; then
  echo "[provision] npm install…"
  (cd "$REPO" && npm install)
fi

if [[ ! -d "$REPO/reference/ACE/Source" ]]; then
  echo "[provision] shallow-cloning ACE C# source…"
  git clone --depth 1 https://github.com/ACEmulator/ACE.git "$REPO/reference/ACE"
else
  echo "[provision] reference/ACE: ok"
fi

# ACViewer — CLAUDE.md's designated original-rendering reference (public repo;
# used 2026-07-05 to anchor the GAP.3 water disposition).
if [[ ! -d "$REPO/reference/ACViewer/ACViewer" ]]; then
  echo "[provision] shallow-cloning ACViewer…"
  git clone --depth 1 https://github.com/ACEmulator/ACViewer.git "$REPO/reference/ACViewer"
else
  echo "[provision] reference/ACViewer: ok"
fi

echo "[provision] ensuring EoR DAT files…"
node "$REPO/tools/fetch-eor-dats.mjs"

# reference/client-eol (decompiled retail client) + reference/images (retail
# screenshot corpus) — the two authoritative layers for VISUAL-lane work.
# These are NOT public: the decompiled acclient must never be hosted publicly,
# and the screenshots are a curated private corpus. Default source is the
# in-repo orphan branch `reference-bundle` (this repo is PRIVATE and must stay
# so while that branch exists; fetched with the same credentials as the clone,
# ghidra-proj excluded — regenerate per client-eol/ExportDecompiled.java).
# ACJS_REFERENCE_BUNDLE_URL (a private tarball URL extracting to `client-eol/`
# + `images/` at reference/ root) overrides it. See docs/remote-agent-ops.md §2.
VISUAL_LANE_OK=1
have_client_eol() { [[ -f "$REPO/reference/client-eol/symbols/demangled.txt" ]]; }
have_images()     { [[ -d "$REPO/reference/images" ]] && [[ -n "$(ls -A "$REPO/reference/images" 2>/dev/null)" ]]; }

if have_client_eol && have_images; then
  echo "[provision] reference/client-eol + reference/images: ok"
elif [[ -n "${ACJS_REFERENCE_BUNDLE_URL:-}" ]]; then
  echo "[provision] fetching private reference bundle (client-eol + images)…"
  tmp="$(mktemp)"
  if curl -fsSL "$ACJS_REFERENCE_BUNDLE_URL" -o "$tmp"; then
    tar -xzf "$tmp" -C "$REPO/reference"
    rm -f "$tmp"
    if have_client_eol && have_images; then
      echo "[provision] reference/client-eol + reference/images: fetched"
    else
      echo "[provision] WARN: bundle extracted but layers still incomplete — check tarball layout (expects client-eol/ + images/ at reference/ root)"
      VISUAL_LANE_OK=0
    fi
  else
    rm -f "$tmp"
    echo "[provision] WARN: could not fetch ACJS_REFERENCE_BUNDLE_URL"
    VISUAL_LANE_OK=0
  fi
elif git -C "$REPO" fetch --depth 1 origin reference-bundle 2>/dev/null; then
  echo "[provision] extracting reference bundle from in-repo branch reference-bundle…"
  mkdir -p "$REPO/reference"
  git -C "$REPO" archive --format=tar FETCH_HEAD client-eol images | tar -x -C "$REPO/reference"
  if have_client_eol && have_images; then
    echo "[provision] reference/client-eol + reference/images: fetched from reference-bundle branch"
  else
    echo "[provision] WARN: reference-bundle branch extracted but layers still incomplete"
    VISUAL_LANE_OK=0
  fi
else
  echo "[provision] WARN: reference/client-eol + reference/images absent; reference-bundle branch unreachable and ACJS_REFERENCE_BUNDLE_URL unset."
  VISUAL_LANE_OK=0
fi

# Derived reference files are rebuilt when missing OR older than any input
# (needs_rebuild, tools/provision-lib.sh).
# shellcheck source=tools/provision-lib.sh
source "$REPO/tools/provision-lib.sh"
CE="$REPO/reference/client-eol"

# symbols/globals.tsv — every named global / constant in the retail client with
# its initial value (Ghidra shows these as bare names). Derived from the bundle's
# acclient.pdb + .exe + decomp in ~5s, so it is generated here, not stored.
if [[ -f "$CE/acclient.pdb" ]] && needs_rebuild "$CE/symbols/globals.tsv" \
    "$CE/acclient.pdb" "$CE/acclient.exe" "$CE/decomp/acclient-decompiled.c" \
    "$REPO/tools/extract-pdb-globals.ts" "$REPO/tools/pdb-globals-lib.ts"; then
  echo "[provision] extracting retail globals → reference/client-eol/symbols/globals.tsv…"
  (cd "$REPO" && npx tsx tools/extract-pdb-globals.ts) || echo "[provision] WARN: globals extraction failed (non-fatal)"
fi
# decomp/acclient-decompiled.annotated.c — the decomp with each referenced
# global's value appended at end of line (same line numbers). This is the file
# to READ; the plain one stays byte-identical for the tests that match its lines.
# Rebuilt when globals.tsv (possibly just regenerated above), the plain decomp
# or either annotator source is newer.
if [[ -s "$CE/symbols/globals.tsv" && -f "$CE/decomp/acclient-decompiled.c" ]] \
    && needs_rebuild "$CE/decomp/acclient-decompiled.annotated.c" \
      "$CE/symbols/globals.tsv" "$CE/decomp/acclient-decompiled.c" \
      "$REPO/tools/annotate-decomp-globals.ts" "$REPO/tools/decomp-annotate-lib.ts" \
      "$REPO/tools/extract-pdb-globals.ts" "$REPO/tools/pdb-globals-lib.ts"; then
  echo "[provision] annotating the decomp → reference/client-eol/decomp/acclient-decompiled.annotated.c…"
  (cd "$REPO" && npx tsx tools/annotate-decomp-globals.ts) || echo "[provision] WARN: decomp annotation failed (non-fatal)"
fi

# Record lane availability so the agent can fence itself out of VISUAL work
# when the authoritative references are missing (see docs/remote-agent-ops.md §2/§3).
if [[ "$VISUAL_LANE_OK" == "1" ]]; then
  echo "visual" > "$REPO/.provision-lanes"
  echo "[provision] lanes available: server-logic + visual"
else
  echo "server-logic-only" > "$REPO/.provision-lanes"
  echo "[provision] lanes available: server-logic ONLY (VISUAL lanes fenced — missing client-eol/images)"
fi

# Real git hooks (commit-msg tests-with-code rule, pre-push tsc -b gate).
# A fresh clone has no core.hooksPath, so without this neither hook runs.
git -C "$REPO" config core.hooksPath tools/githooks
echo "[provision] git hooks: core.hooksPath=tools/githooks (commit-msg, pre-push)"
echo "[provision] done"
