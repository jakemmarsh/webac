#!/usr/bin/env bash
# fetch-reference.sh — extract the PRIVATE reference archive (the retail client decomp, the AC1999
# client + server sources, the classic emulators, …) into this checkout, from wherever Jake hosts it.
# docs/cloud-sessions.md; build the archive with tools/cloud/pack-reference.sh.
#
#   ACJS_REFERENCE_URL=https://… [ACJS_REFERENCE_AUTH_HEADER='Authorization: Bearer …'] \
#     [ACJS_REFERENCE_SHA256=<hex>] bash tools/cloud/fetch-reference.sh
#
# Unset ACJS_REFERENCE_URL: prints SKIPPED and exits 0. The archive is a .tar.gz (or .tar.zst when
# zstd is installed) whose every entry is under reference/ or dat-sets/ (anything else, an absolute
# path, a `..` component or a link refuses the whole archive), extracted at the checkout root.
# The header is handed to curl on stdin, so it is never in a process list or a log.
# Cached: the archive is kept in ACJS_REFERENCE_CACHE (default ~/.cache/acjs/reference) and fetched
# again only when the server's ETag changes; an unchanged archive already extracted is not re-extracted.
# Exit 0 extracted / up to date / skipped, 1 failed.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${ACJS_REFERENCE_REPO:-$(cd "$here/../.." && pwd)}"
CACHE="${ACJS_REFERENCE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/acjs/reference}"
url="${ACJS_REFERENCE_URL:-}"
if [ -z "$url" ]; then
  echo "reference archive: SKIPPED (set ACJS_REFERENCE_URL, plus ACJS_REFERENCE_AUTH_HEADER if the host needs auth; docs/cloud-sessions.md)"
  exit 0
fi
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
mkdir -p "$CACHE"
archive="$CACHE/archive" etag="$CACHE/etag" part="$CACHE/archive.part"
rm -f "$part"

# curl config on stdin: the URL and header never reach argv. --etag-compare makes an unchanged
# archive a 304 with no body.
cfg() {
  printf 'url = "%s"\n' "$url"
  [ -n "${ACJS_REFERENCE_AUTH_HEADER:-}" ] && printf 'header = "%s"\n' "${ACJS_REFERENCE_AUTH_HEADER//\"/\\\"}"
  return 0
}
etag_args=()
[ -f "$archive" ] && [ -s "$etag" ] && etag_args=(--etag-compare "$etag")
code="$(cfg | curl -sS -L --retry 3 --connect-timeout 20 -K - "${etag_args[@]+"${etag_args[@]}"}" --etag-save "$CACHE/etag.new" -o "$part" -w '%{http_code}')" || code="curl-error"
case "$code" in
  304) rm -f "$part" "$CACHE/etag.new"; echo "reference archive: unchanged on the server" ;;
  200) mv -f "$part" "$archive"; [ -s "$CACHE/etag.new" ] && mv -f "$CACHE/etag.new" "$etag" || rm -f "$etag" "$CACHE/etag.new"
       echo "reference archive: downloaded ($(( $(wc -c < "$archive") >> 20 )) MB)" ;;
  *) rm -f "$part" "$CACHE/etag.new"
     echo "reference archive: FAILED to download (HTTP $code; the URL and header are not printed)"
     [ -f "$archive" ] || exit 1
     echo "reference archive: using the copy cached earlier" ;;
esac

if [ -n "${ACJS_REFERENCE_SHA256:-}" ] && [ "$(sha256_of "$archive")" != "$ACJS_REFERENCE_SHA256" ]; then
  echo "reference archive: FAILED: sha256 does not match ACJS_REFERENCE_SHA256"; rm -f "$archive" "$etag"; exit 1
fi

magic="$(head -c 4 "$archive" | od -An -tx1 | tr -d ' \n')"
case "$magic" in
  1f8b*) dec=(gzip -dc) ;;
  28b52ffd) command -v zstd >/dev/null 2>&1 || { echo "reference archive: FAILED: it is zstd and zstd is not installed"; exit 1; }; dec=(zstd -dcq) ;;
  *) echo "reference archive: FAILED: not a .tar.gz or .tar.zst"; exit 1 ;;
esac

sum="$(sha256_of "$archive")"
if [ "$(cat "$REPO/reference/.acjs-reference-archive" 2>/dev/null)" = "$sum" ]; then
  echo "reference archive: already extracted"; exit 0
fi

# Every entry under reference/ or dat-sets/, no absolute path, no `..`, no links or devices.
names="$("${dec[@]}" < "$archive" | tar -tf - 2>/dev/null)" || { echo "reference archive: FAILED: not a readable tar"; exit 1; }
types="$("${dec[@]}" < "$archive" | tar -tvf - 2>/dev/null | cut -c1 | sort -u | tr -d '\n')"
bad="$(printf '%s\n' "$names" | awk '
  NF == 0 || $0 == "./" { next }
  /^\// || /(^|\/)\.\.(\/|$)/ { print "unsafe path: " $0; next }
  !/^(\.\/)?(reference|dat-sets)(\/|$)/ { print "outside reference/ and dat-sets/: " $0 }
' | head -5)"
case "$types" in *[!d-]*) bad="${bad:+$bad
}links or special files (tar types: $types)" ;; esac
if [ -n "$bad" ]; then echo "reference archive: FAILED: refused to extract:"; printf '  %s\n' "$bad"; exit 1; fi

"${dec[@]}" < "$archive" | tar -xf - -C "$REPO" --no-same-owner 2>/dev/null \
  || "${dec[@]}" < "$archive" | tar -xf - -C "$REPO" \
  || { echo "reference archive: FAILED to extract"; exit 1; }
mkdir -p "$REPO/reference" && echo "$sum" > "$REPO/reference/.acjs-reference-archive"
echo "reference archive: extracted $(printf '%s\n' "$names" | grep -vc '/$') files into $(printf '%s\n' "$names" | sed -E 's#^\./##' | cut -d/ -f1-2 | grep -v '^$' | sort -u | tr '\n' ' ')"
