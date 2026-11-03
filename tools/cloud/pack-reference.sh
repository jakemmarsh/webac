#!/usr/bin/env bash
# pack-reference.sh — build the private reference archive that tools/cloud/fetch-reference.sh extracts
# in a cloud session, from this (Jake's) checkout. It only writes a local file; where it is hosted is
# Jake's choice (docs/cloud-sessions.md). Never publish it: it holds the decompiled retail client.
#
#   bash tools/cloud/pack-reference.sh [--out ~/acjs-reference.tar.gz] [--with-classic-1.0] [--repo <checkout>]
#
# Holds what the tests and research read that no public source has: reference/client-eol (no
# ghidra-proj), reference/images, reference/ac1999 (no Ghidra project, server build output or VCS
# metadata), reference/classic, reference/plugin-specs, reference/vtank-*, and the 1999 client
# dat-sets/ac1999-retail/client.exe. --with-classic-1.0 adds dat-sets/classic-dereth-1.0 (~1.2 GB; not
# on dats.playwebac.com). Prints the size and the sha256 to put in ACJS_REFERENCE_SHA256.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
out="$HOME/acjs-reference.tar.gz" classic10=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --with-classic-1.0) classic10=1; shift ;;
    --repo) repo="$(cd "$2" && pwd)"; shift 2 ;;  # another checkout's reference/ (a worktree has none)
    *) echo "pack-reference: unknown argument $1" >&2; exit 2 ;;
  esac
done
cd "$repo"
paths=()
for p in reference/client-eol reference/images reference/ac1999 reference/classic reference/plugin-specs \
         reference/vtank-corpus reference/vtank-mosstank dat-sets/ac1999-retail/client.exe; do
  [ -e "$p" ] && paths+=("$p") || echo "pack-reference: (absent here, skipped) $p" >&2
done
[ "$classic10" = 1 ] && [ -d dat-sets/classic-dereth-1.0 ] && paths+=(dat-sets/classic-dereth-1.0)
# Never write the archive inside what it packs (a symlinked output dir can land there).
outdir="$(mkdir -p "$(dirname "$out")" && cd "$(dirname "$out")" && pwd -P)"
for p in "${paths[@]}"; do
  real="$(cd "$(dirname "$p")" && pwd -P)/$(basename "$p")"
  case "$outdir/" in "$real"/*) echo "pack-reference: --out is inside $p ($outdir); pick another directory" >&2; exit 2 ;; esac
done
# -h stores symlinked files as files (fetch-reference.sh refuses links).
COPYFILE_DISABLE=1 tar -czhf "$out" \
  --exclude='.git' --exclude='.claude' --exclude='.DS_Store' --exclude='node_modules' --exclude='.venv' --exclude='__pycache__' \
  --exclude='reference/client-eol/ghidra-proj' --exclude='reference/ac1999/Client/GhidraProject' \
  --exclude='reference/ac1999/Server/Bin' --exclude='*/bin/Debug' --exclude='*/bin/Release' --exclude='*/obj' \
  "${paths[@]}"
sum="$( (sha256sum "$out" 2>/dev/null || shasum -a 256 "$out") | cut -d' ' -f1)"
echo "pack-reference: wrote $out ($(( $(wc -c < "$out") >> 20 )) MB)"
echo "pack-reference: ACJS_REFERENCE_SHA256=$sum"
