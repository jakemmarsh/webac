# GDL-Classic ("Classic Dereth", github.com/bDekaru/ClassicDereth): the GDL
# server family's classic (Feb 2005 Infiltration-era) branch. Seedsow and
# Snowreap are GDL-family classic servers whose live code is unpublished; this
# is the closest public relative, used to verify the classic-dereth era
# profile end to end (docs/dark-majesty-support.md).
#
#   docker build --platform linux/amd64 -t gdl-classic:0c05801 tools/gdl-classic
#
# Same recipe as tools/gdle/Dockerfile (Debian, linux/amd64 under emulation:
# PhatSDK/MathLib.h includes <x86intrin.h>; GCC 12 needs <cstring>/<strings.h>
# force-included). The image carries the server's own world data
# (Bin/Data: cache.bin, json/, worlddesc; Data/misc lower-cased as data/misc)
# and the SQL schema under /opt/gdl-sql. start-gdl-classic.sh mounts
# server.cfg and the Classic Dereth 1.0 client_portal.dat / client_cell_1.dat.
FROM --platform=linux/amd64 debian:bookworm AS builder
ARG REPO=https://github.com/bDekaru/ClassicDereth.git
ARG COMMIT=0c05801553740bb835adfd9f032e29094c9f5dea
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates zlib1g-dev libmariadb-dev-compat \
    && rm -rf /var/lib/apt/lists/*
RUN git clone "$REPO" /src && cd /src && git checkout "$COMMIT"
RUN sed -i 's|-fpermissive -w|-fpermissive -w -include cstring -include strings.h|' /src/CMakeLists.txt
RUN mkdir /src/build && cd /src/build \
    && cmake -DCMAKE_BUILD_TYPE=Release .. \
    && make --jobs 4 \
    && cp "$(find . -maxdepth 1 -type f -perm -u+x | head -1)" /src/build/server-bin

FROM --platform=linux/amd64 debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libmariadb3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/build/server-bin /usr/local/bin/gdl-classic
COPY --from=builder /src/Bin/Data /gdle/Data
COPY --from=builder /src/Data /gdle/data
COPY --from=builder /src/Bin/sqldumps /opt/gdl-sql
COPY --from=builder /src/Bin/GDLELogging.conf /gdle/GDLELogging.conf
WORKDIR /gdle
ENTRYPOINT ["/usr/local/bin/gdl-classic"]
CMD ["--config", "server.cfg"]
