#!/usr/bin/env bash
# screen-regression-eras.sh — tools/screen-regression.ts once per supported era,
# one after another (each run is a headless browser pair; never in parallel).
# End of retail is judged against ACE; the classic eras against the local
# ClassicACE (CustomDM) and GDL-Classic servers (docs/dark-majesty-support.md);
# AC1999 against the local AC1999 server (docs/ac1999-support.md), so a change
# to shared code is proven pixel-neutral for every era it touches.
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
#   AC1999_BRIDGE ws://localhost:9312 → the acjs-ac1999-server container (BRIDGE_ERA=ac1999-retail)
# AC1999 account names are 8 characters at most: AC1999_ACCOUNT (default
# acjsrg99). Its character needs a filled side pack and a used kit on the
# toolbar for the inventory-sidepack / toolbar-used-kit captures, made once
# with `npx tsx tools/ac1999-playthrough.ts --era ac1999-retail --base
# http://localhost:<vite>/ --bridge ws://localhost:9312 --account acjsrg99
# --admin --only pack-bars` (an admin account on the local AC1999 server).
# AC1999 captures the pre-world flow (char select = preworld/login) plus
# AC1999_PANELS; its noise floors are verification/screen-regression-noise.
# ac1999-retail.json, made by the first run with --calibrate:
#   ERAS=ac1999-retail bash tools/screen-regression-eras.sh --ui --calibrate
# Classic eras capture the pre-world flow plus CLASSIC_PANELS (default below),
# not every panel: they load whole DATs (~1 GB) into one long-lived headless
# page, and after ~30 panel captures SwiftShader's GPU process dies and every
# WebGL and 2D context is lost (2026-10-06, reproduced twice). The default set
# covers the HUD, inventory, character, magic and social panels.
# SCREEN_CAPTURES="<names>" narrows every era to those captures (within the era's
# own set); tools/live-gate.sh --fast sets it from the diff.
# Outputs: verification/screen-regression{,-<era>}/report.md. Exit 1 if any era
# reports unexpected changes.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ACCOUNT="${ACJS_ACCOUNT:-acjsregress}"
ERAS="${ERAS:-eor classicace-customdm classic-dereth ac1999-retail}"
CLASSIC_PANELS="${CLASSIC_PANELS:-hud-overview inventory char-attributes char-skills char-titles magic-spellbook social-fellowship}"
# AC1999: the HUD, the inventory with a filled side pack, the toolbar with a
# used kit, and the options panel's Config page (1999's Performance options).
AC1999_PANELS="${AC1999_PANELS:-hud-overview inventory inventory-sidepack toolbar-used-kit options-config}"
rc=0
for era in $ERAS; do
  account="$ACCOUNT"
  case "$era" in
    eor) bridge="${EOR_BRIDGE:-ws://localhost:9097}"; era_env=""; panels="" ;;
    classicace-customdm) bridge="${CACE_BRIDGE:-ws://localhost:9098}"; era_env="$era"; panels="$CLASSIC_PANELS" ;;
    classic-dereth) bridge="${GDL_BRIDGE:-ws://localhost:9099}"; era_env="$era"; panels="$CLASSIC_PANELS" ;;
    ac1999-retail) bridge="${AC1999_BRIDGE:-ws://localhost:9312}"; era_env="$era"; panels="$AC1999_PANELS"; account="${AC1999_ACCOUNT:-acjsrg99}" ;;
    *) echo "[eras] unknown era $era" >&2; exit 2 ;;
  esac
  if [ "$era" = ac1999-retail ] && [ "${#account}" -gt 8 ]; then
    echo "[eras] AC1999 account names are 8 characters at most: $account" >&2; rc=1; continue
  fi
  # SCREEN_CAPTURES (the live gate's fast tier, tools/lib/live-gate-scope.ts): only these captures, within
  # the era's own set (end of retail: every capture); none in the era's set → hud-overview alone.
  if [ -n "${SCREEN_CAPTURES:-}" ]; then
    picked=""
    for c in $SCREEN_CAPTURES; do
      if [ -z "$panels" ]; then picked="$picked $c"
      else case " $panels " in *" $c "*) picked="$picked $c" ;; esac; fi
    done
    panels="${picked# }"
    [ -n "$panels" ] || panels="hud-overview"
  fi
  echo "=== [eras] $era via $bridge as $account${SCREEN_CAPTURES:+ (captures: $panels)}"
  # shellcheck disable=SC2086
  ACJS_ERA="$era_env" ACJS_BRIDGE="$bridge" ACJS_ACCOUNT="$account" \
    npx tsx "$REPO/tools/screen-regression.ts" "$@" $panels || rc=1
done
exit $rc
