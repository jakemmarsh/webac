# ws-tcp-bridge (WebSocket ↔ UDP)

Browsers can't send UDP, so the client talks WebSocket to this bridge, which
relays each session over its own UDP socket to an ACE or GDLE server. (The
name says TCP for historical reasons; the game protocol is UDP.)

```
browser ──wss──▶ bridge ──udp──▶ game server (base port; ConnectResponse → base+1)
browser ◀─wss── bridge ◀─udp── game server (replies from base or base+1)
```

## Modes

| Mode | How it's chosen | Target |
|---|---|---|
| **pinned** (default) | no config, positional args, or `BRIDGE_TARGET` | one fixed server; `?server=` is ignored |
| **multi** | `BRIDGE_MODE=multi` and no pinned target | the client picks an allowlisted server: `wss://bridge/connect?server=<id>` |

Local dev is unchanged: `npx tsx services/ws-tcp-bridge/src/bridge.ts`
listens on `ws://127.0.0.1:9090` and bridges to `127.0.0.1:9000` (world port
9001). Positional args: `[wsPort] [serverHost] [basePort] [worldPort=basePort+1]`.
From the package, run `npm start -w @ac/ws-tcp-bridge`.

In multi mode the server id comes from the community list
([acresources/serverslist `Servers.xml`](https://github.com/acresources/serverslist))
plus an optional local overlay. The bridge resolves the host when the client
connects and pins the session to that IPv4 address. Hosts that resolve to
private, loopback, link-local, CGNAT, multicast or reserved addresses are
refused, so a hosted bridge can't be pointed at internal networks. A
connection without `?server` is probe-only: it answers the text `health`
message and forwards nothing.

There is no open relay. If no server list has loaded (no fetch and no disk
cache), list ids are rejected, and only overlay servers still resolve.

### Wire protocol per session

Each session speaks end of retail unless something says 1999
(`src/protocol.ts`; docs/ac1999-support-scope.md, Phase 3):

- **end of retail** (default; ACE, GDLE, every classic server): the routing
  above, the session id from the server's ConnectRequest, an EoL Disconnect on close.
- **AC1999** (Nov 1999 retail) when the server's directory row has era
  `ac1999-retail` (multi mode), `BRIDGE_ERA=ac1999-retail` (pinned), or the
  WebSocket URL carries `?proto=ac1999` (a Custom… world). One UDP port both
  ways (never port+1; datagrams from port+1 are dropped), the slot from the
  server's connect grant, and a 1999 Disconnect (0x8002, recipient = slot) on close.
  Local: `BRIDGE_ERA=ac1999-retail npx tsx services/ws-tcp-bridge/src/bridge.ts 9101 127.0.0.1 9310`.

## HTTP endpoints (same port as the WebSocket)

- `GET /healthz`: `{"up":true,"mode","sessions","perServer":{id:{name,sessions}},"serversList":{source,servers,ageSeconds,lastError},"uptimeSeconds"}`. Always public.
- `GET /metrics`: Prometheus text (`?format=json` for JSON). Includes active
  sessions (total and per server), connects, closes by reason, rejects by
  reason (`origin`, `global_cap`, `ip_rate`, `ip_cap`, `unknown_server`,
  `server_cap`, `private_target`, `dns_failed`, ...), bytes by direction
  (`ws_in` browser→bridge, `udp_out` bridge→server, `udp_in` server→bridge,
  `ws_out` bridge→browser) and dropped messages. Set `BRIDGE_METRICS_TOKEN` to
  require `Authorization: Bearer <token>`.

Logs are one JSON object per line. Every session's `session_close` line
carries `durationMs`, `bytesFromBrowser`, `bytesToServer`, `bytesFromServer`,
`bytesToBrowser` and packet counts. Use these to measure per-player bandwidth.
Hosting egress is roughly `bytesToServer + bytesToBrowser`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `BRIDGE_PORT` | 9090 | Listen port (first positional arg wins, then `BRIDGE_PORT`, then `PORT`, which Railway sets) |
| `BRIDGE_HOST` | 127.0.0.1 | Listen address (`0.0.0.0` in the Docker image) |
| `BRIDGE_MODE` | pinned | `multi` enables `?server=<id>` (ignored when a target is pinned) |
| `BRIDGE_TARGET` | — | Pinned target `host:port` (world port = port+1); same as the positional args |
| `BRIDGE_ALLOWED_ORIGINS` | — | Extra browser Origins allowed (comma list, or `*`). Loopback origins and clients without an Origin always pass. **Set this to the client's origin in production** |
| `BRIDGE_TRUST_PROXY` | off | Trusted proxy hops in front of the bridge (`1`/`true` = one). Only then is `X-Forwarded-For` used for the client IP (the Nth entry from the right). Set to `1` on Railway |
| `BRIDGE_CLIENT_IP_HEADER` | unset | With `BRIDGE_TRUST_PROXY`, a single-value header the edge overwrites with the client address, preferred over `X-Forwarded-For`. Railway: `x-real-ip` (its `X-Forwarded-For` ends with Railway's own edge, so hop counting picks the edge) |
| `BRIDGE_MAX_CONNECTIONS` | 500 | Global concurrent sessions |
| `BRIDGE_MAX_SESSIONS_PER_IP` | 8 | Concurrent sessions per client IP |
| `BRIDGE_CONNECT_RATE_PER_IP` / `BRIDGE_CONNECT_RATE_WINDOW_MS` | 20 / 60000 | New connections per IP per window |
| `BRIDGE_MAX_SESSIONS_PER_SERVER` | 100 | Concurrent sessions to one target server (multi mode) |
| `BRIDGE_MSG_RATE` / `BRIDGE_MSG_BURST` | 200/s / 400 | Per-session inbound message rate |
| `BRIDGE_BYTE_RATE` / `BRIDGE_BYTE_BURST` | 131072 B/s / 524288 | Per-session inbound byte rate |
| `BRIDGE_ABUSE_MAX_DROPS` / `BRIDGE_ABUSE_WINDOW_MS` | 200 / 10000 | Close the session (WS code 1008) after this many rate-limited drops inside the window |
| `BRIDGE_MAX_PAYLOAD` | 65536 | Max WebSocket message bytes |
| `BRIDGE_SERVERS_URL` | acresources Servers.xml | Server-list URL (`none` = overlay only) |
| `BRIDGE_SERVERS_REFRESH_MS` | 1800000 | List refresh interval |
| `BRIDGE_SERVERS_CACHE` | `$TMPDIR/acjs-bridge-servers.xml` | Last good list on disk (`none` = no cache) |
| `BRIDGE_SERVERS_OVERLAY` | — | Path to an overlay JSON file |
| `BRIDGE_SERVERS_OVERLAY_JSON` | — | Inline overlay JSON |
| `BRIDGE_AC1999_LOCAL` | — | Multi mode: `<host>:<port>` of a local AC1999 (Nov 1999) server to list as "AC1999 (local)" (`tools/ac1999/start-ac1999.sh` is `127.0.0.1:9310`; needs `BRIDGE_ALLOW_PRIVATE_TARGETS=1`). The public `ac1999.cobradragon.com:9110` row is always listed (deny id `ac1999` to hide it). AC1999 rows are never era-probed |
| `BRIDGE_STATUS_URL` / `BRIDGE_COUNTS_URL` | TreeStats | Live-status / player-count feeds for `GET /servers` (`none` = off) |
| `BRIDGE_ERA_PROBE` | on | Multi mode: detect each ACE server's era from the login version it accepts (`eraDetect.ts`; one empty-password LoginRequest per literal, no account created). `off` = no probe logins |
| `BRIDGE_DRAIN_SECONDS` | 0 | On SIGTERM (a deploy), refuse new connections and keep open sessions playing until they end or this many seconds pass, then shut down. 0 = shut down at once. Railway's `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` must be at least this; SIGINT or a second SIGTERM skips the drain |
| `BRIDGE_ALLOW_PRIVATE_TARGETS` | off | **Dev only**: allow servers that resolve to private or loopback addresses |
| `BRIDGE_METRICS_TOKEN` | — | Bearer token for `/metrics` |
| `BRIDGE_ROUTINES_DIR` | dev: `~/.acjs-agent/routines`; production: off | Where `/routines` keeps each account's automation routines (`<server>/<account>.json`). A session gets a token for them with the text message `routines` once its server's CharacterList has named the account (`src/routines.ts`). Production keeps none unless this names a volume; `none` turns it off |
| `BRIDGE_ALLOW_ANY_UDP_SOURCE` | off | Accept reply datagrams from any source (default: only the target's IP on base/base+1) |
| `BRIDGE_CAPTURE` | — | Append inbound datagrams to a replay-corpus file. **Refused when `NODE_ENV=production`** |
| `BRIDGE_DEBUG` | off | Per-packet debug logs |
| `BRIDGE_LATENCY_MS` / `BRIDGE_JITTER_MS` / `BRIDGE_LOSS_PCT` / `BRIDGE_IMPAIR_SEED` | off | Simulated network impairment (test harness) |

The overlay format adds servers (an overlay id wins over a list id) and
denies ids or hosts:

```json
{ "servers": [{ "id": "my-server", "name": "My Server", "emu": "ACE", "host": "play.example.org", "port": 9000 }],
  "deny": ["<server id>", "bad.example.org"] }
```

Loopback client IPs skip the per-IP limits when no proxy is trusted, so local
dev tools and multiple tabs keep working.

## Docker

```sh
# from the repo root
docker build -f services/ws-tcp-bridge/Dockerfile -t acjs-bridge .
docker run -p 8080:8080 -e BRIDGE_MODE=multi acjs-bridge
```

The image bundles `src/` plus `ws` into one file on `node:20-slim` and runs
as the `node` user with `NODE_ENV=production`, `BRIDGE_HOST=0.0.0.0` and
`PORT=8080`. `Dockerfile.dockerignore` limits the build context to
`services/ws-tcp-bridge/src` (BuildKit uses it in place of the root
`.dockerignore`). SIGTERM sends each session's Disconnect to its server
before exiting.

## Deploying on Railway

1. Create a service from this repo. Leave the root directory at the repo
   root. `services/ws-tcp-bridge/railway.json` sets the Dockerfile path and
   the `/healthz` health check (point the service's config-file setting at
   it).
2. Variables: `BRIDGE_MODE=multi`, `BRIDGE_TRUST_PROXY=1`, `BRIDGE_CLIENT_IP_HEADER=x-real-ip`,
   `BRIDGE_ALLOWED_ORIGINS=https://<client domain>`, and optionally
   `BRIDGE_METRICS_TOKEN`. Railway sets `PORT`.
3. Generate a public domain. Railway terminates TLS, so clients connect with
   `wss://<bridge domain>/connect?server=<id>`. WebSockets are exempt from
   Railway's request timeouts. Outbound UDP works; no inbound UDP is needed.
4. Optional: attach a volume and set `BRIDGE_SERVERS_CACHE=/data/servers.xml`
   so the last good list survives redeploys.

Every player behind a shared bridge appears to the game server as the
bridge's egress IP. On servers that limit sessions per IP, ask the operator
to allowlist that IP (see `docs/release-plan.md`, "Per-IP session limits").

## Running a bridge next to your own server (operators)

Run a pinned bridge beside your ACE or GDLE server. Your players then connect
through your bridge, and your server sees your bridge's address instead of a
shared public one.

```sh
docker run -d --restart unless-stopped -p 8080:8080 \
  -e BRIDGE_TARGET=127.0.0.1:9000 \
  -e BRIDGE_ALLOWED_ORIGINS=https://<client domain> \
  --network host acjs-bridge          # Linux; or target the server's LAN address
```

- Pinned mode skips the private-address check (you chose the target) and
  ignores `?server`.
- Put it behind TLS (Caddy, nginx or a cloud load balancer) and set
  `BRIDGE_TRUST_PROXY=1` if that proxy adds `X-Forwarded-For`.
- Add the resulting `wss://` URL to your server's listing, so the client can
  connect to your server through your bridge.
