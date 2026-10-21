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
  `server_cap`, `private_target`, `dns_failed`, `egress_ip_cap`, `egress_full`,
  `egress_new_account_cap`, `egress_new_account_unavailable`, ...), bytes by direction
  (`ws_in` browser→bridge, `udp_out` bridge→server, `udp_in` server→bridge,
  `ws_out` bridge→browser) and dropped messages. Set `BRIDGE_METRICS_TOKEN` to
  require `Authorization: Bearer <token>`.

Logs are one JSON object per line. Every session's `session_close` line
carries `durationMs`, `bytesFromBrowser`, `bytesToServer`, `bytesFromServer`,
`bytesToBrowser` and packet counts. Use these to measure per-player bandwidth.
Hosting egress is roughly `bytesToServer + bytesToBrowser`. A `reason: ws_close`
line also carries `peerCloseCode`, the browser socket's close code: 1005 = the
page's own code closed it (ClientConnection ending a session it judged dead or
the server ended), 1001 = the page went away (tab closed, reload), 1006 = the
connection dropped with no close frame (an edge proxy, the network, or the
bridge's own ping timeout, which logs `session_ping_timeout` first).
Every `session_close` also carries `browserQuietMs` (how long since the page's
own code last sent a WebSocket message, binary or text) and `serverQuietMs`
(how long since the game server's last datagram); each is left out when nothing
ever arrived that way. The ping check can't tell these apart: the browser
answers protocol pings even while a hidden tab's JavaScript is frozen, so a
frozen page shows as a large `browserQuietMs` on a socket that never timed out.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `BRIDGE_PORT` | 9090 | Listen port (first positional arg wins, then `BRIDGE_PORT`, then `PORT`, which many hosting platforms set) |
| `BRIDGE_HOST` | 127.0.0.1 | Listen address (`0.0.0.0` in the Docker image) |
| `BRIDGE_MODE` | pinned | `multi` enables `?server=<id>` (ignored when a target is pinned) |
| `BRIDGE_TARGET` | — | Pinned target `host:port` (world port = port+1); same as the positional args |
| `BRIDGE_ALLOWED_ORIGINS` | — | Extra browser Origins allowed (comma list, or `*`). Loopback origins and clients without an Origin always pass. **Set this to the client's origin in production** |
| `BRIDGE_TRUST_PROXY` | off | Trusted proxy hops in front of the bridge (`1`/`true` = one). Only then is `X-Forwarded-For` used for the client IP (the Nth entry from the right). Set to `1` behind one proxy (playwebac.com: nginx) |
| `BRIDGE_CLIENT_IP_HEADER` | unset | With `BRIDGE_TRUST_PROXY`, a single-value header the edge overwrites with the client address, preferred over `X-Forwarded-For`. playwebac.com: `x-real-ip`, which its nginx overwrites with the TCP peer (deploy/aws/host/nginx-webac.conf). Prefer such a header wherever the edge appends itself to `X-Forwarded-For`, as Railway's did, since hop counting would then pick the edge |
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
| `BRIDGE_DRAIN_SECONDS` | 0 | On SIGTERM (a deploy), refuse new connections and keep open sessions playing until they end or this many seconds pass, then shut down. 0 = shut down at once. Whatever runs the old container must let it live at least this long (playwebac.com: 21600, with nginx's `worker_shutdown_timeout` 6h10m keeping the old WebSockets open); SIGINT or a second SIGTERM skips the drain |
| `BRIDGE_ALLOW_PRIVATE_TARGETS` | off | **Dev only**: allow servers that resolve to private or loopback addresses |
| `BRIDGE_METRICS_TOKEN` | — | Bearer token for `/metrics` |
| `BRIDGE_ROUTINES_DIR` | dev: `~/.acjs-agent/routines`; production: off | Where `/routines` keeps each account's automation routines (`<server>/<account>.json`). A session gets a token for them with the text message `routines` once its server's CharacterList has named the account (`src/routines.ts`). Production keeps none unless this names a volume; `none` turns it off |
| `BRIDGE_ALLOW_ANY_UDP_SOURCE` | off | Accept reply datagrams from any source (default: only the target's IP on base/base+1) |
| `BRIDGE_SPP` | off | Pinned mode: the target trusts this bridge and reads each player's real address from a [Simple Proxy Protocol](https://developers.cloudflare.com/spectrum/reference/simple-proxy-protocol-header/) header on every datagram. Needs a server running the proposed ACE `TrustedProxyAddresses` (ACEmulator/ACE#4508, not merged; stock ACE has no support). Turn on only together with the server (docs/operators.md) |
| `BRIDGE_SPP_SERVERS` | unset | Multi mode: comma-separated server ids that trust this bridge (as `BRIDGE_SPP`); era probes skip them |
| `BRIDGE_EGRESS_SERVERS` | unset (off) | Per-session egress addresses (below): comma list of `<server id>:<sessionsPerAddress>[:<newAccountsPerRealIp>[:<accountsPerAddress>]]`, e.g. `ac1999:2:2:2` (pinned mode: `pinned:…`). `accountsPerAddress` (the world's lifetime account creations per source address) defaults to `newAccountsPerRealIp`. Unset = off: no egress code runs and the AWS SDK is never loaded. A malformed entry stops the bridge from starting |
| `BRIDGE_EGRESS_PROVIDER` | aws | `aws`: an Elastic IP per slot (secondary private IPv4) while it carries sessions. `static`: the slots are used as they are (tests, dev with loopback aliases, a host whose addresses are already public) |
| `BRIDGE_EGRESS_SLOTS` | aws: discovered | Comma list of local IPv4s to bind sessions to. `aws` default: every secondary private IPv4 on every ENI of the instance (IMDSv2), never an ENI's primary address. Required for `static` |
| `BRIDGE_EGRESS_DIR` | `/var/lib/webac/egress` | State shared by every bridge process on the host (both sides of a blue/green drain): lock files, the hash salt, the account sets. Must be writable by the bridge's user (uid 1000 in the image) |
| `BRIDGE_EGRESS_GRACE_SECONDS` | 120 | How long a slot keeps its address after its last session ends (a new session inside it reuses the address) |
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

The image bundles `src/` plus `ws` and `@aws-sdk/client-ec2` into one file on `node:20-slim` and runs
as the `node` user with `NODE_ENV=production`, `BRIDGE_HOST=0.0.0.0` and
`PORT=8080`. `Dockerfile.dockerignore` limits the build context to
`services/ws-tcp-bridge/src` (BuildKit uses it in place of the root
`.dockerignore`). SIGTERM sends each session's Disconnect to its server
before exiting.

## Deploying

playwebac.com runs the bridge on AWS (docs/aws-hosting.md: one EC2 host, nginx in
front, blue/green deploys that drain the old container; it moved there from Railway on
2026-10-16). To host one yourself, the same shape works anywhere that runs a
container:

1. Build and run the image (Docker, below) from the repo root. Health check:
   `GET /healthz`.
2. Variables: `BRIDGE_MODE=multi`, `BRIDGE_ALLOWED_ORIGINS=https://<client domain>`,
   and optionally `BRIDGE_METRICS_TOKEN`. Behind a proxy, also
   `BRIDGE_TRUST_PROXY=1` and `BRIDGE_CLIENT_IP_HEADER=x-real-ip` with the proxy
   overwriting `X-Real-IP` with the client address.
3. Terminate TLS in front of it (playwebac.com: nginx with WebSocket upgrade and
   a long `proxy_read_timeout`, deploy/aws/host/nginx-webac.conf), so clients
   connect with `wss://<bridge domain>/connect?server=<id>`. Outbound UDP must
   work; no inbound UDP is needed.
4. Optional: keep `BRIDGE_SERVERS_CACHE` on persistent storage so the last good
   list survives redeploys.

Every player behind a shared bridge appears to the game server as the
bridge's egress IP. On servers that limit sessions per IP, ask the operator
to allowlist that IP (see `docs/release-plan.md`, "Per-IP session limits"),
or give that server per-session egress addresses (next section).

## Per-session egress addresses (`src/egress.ts`)

For a world whose per-source-address caps every webAC player would share
(AC1999: 2 live sessions and 2 accounts created per address, ever), the
bridge gives each session to it a local address of its own (a "slot") and
binds the session's UDP socket to it. On AWS (`BRIDGE_EGRESS_PROVIDER=aws`)
a slot is a secondary private IPv4 of the instance; when it gets its first
session the bridge allocates an Elastic IP (tag `webac:egress` = the slot's
private IP) and associates it before the WebSocket upgrade completes, and
after the slot's last session plus the grace period it disassociates and
releases it, so the cost ($0.005/hour per address) follows play time.

Slot choice for a session to world W from real IP R (an IPv6 player is
keyed by their /64): refuse when R already holds W's per-address session
limit on W (all bridge processes counted); otherwise a slot with no session
on W (one player per address), else one with fewer than the limit (sharing up
to the world's own cap), else refuse. A slot carries sessions to different
worlds independently.

Because every fresh address also resets the world's lifetime account cap,
the bridge applies it per real IP. The login (the 1999 or end-of-retail
LoginRequest) is read before it is forwarded. A known account (one that has
reached a character list through this bridge) always logs in. A login for an
unknown account is refused when R's markers are at `newAccountsPerRealIp`;
otherwise it goes through and leaves a `pending` marker for R right away,
because the server creates the account while handling that login. The
account's first character list resolves the marker: no characters (a just
auto-created account has none) and still unknown makes it `created`, kept
for good; characters listed, or already known, drops it. A marker whose
character list never comes (the session closed first) stays counted, for at
most 30 days, unless the server explicitly refused that login in a way that
proves it made no account: the AC1999/GDLE NetError ClientLogOnFailed,
BadCryptoKey or PlayerAlreadyLoggedOn, or ACE's CharacterError
AccountDoesntExist / Logon, AccountBanned, or a wrong-password AccountBoot.
Then the markers that login wrote (real IP and address) are dropped
(`egress_login_refused`). ServerFull and ACE's LogonServerFull / ServerCrash1
don't count as refusals (both servers send them after auto-creating), nor
does a silent drop. Every login of one session counts, so trying several names
doesn't multiply the allowance. Edges: an existing account first seen
through webAC after R reached its limit is refused (the gate can't tell it
from a creation before the server answers; it logs in from any other
network, after which it is known); an existing account with no characters,
first seen through webAC, counts as created; and a login whose answer never
came keeps counting for its 30 days.

The world also counts account creations per SOURCE address, for life
(AC1999 `max_accounts_per_ip`), and AWS hands a recently released Elastic IP
back to the same account, so egress addresses would wear out. The bridge
keeps the same markers per public address and world
(`accounts/<world>/by-addr/<public ip>/`, written and resolved together with
the real IP's). A login for an unknown account on an address that has made
`accountsPerAddress` creations (created plus pending) moves the session,
before the login is forwarded, to another slot whose address has both
session and creation room, else to a free slot with a newly allocated
address (`moved`; a socket already bound to the old address is replaced,
since nothing of this login has left it). An allocation that comes back
spent (recycled) is kept while the bridge allocates again (up to 5 tries),
then released. When nothing with room can be had, the login is refused with
`new_account_unavailable` (4504) and the real IP keeps its allowance. Known
accounts ignore address history. Slot choice prefers a held address with
creation room, then a spent held one, then a new allocation; idle spent
addresses are released before other idle ones.

The 1999 login is read as the release client's (`4.35752`) codec writes it
and the AC1999 server's release mode reads it (u16 version length). A world
on another codec (preview, Sep-2000 sentinel) would leave logins unparsed,
which are forwarded (the rule then doesn't apply): don't list such a world
with an account limit until the parser learns its codec.

Ghost sessions: when a player's tab dies without a clean disconnect, the
world keeps their old session up to its own timeout (60 s for ACE) while the
bridge has already freed the slot, so a new player put on that address in
that window counts against the world's per-address cap with the ghost. With
`sessionsPerAddress` 2 this only matters when every other slot is full.

Refusals close the WebSocket with codes the client maps to plain messages
(`packages/network/src/BridgeRefusal.ts`): the per-real-IP session cap is the
bridge's `ip_cap` (4429), no free slot or an AWS failure (address quota,
throttling) is `world_full` (4503), the new-account limit is
`new_account_cap` (4403), and no address that may still create accounts is
`new_account_unavailable` (4504). An egress world's `/servers` row drops its
shared-cap warning and `perIpLimits`.

State lives in `BRIDGE_EGRESS_DIR`, shared by both bridge processes of a
blue/green deploy: a lock file per live session (exclusive create, refreshed
every 30 s, stale after 120 s), per-slot address records, and the account
sets. Real IPs and account names are stored only as salted hashes (the salt
file is created once in the dir). Mutexes hold a random token, are touched
while held, are taken over once stale (`alloc.lock` after 5 s, slot and
reconcile locks after 60 s), and are deleted only by their token's owner.
Every lock wait is async: no world's traffic stops while one waits.

A reconciler runs at start and every 5 minutes (one process at a time). It
only looks at this instance's addresses: tagged ones associated with one of
its ENIs, or unassociated ones tagged `webac:egress-instance` = its instance
id (every allocation carries both tags). It releases any whose slot has no
live session and is past its grace, and any no slot record names; it adopts
an associated address whose record was lost while sessions use it; it
forgets a record whose address is gone only after two consecutive listings
miss it and never under live sessions. A failing slot is logged and skipped.
Before a disassociate the slot's record is rewritten to claim no association,
so a crash between disassociate and release leaves an unassociated
allocation, which the next session on the slot or the reconciler gives back.

On shutdown (SIGTERM, after the drain), the bridge waits for AWS work under
way, then releases at once, without the grace, every address whose slot no
bridge process has a session on, so a bridge with no successor leaves
nothing billing; slots the other process still uses are left to it. The
whole step gives up after 20 s (`egress_stop_deadline`); the next
reconciler frees whatever is left.

Every EC2 call gives up after 10 s (the SDK's HTTP handler has no timeout of
its own), so a stalled endpoint refuses that session as `world_full` instead
of holding a slot lock or the admission. The first reconcile at startup is
waited for at most 15 s and goes on in the background. When a slot's
allocation fails, the player falls back to another slot that already holds
an address with room (`egress_fallback`). If a failed call actually took
effect at AWS (an associate whose answer timed out), the bridge gives back
every address tagged for that slot that no record names, under the slot's
lock, and the reconciler releases such an orphan at once.

A freshly associated Elastic IP passes no traffic for a few seconds after
`AssociateAddress` returns (1.7–3.2 s, measured seven times on the production
host), and every datagram sent in that window is silently
lost: an AC1999 client that logs in at 0 s and 2 s got nothing back and gave
up. So after a fresh association the bridge polls
`https://checkip.amazonaws.com/` bound to the slot's private IP (every
250 ms, 1 s per request, 10 s in all) until the answer names it. Checkip
is inside AWS, so that proves only the address's path inside AWS: it can
pass about 1 s before the path to outside hosts opens in both directions.
So a world with a path probe (`pathProbeFor(protocol, target)`, egress.ts)
then waits, best-effort, for an answer from the session's own world server:
for the AC1999 protocol, the server-tracker login (account
`acservertracker`, `AC1999_TRACKER_LOGIN`) sent from a socket bound to the
slot's private IP to the session's target host:port every 250 ms for its first 2 s, then every 1 s (`pathProbePollMs`: each is a query on the AC1999 server's single DB thread, and a stalled one once got 24 in 6 s; now 12), ready on
the first reply from that host:port, for at most `PATH_PROBE_MAX_MS` (6 s,
or what is left of the 10 s). With no reply the address is used anyway on
checkip's word (`egress_path_unconfirmed`, warn: slot, publicIp, target,
ms, attempts): it is never released, retried or refused for that, since the
port rotation and the 5 s move below cover a path still opening, and a
world that is down fails in the game as before instead of as a false
`world_full`. `egress_not_ready` and `aws:NotReady` are checkip's only. The AC1999 server special-cases that
account before any other check and answers STR_LOGIN_FAILED, keeping no
state and creating no client, so the probe can't leave a Connecting client
behind. The bridge passes acquire the session's target (its resolved
`sendHost`, `authPort`, protocol). Worlds with no path probe (end of retail,
an SPP server, whose datagrams would need the header) stay on checkip alone.
`egress_ready` names the probe that decided it (`probe: 'checkip'` or
`'ac1999-tracker'`, ms in all, attempts of that probe, `target`, and
`checkipMs` / `checkipAttempts` with a path probe). An address checkip never confirms is logged
(`egress_not_ready`, warn), released, and one fresh address tried in its
place; if that one fails too, the acquire fails as a failed attach does
(`aws:NotReady`: a fallback slot, else `world_full`). Reusing an address a
slot already holds never waits. The new-account move to a newly allocated
address goes through the same path. The host needs outbound HTTPS from its
secondary IPs (the default security group allows it).

One session on a fresh address once got no server byte for 12 s across six
login resends from one source port, well after the dead window: most
likely a lost first grant, after which the AC1999 server ignores that
endpoint (below). As a last resort an egress
session whose server has sent nothing 5 s after its first upstream datagram
(`NO_REPLY_MOVE_MS`) is moved once (`moveForNoReply`): to another slot
holding a working address with room on the world, else a free slot with a
new address (readiness-checked). Its socket is closed and rebound there, the
last datagram is resent at once, and the browser's own login resends follow.
The old address is retired at once (`egress_release` why `no_reply`) unless
another session still uses it. Never after any server byte (AC1999 answers
only the address that logged in; a reply during the move undoes it), never
twice per session. The per-real-IP caps are unchanged (same session); an
unresolved new-account login needs creation room at the new address and
gets a pending marker there, and the old address's marker stays (the
server may have made the account and lost only its replies). A real move
is logged as `egress_no_reply_move` (from, fromIp, to, toIp, ms). A move
that doesn't happen is `egress_no_reply_stay` (from, fromIp, ms, reason,
attached): reason `answered` (info) when the server replied meanwhile,
checked before a slot is chosen and again once a new address is ready, so
no AWS call starts once a reply is in; else `no_slot`, `aws:<code>`, …
(warn). `attached` names a fresh address made for an abandoned move; it
keeps its normal idle grace and can serve the next session.

Early resends rotate the source port. A login can reach the AC1999 server,
be granted, and have the grant lost on the way back (server-side slot-id
gaps on 2026-10-17 showed this happening on fresh addresses). The server's
`AcceptClientLogin` then ignores every further login from the same source
endpoint while that account's client is Connecting (reference/ac1999
Network.cpp), so the same login resent from the same port gets nothing.
Reproduced against the local server: a login whose grant went unread,
resent twice from the same port, got no reply; the same login from a new
port was answered in 5 ms ("Re-connect for account … dropping stale
session"). So an egress session with no server byte yet resends its last
upstream datagram 1, 2, 3 and 4 s after its first (`EARLY_RESEND_MS`, all
before the 5 s no-reply move), each from a new UDP socket bound to the same
slot (same lease, same address): the old socket is closed (its late
datagrams are never read) and the new one becomes the session's socket for
replies, grant parsing, counters and the disconnect at cleanup.
`egress_early_resend` (debug: session, n, port, the new local port). They
are counted as normal upstream packets, stop at the first server byte, a
close, a move or a slot change, and skip a beat while a login check holds
the session. The browser resends its login only every 6 s (as the 1999
client did). The first server byte of an egress session logs
`egress_first_reply` (info: ms since the first datagram, earlyResends),
which shows whether a rotation is what got answered. (A 500 ms same-port
schedule, tried 2026-10-17, made it worse: 9 of 16 sessions slow, against
3 of 18 before, since only a port change rescues a lost grant.)

If egress can't start (no IMDS, no secondary IPs, a `BRIDGE_EGRESS_SLOTS`
address that isn't one), the bridge logs `egress_start_failed` at error
level and keeps running: its egress worlds are refused as `world_full`, every
other world works, and it retries after 30 s, 2 min, then every 10 min
(`egress_start_recovered` when one works).

Logs: `egress_start` (or `egress_start_failed`), `egress_acquire` /
`egress_associate` (slot, public IP, timings), `egress_ready` /
`egress_not_ready` (the readiness check), `egress_path_unconfirmed`, `egress_session_end`,
`egress_early_resend` / `egress_first_reply`, `egress_no_reply_move` / `egress_no_reply_stay`,
`egress_release` (`why`: idle, shutdown, orphan, unfinished, failed_attach, not_ready, no_reply),
`egress_fallback`, `egress_moved` (a new-account login left a spent address), `egress_stop_deadline`, `egress_refused`
(reason, e.g. `aws:AddressLimitExceeded`), `egress_reconcile`,
`egress_account_known` (`created` true when it counted), `egress_session_error`
(a state-dir failure that closed one session as `world_full`);
these carry only the hashed real IP. `session_open` / `session_close` carry
`egressSlot` and `egressIp` next to the session's `ip`, which maps an
operator's report about an address back to a player.

AWS setup: IMDS must allow `instance-id` and the ENI listing; the instance
role needs `ec2:AllocateAddress`, `ec2:CreateTags` (both tags on create), `ec2:AssociateAddress`, `ec2:DisassociateAddress`,
`ec2:ReleaseAddress` and `ec2:DescribeAddresses`; IMDSv2 must be reachable
from the container (host networking, hop limit 2 if bridged); the secondary
private IPs must be configured on the OS interfaces (Amazon Linux 2023's
amazon-ec2-net-utils does this, including the policy routing a secondary ENI
needs); and the account's Elastic IP quota (default 5 per region) bounds the
concurrent slots. The region comes from `AWS_REGION` or IMDS.

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
