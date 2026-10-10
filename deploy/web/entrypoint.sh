#!/bin/sh
# Write the runtime config the client reads at boot, derive the Content
# Security Policy from it, then serve.
set -eu
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# scheme://host[:port] of a URL ('' if none).
origin_of() { printf '%s' "$1" | sed -n 's#^\([a-z][a-z0-9+.-]*://[^/?#]*\).*#\1#p'; }

BRIDGE_URL="${ACJS_BRIDGE_URL:-ws://localhost:9090}"
ASSET_BASE="${ACJS_ASSET_BASE:-}"
# RELEASE.dat-streaming: the DAT set pointer to stream (docs/dat-streaming.md),
# e.g. https://dats.example.org/v1/sets/eol-p2072-c982-h497-l994.json.
# Empty = the client downloads the whole DATs from ASSET_BASE.
DAT_SET_URL="${ACJS_DAT_SET_URL:-}"
if [ -n "$DAT_SET_URL" ]; then
  DAT_SET_JSON="{\"manifestUrl\":\"$(json_escape "$DAT_SET_URL")\"}"
else
  DAT_SET_JSON="null"
fi
# AGPL-3.0 §13: the public repository, shown as the launcher's source link.
SOURCE_URL="${ACJS_SOURCE_URL:-}"
if [ -n "$SOURCE_URL" ]; then
  SOURCE_JSON="\"$(json_escape "$SOURCE_URL")\""
else
  SOURCE_JSON="null"
fi
# ERA.dm-support: hosts of classic (Dark Majesty) DAT sets, by era id, as a
# JSON object, e.g. {"classic-dereth":"https://dats.example.org/sets/classic-dereth"}
# (docs/dark-majesty-support.md). Only with the server operator's OK; empty =
# players import their own files. The client validates the entries.
ERA_ASSET_BASES="${ACJS_ERA_ASSET_BASES:-}"
# Only a flat {"era-id":"http(s)://…", …} object passes; anything else would
# break config.json (and with it the whole runtime config), so it becomes {}.
ERA_PAIR='"[a-z0-9][a-z0-9-]*":"https?://[^"\\[:space:]]+"'
if printf '%s' "$ERA_ASSET_BASES" | grep -Eq "^\{($ERA_PAIR)(,$ERA_PAIR)*\}$"; then
  ERA_ASSET_BASES_JSON="$ERA_ASSET_BASES"
else
  [ -n "$ERA_ASSET_BASES" ] && echo "ACJS_ERA_ASSET_BASES ignored: expected {\"era-id\":\"https://…\"}" >&2
  ERA_ASSET_BASES_JSON="{}"
fi
# Classic eras' streamed DAT set pointers, by era id, as a flat JSON object,
# e.g. {"classicace-infiltration":"https://dats.example.org/v1/sets/classicace-infiltration-1.9.json"}
# (docs/dat-streaming.md §6.9). An era without one loads its whole DATs.
ERA_DAT_SETS="${ACJS_ERA_DAT_SETS:-}"
if printf '%s' "$ERA_DAT_SETS" | grep -Eq "^\{($ERA_PAIR)(,$ERA_PAIR)*\}$"; then
  ERA_DAT_SETS_JSON="$ERA_DAT_SETS"
else
  [ -n "$ERA_DAT_SETS" ] && echo "ACJS_ERA_DAT_SETS ignored: expected {\"era-id\":\"https://…/v1/sets/<set>.json\"}" >&2
  ERA_DAT_SETS_JSON="{}"
fi
printf '{"assetBase":"%s","bridgeUrl":"%s","datSet":%s,"sourceUrl":%s,"eraAssetBases":%s,"eraDatSets":%s}\n' \
  "$(json_escape "$ASSET_BASE")" "$(json_escape "$BRIDGE_URL")" "$DAT_SET_JSON" "$SOURCE_JSON" "$ERA_ASSET_BASES_JSON" "$ERA_DAT_SETS_JSON" > /srv/config.json

# Update notifier: the build this image carries, plus an optional urgent flag
# (ACJS_UPDATE_URGENT=1 makes in-world players see a dialog).
BUILD_ID="$(cat /srv/build-id.txt 2>/dev/null | tr -d '[:space:]')"
URGENT=false; [ "${ACJS_UPDATE_URGENT:-}" = "1" ] && URGENT=true
printf '{"build":"%s","urgent":%s}\n' "$(json_escape "${BUILD_ID:-dev}")" "$URGENT" > /srv/version.json

BRIDGE_ORIGIN="$(origin_of "$BRIDGE_URL")"
# The bridge's HTTP side (server list) lives on the same host as its WebSocket.
BRIDGE_HTTP_ORIGIN="$(printf '%s' "$BRIDGE_ORIGIN" | sed 's#^wss://#https://#; s#^ws://#http://#')"
ASSET_ORIGIN="$(origin_of "$ASSET_BASE")"
DAT_SET_ORIGIN="$(origin_of "$DAT_SET_URL")"
# Each classic set host's origin (the https URLs inside ACJS_ERA_ASSET_BASES).
ERA_ORIGINS="$(printf '%s %s' "$ERA_ASSET_BASES_JSON" "$ERA_DAT_SETS_JSON" | grep -o 'https\{0,1\}://[^"/]*' | sort -u | tr '\n' ' ')"
# wss: stays open so a player can point "Custom…" at a server's own bridge.
CONNECT="'self' wss: $BRIDGE_ORIGIN $BRIDGE_HTTP_ORIGIN $ASSET_ORIGIN $DAT_SET_ORIGIN $ERA_ORIGINS"
export ACJS_CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; worker-src 'self' blob:; connect-src $CONNECT; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
