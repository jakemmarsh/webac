# ClassicACE (github.com/bDekaru/ClassicACE): the ACE fork behind the
# ACE-Classic Dark Majesty servers (Dekarutide, Unfamiliar Shores). Used to
# verify the classicace-customdm era profile end to end
# (docs/dark-majesty-support.md). Upstream ACE's Dockerfile, on .NET 8
# (ClassicACE's target framework), cloning a pinned commit.
#
#   docker build -t classicace:73ae37f tools/classicace
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
ARG REPO=https://github.com/bDekaru/ClassicACE.git
ARG COMMIT=73ae37fa5f32c41461dd264e752d80837a86f43e
RUN git clone "$REPO" /src && cd /src && git checkout "$COMMIT"
WORKDIR /src/Source
RUN dotnet restore ACE.Server/ACE.Server.csproj
RUN dotnet publish ACE.Server/ACE.Server.csproj -c release -o /ace --no-restore

FROM mcr.microsoft.com/dotnet/runtime:8.0
WORKDIR /ace
COPY --from=build /ace .
COPY --from=build /src/Database /opt/classicace-sql
ENTRYPOINT ["dotnet", "ACE.Server.dll"]
EXPOSE 9000-9001/udp
VOLUME /ace/Config /ace/Content /ace/Dats /ace/Logs /ace/Mods
