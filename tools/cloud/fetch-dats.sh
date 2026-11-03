#!/usr/bin/env bash
# fetch-dats.sh — put the DAT files the test suite opens into this checkout, from the public production
# raw sets on dats.playwebac.com (docs/cloud-sessions.md). Without them ~3,000 DAT-gated tests skip.
#
#   bash tools/cloud/fetch-dats.sh                    # every group (about 5.2 GB)
#   bash tools/cloud/fetch-dats.sh --groups eol       # end of retail only (1.4 GB)
#   bash tools/cloud/fetch-dats.sh --groups eol,ac1999 --verify   # re-hash cached files
#   bash tools/cloud/fetch-dats.sh --status           # what is present, downloads nothing
#
# Groups (tools/cloud/dat-files.tsv): eol (dat/), ac1999, classic-dereth, customdm, infiltration (dat-sets/).
# Files are downloaded once into a cache outside the checkout (ACJS_DAT_CACHE, default
# ~/.cache/acjs/dats), verified against the pinned size + sha256, and symlinked into dat/ and dat-sets/
# at the paths the tests read; dat/sets/<era> gets the same aliases as Jake's checkout. Re-runs verify
# nothing they already verified (a .ok stamp) and only download what is missing; an interrupted download
# resumes. A real (non-symlink) file already at a repo path is never touched.
#
# Env: ACJS_DAT_GROUPS (default all), ACJS_DAT_CACHE, ACJS_DAT_BASE_URL (default
# https://dats.playwebac.com/v1/raw), ACJS_DAT_MANIFEST (default tools/cloud/dat-files.tsv),
# ACJS_DAT_JOBS (parallel downloads, default 4), ACJS_DAT_REPO (the checkout, default this one).
# Exit 0 when every requested file is in place, 1 otherwise.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${ACJS_DAT_REPO:-$(cd "$here/../.." && pwd)}"
MANIFEST="${ACJS_DAT_MANIFEST:-$here/dat-files.tsv}"
BASE="${ACJS_DAT_BASE_URL:-https://dats.playwebac.com/v1/raw}"
CACHE="${ACJS_DAT_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/acjs/dats}"
JOBS="${ACJS_DAT_JOBS:-4}"
export REPO MANIFEST BASE CACHE

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else openssl dgst -sha256 -r "$1" | cut -d' ' -f1; fi
}
size_of() { wc -c < "$1" | tr -d ' '; }

# One manifest row: download (if needed), verify, link. Prints one result line.
fetch_one() {
  local group="$1" dest="$2" raw="$3" size="$4" sha="$5" verify="$6"
  local target="$REPO/$dest" cached="$CACHE/$raw"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    if [ "$(size_of "$target")" = "$size" ]; then echo "ok        $dest (this checkout's own file)"; return 0; fi
    echo "FAILED    $dest: a different file is already there (size $(size_of "$target"), expected $size); left alone"; return 1
  fi
  local stamp="$cached.ok" how="cached"
  if [ -f "$cached" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$sha $size" ] && [ "$(size_of "$cached")" = "$size" ] && [ "$verify" != 1 ]; then
    :
  else
    rm -f "$stamp"
    if [ ! -f "$cached" ] || [ "$(size_of "$cached")" != "$size" ]; then
      mkdir -p "$(dirname "$cached")"
      local part="$cached.part"
      [ -f "$part" ] && [ "$(size_of "$part")" -gt "$size" ] && rm -f "$part"
      if ! curl -fsSL --retry 5 --retry-delay 3 --connect-timeout 20 -C - -o "$part" "$BASE/$raw"; then
        # A finished .part makes curl's resume fail with 416; it is checked below like any other.
        [ -f "$part" ] && [ "$(size_of "$part")" = "$size" ] || { echo "FAILED    $dest: download of $BASE/$raw failed"; return 1; }
      fi
      [ "$(size_of "$part")" = "$size" ] || { echo "FAILED    $dest: got $(size_of "$part") bytes, expected $size"; rm -f "$part"; return 1; }
      mv -f "$part" "$cached"; how="downloaded"
    fi
    local got; got="$(sha256_of "$cached")"
    if [ "$got" != "$sha" ]; then echo "FAILED    $dest: sha256 $got, expected $sha (deleted; re-run to fetch again)"; rm -f "$cached"; return 1; fi
    echo "$sha $size" > "$stamp"
    [ "$how" = cached ] && how="verified"
  fi
  mkdir -p "$(dirname "$target")"
  ln -sfn "$cached" "$target"
  printf '%-9s %s\n' "$how" "$dest"
}

if [ "${1:-}" = "--one" ]; then
  # xargs hands one tab-separated manifest row (+ the verify flag) per call.
  IFS=$'\t' read -r g d r s h v <<< "$2"
  fetch_one "$g" "$d" "$r" "$s" "$h" "$v"; exit $?
fi

groups="${ACJS_DAT_GROUPS:-all}" verify=0 status=0
while [ $# -gt 0 ]; do
  case "$1" in
    --groups) groups="$2"; shift 2 ;;
    --verify) verify=1; shift ;;
    --status) status=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "fetch-dats: unknown argument $1" >&2; exit 2 ;;
  esac
done

rows="$(grep -v '^#' "$MANIFEST" | grep -v '^[[:space:]]*$' || true)"
if [ "$groups" != all ]; then
  known=" $(printf '%s\n' "$rows" | cut -f1 | sort -u | tr '\n' ' ')"
  for g in $(printf '%s' "$groups" | tr ',' ' '); do
    case "$known" in *" $g "*) ;; *) echo "fetch-dats: unknown group '$g' (known:$known)" >&2; exit 2 ;; esac
  done
  rows="$(printf '%s\n' "$rows" | awk -F'\t' -v want=",$groups," 'index(want, "," $1 ",") > 0')"
fi

if [ "$status" = 1 ]; then
  missing=0
  while IFS=$'\t' read -r g d r s h; do
    [ -n "$d" ] || continue
    if [ -e "$REPO/$d" ] && [ "$(size_of "$REPO/$d")" = "$s" ]; then echo "present   $d"; else echo "missing   $d ($g)"; missing=1; fi
  done <<< "$rows"
  exit "$missing"
fi

mkdir -p "$CACHE"
# One fetch at a time per cache (a SessionStart run and provision-remote-env.sh may overlap).
lock="$CACHE/.lock"
for i in $(seq 1 1800); do
  if mkdir "$lock" 2>/dev/null; then echo $$ > "$lock/pid"; break; fi
  owner="$(cat "$lock/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$lock"; continue; fi
  [ "$i" = 1 ] && echo "fetch-dats: waiting for another fetch (pid ${owner:-?}) to finish…"
  sleep 1
done
[ -d "$lock" ] && [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ] || { echo "fetch-dats: another fetch still holds $lock" >&2; exit 1; }
trap 'rm -rf "$lock"' EXIT

# Room for what still has to be downloaded (plus 1 GB).
need=0
while IFS=$'\t' read -r g d r s h; do
  [ -n "$d" ] || continue
  [ -e "$REPO/$d" ] && [ ! -L "$REPO/$d" ] && continue
  [ -f "$CACHE/$r" ] && [ "$(size_of "$CACHE/$r")" = "$s" ] && continue
  have=0; [ -f "$CACHE/$r.part" ] && have="$(size_of "$CACHE/$r.part")"
  need=$((need + s - have))
done <<< "$rows"
free_kb="$(df -Pk "$CACHE" | awk 'NR==2 {print $4}')"
if [ "$need" -gt 0 ] && [ "$(( (need >> 10) + 1048576 ))" -gt "$free_kb" ]; then
  echo "fetch-dats: needs $((need >> 20)) MB more but $CACHE has $((free_kb >> 10)) MB free; pick fewer --groups or another ACJS_DAT_CACHE" >&2
  exit 1
fi
[ "$need" -gt 0 ] && echo "fetch-dats: downloading $((need >> 20)) MB into $CACHE"

# Each row is one xargs argument line, so the whole row reaches --one intact.
results="$(printf '%s\n' "$rows" | awk -v v="$verify" 'NF { print $0 "\t" v }' \
  | tr '\n' '\0' | xargs -0 -P "$JOBS" -n 1 bash "$0" --one)"
printf '%s\n' "$results"

# The era aliases Jake's checkout has (dat/sets/<era> -> ../../dat-sets/<set>), for the tests that read them.
for alias in ac1999-retail:ac1999-retail classic-dereth:classic-dereth-1.1 classicace-customdm:classicace-customdm-1.60 classicace-infiltration:classicace-infiltration-1.9; do
  name="${alias%%:*}" set="${alias#*:}"
  [ -d "$REPO/dat-sets/$set" ] || continue
  [ -e "$REPO/dat/sets/$name" ] || [ -L "$REPO/dat/sets/$name" ] && continue
  mkdir -p "$REPO/dat/sets" && ln -s "../../dat-sets/$set" "$REPO/dat/sets/$name"
done

if printf '%s\n' "$results" | grep -q '^FAILED'; then exit 1; fi
exit 0
