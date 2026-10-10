#!/usr/bin/env bash
# provision-retail-client.sh — build a Docker-based Wine harness for the real
# end-of-retail acclient.exe, for later reference-frame capture work.
#
# SUPERSEDED on macOS (2026-10-02): tools/launch-retail-client-mac.sh runs the
# client under native macOS Wine with real-GPU rendering, no Docker. This
# Docker harness remains only as a record of the QEMU failure.
#
# CONTEXT: this was authored on a real macOS (Apple Silicon / arm64) dev
# machine, not a native x86_64 Linux box. There is no `apt`/`dpkg` on the host
# and Wine cannot be installed on it directly. Docker Desktop is present and
# can run x86_64 Linux containers (via QEMU/Rosetta emulation), so this script
# provisions Wine + Xvfb + screenshot tooling INSIDE a disposable Ubuntu 22.04
# amd64 container rather than touching the host.
#
# If you are running this on an actual native x86_64 Linux host, you can skip
# Docker entirely and run the `apt-get`/`wine`/`Xvfb` commands below directly
# on the host — they are the same commands, just executed via `docker exec`
# here for host isolation.
#
# KNOWN BLOCKER (see docs/retail-client-hosting-findings.md): on an
# Apple-Silicon Mac, Docker Desktop's x86_64 emulation for this container goes
# through QEMU user-mode translation, and Wine's ntdll crashes during startup
# with `anon_mmap_fixed: Assertion '!((UINT_PTR)start & host_page_mask)'
# failed` before any window appears — for `wineboot --init` AND for
# `wine acclient.exe` directly, with both WINEARCH=win32 and the default WoW64
# prefix. This script still provisions Wine successfully (that part works
# fine); it is the *runtime* that is blocked in this specific emulated
# environment. On genuine x86_64 hardware (bare metal, or a real x86_64 VM/
# cloud instance — not QEMU-emulated on an ARM host) this should not apply,
# since that is Wine's primary supported platform, but this has NOT been
# verified — no genuine x86_64 Linux host was available in this session.
#
# Usage:
#   bash tools/provision-retail-client.sh
#
# Idempotent: safe to re-run. Removes and recreates the `retail-client-test`
# container each time.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER_NAME="${RETAIL_CLIENT_CONTAINER:-retail-client-test}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[provision-retail-client] docker not found — this script requires Docker Desktop (or another docker CLI) on a host without native Wine/apt support." >&2
  exit 1
fi

if [[ ! -f "$REPO/reference/client-eol/acclient.exe" ]]; then
  echo "[provision-retail-client] reference/client-eol/acclient.exe missing — run tools/provision-remote-env.sh first (needs ACJS_REFERENCE_BUNDLE_URL or the in-repo reference-bundle branch)." >&2
  exit 1
fi

echo "[provision-retail-client] (re)creating container '$CONTAINER_NAME' (ubuntu:22.04, linux/amd64, repo mounted at /repo)…"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER_NAME" --platform linux/amd64 \
  -v "$REPO:/repo" \
  ubuntu:22.04 sleep infinity >/dev/null

run() { docker exec "$CONTAINER_NAME" bash -c "$1"; }

echo "[provision-retail-client] enabling i386 multiarch + base tools…"
run 'export DEBIAN_FRONTEND=noninteractive; dpkg --add-architecture i386 && apt-get update -qq && apt-get install -y -qq wget gnupg2 software-properties-common ca-certificates curl'

echo "[provision-retail-client] adding WineHQ apt repo (jammy)…"
run 'mkdir -pm755 /etc/apt/keyrings && wget -q -O /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key && wget -qNP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources && apt-get update -qq'

echo "[provision-retail-client] installing winehq-stable (this takes a few minutes)…"
run 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y --install-recommends winehq-stable'

echo "[provision-retail-client] installing Xvfb + screenshot tooling…"
run 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq xvfb x11-utils imagemagick x11-apps'

echo "[provision-retail-client] verifying wine…"
run 'wine --version'

echo "[provision-retail-client] starting Xvfb on :99…"
docker exec -d "$CONTAINER_NAME" bash -c 'Xvfb :99 -screen 0 1600x900x24 > /tmp/xvfb.log 2>&1'
sleep 2
run 'DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && echo "Xvfb OK"'

echo "[provision-retail-client] done. Container '$CONTAINER_NAME' is running with:"
echo "  - Wine $(docker exec "$CONTAINER_NAME" wine --version 2>/dev/null || echo '(unknown)')"
echo "  - Xvfb on DISPLAY=:99"
echo "  - repo mounted at /repo (acclient.exe at /repo/reference/client-eol/acclient.exe)"
echo ""
echo "Next step (KNOWN TO CRASH in this emulated environment — see docs/retail-client-hosting-findings.md):"
echo "  docker exec $CONTAINER_NAME bash -c 'WINEARCH=win32 WINEPREFIX=/root/.wine32 DISPLAY=:99 wine /repo/reference/client-eol/acclient.exe'"
