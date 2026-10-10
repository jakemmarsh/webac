# shellcheck shell=bash
# provision-lib.sh — helpers tools/provision-remote-env.sh sources, split out
# so tests/verify-provision-lib.ts can drive them. Defines functions only.

# needs_rebuild OUT INPUT... — true (0) when OUT is missing/empty or any
# existing INPUT is newer than it (-nt); false (1) otherwise. Missing inputs
# are ignored. The derived reference files (symbols/globals.tsv, the annotated
# decomp) used to be built only when ABSENT, so a fixed extractor/annotator
# (or a re-exported decomp) never reached an already-provisioned tree and the
# stale annotated decomp kept serving old values (OPS.screen-regression-
# thresholds, 2026-09-26).
needs_rebuild() {
  local out="$1"; shift
  [[ -s "$out" ]] || return 0
  local in
  for in in "$@"; do [[ -e "$in" && "$in" -nt "$out" ]] && return 0; done
  return 1
}
