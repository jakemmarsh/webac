#!/usr/bin/env bash
# ACE's own physics, offline: drives the live server image's ACE.Server.dll (CalculateProjectileOrigins,
# IsProjectileVisible, enter_world / transitions) over our DATs to answer "would this bolt hit?" without a server.
# Built for the point-blank bolt investigation (2026-10-14, docs/agent-play.md "Line of fire").
#
#   tools/ace-physics-harness/run.sh sweep out                     # skeleton + armoredillo, 0.6-3.5 m, open ground (Holtburg)
#   tools/ace-physics-harness/run.sh sweep 01450173                # the same around an EnvCell
#   tools/ace-physics-harness/run.sh scan 0145 02000059 1.0        # every EnvCell of a dungeon: near shots vs far shots
#   tools/ace-physics-harness/run.sh hmap 0145 96 104 -42 -30 1    # floor heights (EnvCell point_in_cell)
#   tools/ace-physics-harness/run.sh door 0145 100 -36 100 -34.4 [nodoor]   # through Door #70145010 (closed)
#   TV=4,0,0 tools/ace-physics-harness/run.sh sweep out            # with a (stale) target CachedVelocity, caster frame
#   tools/ace-physics-harness/run.sh pairs 0286 02000004 0.8 /work/pairs.txt   # "cx cy cz tx ty tz" per line (file in $ACE_HARNESS_DIR)
#   ALL=1 STEP=1 tools/ace-physics-harness/run.sh grid 0286 02000004 0.8 72 80 -95 -87 8   # every shot, HIT and MISS (A/B input)
#   npx tsx tools/ace-physics-harness/lof-ab.ts /tmp/grid.txt 01D2 02000001 1.25   # ours vs those verdicts, with and without CylSphere-only statics
#   ZMIN=17 ZMAX=19 ALL=1 STEP=1 tools/ace-physics-harness/run.sh grid 01D2 02000001 1.25 44 74 -26 0 8   # an upper storey (default: floors below 4 m)
#
# Needs Docker with the acemulator/ace:latest and mcr.microsoft.com/dotnet/sdk:10.0 images; the DATs in ../../dat.
# Scratch goes to ${ACE_HARNESS_DIR:-/tmp/ace-physics-harness}. It touches no running server.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="${ACE_HARNESS_DIR:-/tmp/ace-physics-harness}"
mkdir -p "$work/harness" "$work/ace"
cp "$here/Program.cs" "$here/harness.csproj" "$work/harness/"
if [ ! -f "$work/ace/ACE.Server.dll" ]; then
  cid=$(docker create acemulator/ace:latest)
  docker cp "$cid:/ace/." "$work/ace/" >/dev/null
  docker rm "$cid" >/dev/null
fi
docker run --rm -v "$work:/work" -w /work/harness mcr.microsoft.com/dotnet/sdk:10.0 dotnet build -c Release -o /work/out >/dev/null
cp "$work"/ace/*.dll "$work/out/" 2>/dev/null || true
datdir="$(cd "$repo/dat" && pwd -P)"
exec docker run --rm ${TV:+-e TV="$TV"} ${ALL:+-e ALL="$ALL"} ${STEP:+-e STEP="$STEP"} ${ZMIN:+-e ZMIN="$ZMIN"} ${ZMAX:+-e ZMAX="$ZMAX"} -v "$work:/work" -v "$datdir:/dat:ro" -w /work/out mcr.microsoft.com/dotnet/sdk:10.0 dotnet harness.dll "$@"
