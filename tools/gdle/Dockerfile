# Vanilla GDLEnhanced 1.34 (the last public release) for the GDLE compat probe
# (docs/gdle-compat.md). Built for linux/amd64 and run under emulation on Apple
# Silicon: GDLE's PhatSDK/MathLib.h includes <x86intrin.h>, so an arm64 build
# fails. Debian, not the upstream Alpine Dockerfile: musl defines NULL as
# nullptr in C++, and GDLE passes NULL to uint32_t parameters (Client.cpp:372);
# glibc's NULL (__null) converts.
#
#   docker build --platform linux/amd64 -t gdle-server:1.34 tools/gdle
#
# The image carries GDLE's own world data (Bin/Data: cache.bin, json/,
# worlddesc; Data/misc) laid out under /gdle, and the SQL schema
# (Bin/sqldumps) under /opt/gdle-sql. start-gdle.sh mounts server.cfg and the
# EoL client_portal.dat / client_cell_1.dat (read-only) into /gdle.
FROM --platform=linux/amd64 debian:bookworm AS builder
ARG GDLE_REPO=https://gitlab.com/Scribble/gdlenhanced.git
ARG GDLE_COMMIT=353cbab52ef7da2b7063bc3e3f008461d8531693
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates zlib1g-dev libmariadb-dev-compat \
    && rm -rf /var/lib/apt/lists/*
RUN git clone "$GDLE_REPO" /src && cd /src && git checkout "$GDLE_COMMIT"
# GCC 12 no longer pulls <cstring>/<strings.h> in transitively; GDLE relied on
# that (memset/strcmp/strcasecmp/strerror undeclared). Force-include both.
RUN sed -i 's|-fpermissive -w|-fpermissive -w -include cstring -include strings.h|' /src/CMakeLists.txt
RUN mkdir /src/build && cd /src/build \
    && cmake -DCMAKE_BUILD_TYPE=Release .. \
    && make --jobs 4

FROM --platform=linux/amd64 debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libmariadb3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/build/GDLEnhanced /usr/local/bin/GDLEnhanced
# GDLE resolves DATs, cache.bin and json/ under "<cwd>/Data" but opens
# "data/misc/*.dat" lower-case (Database2.cpp), which matters on Linux.
COPY --from=builder /src/Bin/Data /gdle/Data
COPY --from=builder /src/Data /gdle/data
COPY --from=builder /src/Bin/sqldumps /opt/gdle-sql
COPY --from=builder /src/Bin/GDLELogging.conf /gdle/GDLELogging.conf
WORKDIR /gdle
ENTRYPOINT ["/usr/local/bin/GDLEnhanced"]
CMD ["--config", "server.cfg"]
