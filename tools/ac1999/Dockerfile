# AC1999 server (GDLEnhanced) for tools/ac1999/start-ac1999.sh.
#
# The upstream Server/Dockerfile is Alpine, and musl has no <execinfo.h>, which
# easylogging++'s crash log (ELPP_FEATURE_CRASH_LOG, Server/CMakeLists.txt)
# includes. Its canonical build is glibc Linux (build-server.sh; CONTRIBUTING:
# build-essential cmake libmariadb-dev), so build on Debian. Context = the
# AC1999 Server/ directory. Release build: the Debug one is ~4x slower to tick.
FROM debian:bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake libmariadb-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && make -C build -j"$(nproc)" GDLEnhanced

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libmariadb3 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/build/GDLEnhanced /usr/local/bin/GDLEnhanced
# /gdle mirrors Server/Bin (configs, Data/, ServerModes/); logs land there too.
WORKDIR /gdle
ENTRYPOINT ["/usr/local/bin/GDLEnhanced"]
CMD ["-c", "server.cfg"]
