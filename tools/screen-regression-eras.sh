#!/usr/bin/env bash
# screen-regression-eras.sh — tools/screen-regression.ts once per supported era,
# one after another (each run is a headless browser pair; never in parallel).
# End of retail is judged against ACE; the classic eras against the local
# ClassicACE (CustomDM) and GDL-Classic servers (docs/dark-majesty-support.md),
# so a change to shared code is proven pixel-neutral for every era it touches.
#
#   bash tools/screen-regression-eras.sh [screen-regression args…]   # e.g. --ui --base origin/main
#   ERAS="classic-dereth" bash tools/screen-regression-eras.sh --ui --calibrate
#
# Each era needs its server, a bridge pinned to it and a character on the
# account (default acjsregress; created once with tools/gdle/probe-flow.ts …
# login create:<Name> enter world logout). Bridges (override per era):
#   EOR_BRIDGE   ws://localhost:9097  → ACE 9000/9001
#   CACE_BRIDGE  ws://localhost:9098  → ClassicACE CustomDM 9200/9201 (BRIDGE_ERA=classicace-customdm)
#   GDL_BRIDGE   ws://localhost:9099  → GDL-Classic 9210/9211 (BRIDGE_ERA=classic-dereth)
# Classic eras capture the pre-world flow plus CLASSIC_PANELS (default below),
# not every panel: they load whole DATs (~1 GB) into one long-lived headless
# page, and after ~30 panel captures SwiftShader's GPU process dies and every
# WebGL and 2D context is lost (2026-10-06, reproduced twice). The default set
# covers the HUD, inventory, character, magic and social panels.
# Outputs: verification/screen-regression{,-<era>}/report.md. Exit 1 if any era
# reports unexpected changes.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ACCOUNT="${ACJS_ACCOUNT:-acjsregress}"
ERAS="${ERAS:-eor classicace-customdm classic-dereth}"
CLASSIC_PANELS="${CLASSIC_PANELS:-hud-overview inventory char-attributes char-skills char-titles magic-spellbook social-fellowship}"
rc=0
for era in $ERAS; do
  case "$era" in
    eor) bridge="${EOR_BRIDGE:-ws://localhost:9097}"; era_env="" ;;
    classicace-customdm) bridge="${CACE_BRIDGE:-ws://localhost:9098}"; era_env="$era" ;;
    classic-dereth) bridge="${GDL_BRIDGE:-ws://localhost:9099}"; era_env="$era" ;;
    *) echo "[eras] unknown era $era" >&2; exit 2 ;;
  esac
  echo "=== [eras] $era via $bridge as $ACCOUNT"
  # shellcheck disable=SC2086
  ACJS_ERA="$era_env" ACJS_BRIDGE="$bridge" ACJS_ACCOUNT="$ACCOUNT" \
    npx tsx "$REPO/tools/screen-regression.ts" "$@" ${era_env:+$CLASSIC_PANELS} || rc=1
done
exit $rc
