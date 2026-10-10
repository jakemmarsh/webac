#!/usr/bin/env bash
# ensure-ace-dats.sh — make sure the ACE server container has ALL the DAT files
# it needs, copying any missing ones from the host dat/ directory.
#
# WHY THIS EXISTS (2026-06-10): the ace-server container's /ace/Dats volume was
# missing client_local_English.dat. ACE binds its UDP port and reports "healthy"
# without it, but DatManager.LanguageDat ends up null — so EVERY login's
# DDD_InterrogationResponse handler throws a NullReferenceException
# (DDDHandler.cs:83, the LANGUAGE case), which stalls/destabilizes the login
# handshake. Symptom: "ACE not responding to LoginRequest", flaky logins that
# only sometimes succeed after retries. Full write-up: docs/ace-server-ops.md.
#
# Run this after (re)creating the ace-server container. Idempotent.
set -euo pipefail

CONTAINER="${ACE_CONTAINER:-ace-server}"
HOST_DATS="$(cd "$(dirname "$0")/.." && pwd)/dat"
CONTAINER_DATS="/ace/Dats"

# ACE needs these three to serve + answer the DDD interrogation cleanly.
# (client_highres.dat is optional for the server.)
REQUIRED=(client_portal.dat client_cell_1.dat client_local_English.dat)

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[ensure-ace-dats] container '$CONTAINER' is not running" >&2
  exit 1
fi

changed=0
for dat in "${REQUIRED[@]}"; do
  if docker exec "$CONTAINER" sh -c "test -s '$CONTAINER_DATS/$dat'" 2>/dev/null; then
    echo "[ensure-ace-dats] ok: $dat present"
  else
    if [[ ! -f "$HOST_DATS/$dat" ]]; then
      echo "[ensure-ace-dats] MISSING on host too: $HOST_DATS/$dat — cannot fix" >&2
      exit 1
    fi
    echo "[ensure-ace-dats] copying $dat into $CONTAINER:$CONTAINER_DATS/ ..."
    docker cp "$HOST_DATS/$dat" "$CONTAINER:$CONTAINER_DATS/$dat"
    changed=1
  fi
done

if [[ "$changed" == "1" ]]; then
  echo "[ensure-ace-dats] DATs changed — restart ace-server so DatManager reloads:"
  echo "                  docker restart $CONTAINER"
fi
