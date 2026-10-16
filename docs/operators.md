# For server operators

acjs players reach your world through a WebSocket-to-UDP bridge. On the
hosted site (playwebac.com) that is **one shared bridge**, so to your server
every browser player arrives from the **same IP address**. Nothing about your
world needs to change for this to work. This page explains what that means
and what you can do if you want more than the default.

## If your world has no per-IP limit

This is ACE's default (`MaximumAllowedSessionsPerIPAddress = -1`), and you
don't need to do anything. Browser players log in like anyone else and
appear in your logs with the bridge's address. Account auto-creation, if you
have it on, works as usual.

## If your world limits sessions per IP

If you set `MaximumAllowedSessionsPerIPAddress`, every browser player counts
against that one bridge address, so your server refuses browser logins past
the limit, as it would for any single address. The bridge adds no cap of its
own. (On 2026-10-06 none of the listed worlds that advertise an account limit
enforced it per IP at login; their limits are house rules.) The bridge limits
sessions per real player address, so one person can't open dozens.

### Letting more browser players in

Pick one:

1. **Allowlist the bridge's address.** ACE: add the bridge's egress IP to
   `AllowUnlimitedSessionsFromIPAddresses` in `Config.js` (open an issue for
   the current address). Your own per-IP limit still applies to everyone else. Note that your logs will
   show the bridge address for all browser players; the bridge logs each
   session's real address if you need it for an abuse report.
2. **Run your own bridge.** It's one small Node service (or the Docker image
   in `services/ws-tcp-bridge`) next to your server, pinned to your world:

   ```bash
   BRIDGE_TARGET=127.0.0.1:9000 BRIDGE_HOST=0.0.0.0 PORT=9090 \
   BRIDGE_ALLOWED_ORIGINS=https://playwebac.com \
     npx tsx services/ws-tcp-bridge/src/bridge.ts
   ```

   Put it behind TLS (`wss://`). Players then use **Custom…** in the launcher
   with your bridge's address. The packets come from your own machine, so
   your per-IP rules see the bridge's local address. Set
   `BRIDGE_MAX_SESSIONS_PER_IP` on the bridge to enforce a per-player limit
   by real address. See the bridge [README](../services/ws-tcp-bridge/README.md)
   for every option.

## If your world limits accounts per IP (AC1999 servers)

The AC1999 server can cap both the accounts created from one address and the
sessions online at once from one address (`max_accounts_per_ip` and
`max_sessions_per_ip` in `server.cfg`, both 2 by default since upstream
commit 11e7463f "Enforce a two account limit"; 0 = unlimited). Every browser
player shares the bridge's address, so for browser players together:

- **New accounts are refused once the bridge's address has created its
  quota.** Auto-create answers a new name with the same login-failed error it
  sends for a wrong password (`STR_LOGIN_FAILED`). Existing accounts still log
  in. Seen on the public AC1999 world on 2026-10-13: a fresh account through
  the hosted bridge was refused while returning players kept playing.
- **Only that many browser players can be online at once.** The next one gets
  `STR_LOGIN_SERVER_FULL` ("Server Full"). Admin accounts skip this cap.
- **`deploy/disable-extra-ip-accounts.sql` bans browser players' accounts.**
  It disables (`banned=1`) every account past the first N created from one
  address, and for the bridge's address that is every browser player but the
  first two. Those players then get a connection that the server closes with
  no reason.

To let browser players create accounts and play together, add an
`ip_limit_overrides` row for the bridge's egress address (as of 2026-10-12,
`50.18.108.214`; open an issue to confirm the current one). The server reads
it on every login, so no restart is needed. `-1` keeps the config default and
`0` means unlimited:

```sql
INSERT INTO ip_limit_overrides (ip_address, max_accounts, max_sessions, note)
VALUES ('50.18.108.214', 0, 0, 'webAC bridge: every browser player shares this address');
```

A better fix keeps the limits per person: adamplumb/ac1999!3 (opened
2026-10-15, not merged yet) adds `trusted_proxy_addresses` to server.cfg, the
same Simple Proxy Protocol trust as ACE's `TrustedProxyAddresses` below. With
the bridge's address listed and the bridge sending the header for AC1999
(`BRIDGE_SPP_SERVERS`), every limit applies to each browser player's own IP.

With the row in place, the SQL script skips that address (a `max_accounts`
of 0 is unlimited), and accounts it already disabled can be re-enabled by
setting `banned=0`. Running your own bridge (above) also works: your server
then sees your bridge's address, which you can exempt the same way.

The launcher marks a world with these caps ("Existing accounts only: webAC
can't create new ones here yet.") and explains its refusals in these terms
(`perIpLimits` in `services/ws-tcp-bridge/src/serverCompat.ts`). We remove the
mark once the world exempts the bridge.

## If your world blocks VPNs or proxies

The hosted bridge runs in a cloud data centre, so IP-reputation and anti-VPN
checks flag every browser player. Seen on Conquest (2026-10-12): the server
says "VPN/Proxy connections are not permitted on this server" in chat and
leaves the character in portal space. To let browser players in, exempt the
bridge's egress address from the check (as of 2026-10-12, `50.18.108.214`;
it can change when the hosting moves, so open an issue to confirm the current
one), or run your own bridge as above. The bridge logs each session's real
address if you want to screen players yourself.

**What players see until then.** A world whose check refuses the bridge is
listed with a "Blocks webAC" chip and the line "Its VPN check refuses webAC
players. We're working on a fix." in its details, and ENTER is refused with
that reason, so nobody makes an account there only to sit in portal space or
be booted
(`VPN_BLOCK` entries in services/ws-tcp-bridge/src/serverCompat.ts; Conquest
and AChard as of 2026-10-12).

**The long-term fix** we're working on: a change to the server software
([ACEmulator/ACE#4508](https://github.com/ACEmulator/ACE/pull/4508), not merged yet;
see "Seeing players' real IP addresses" below) so a trusted relay such as the bridge can pass each
player's real address, and a world's VPN check judges the player instead of
the bridge. Until a world runs it, exempting the bridge is the way in.

**Getting the block lifted.** Exempt the bridge's address as above, then
open an issue. We re-check the world through the deployed page
(`npx tsx tools/probe-world-access.ts --only <World> --recheck-blocked`,
which lets the probe past the launcher's refusal) and remove the entry once
a fresh account reaches the world without the VPN message. The launcher
picks that up on the next bridge deploy.

**Survey, 2026-10-12** (`tools/probe-world-access.ts`: one throwaway account
and character per online world through playwebac.com, listening 25 s in the
world). Of 34 online worlds:
- **27 let webAC players in:** ACPrime, Asheron4Fun.com, BartleSkeetHG,
  Buadren AC, Coldeve, Derptide, Doctide, DreamWeave, Drunkenfell, Eversong,
  Frostcull, FrostfACE, Harvestagain, InfiniteLeaftide, Jellocull, LeafDawn,
  Leafdawning, Levistras, Mistwood, Morgentau, PortalStorm, Shadowgain,
  Shadowland, Soulclaim, Sundering, The Tower, Thistlecrown.
- **2 block the bridge as a VPN:** Conquest (in the world: chat line, held in
  portal space) and AChard (at login: "You have been booted… Connections from
  VPN / proxy disallowed by server policy"). Both are now marked "Blocks
  webAC" and refused at ENTER (above).
- **1 unclear:** Modclaim completes the handshake but never sends the
  character list (2+ minutes, twice); a silent block or a server problem.
  Not marked: nothing it sent names a VPN or IP check.
- **2 need web registration first** (no first-login account creation, not an
  IP block): Reefcull and Harvestbud (GDLE web form). A fresh account times
  out with "Client timed out the connection".
- Seedsow and Snowreap (same host) timed out during the survey, but a fresh
  account's first login on Seedsow worked minutes later through
  playwebac.com, and a local GDL-Classic server creates and logs in a fresh
  account on the first try: a transient server-side stall, not a webAC bug
  and not registration.
- Seedsow and Snowreap run Classic Dereth **1.0** data (no Salvaging skill).
  A client on the 1.1 files trains Salvaging at creation and the server
  answers Corrupt ("The server cannot create your new character at this
  time"). webAC sends the 1.0 skill list to both since 2026-10-12
  (docs/dark-majesty-support.md, "Seedsow is 1.0 too"). If you run a GDL world
  on 1.1 data, tell us and we will list it with the 1.1 era.

## Seeing players' real IP addresses (proposed, not available yet)

**Status (2026-10-12): no server can use this today.** Stock ACE has no support for
it. We've proposed it upstream in
[ACEmulator/ACE#4508](https://github.com/ACEmulator/ACE/pull/4508), which is not
merged. Until a server runs that change and we've finished our side (below), every
browser player still reaches your world from the bridge's address, as described above.

How it would work: allowlisting the bridge, as above, takes per-IP rules off
browser players entirely. To apply your rules to each browser player by their
*own* address, the bridge would tell your server who each player is. It prepends a
38-byte [Simple Proxy Protocol](https://developers.cloudflare.com/spectrum/reference/simple-proxy-protocol-header/)
header (the format Cloudflare Spectrum uses for UDP) to every datagram, carrying
the player's real address. A server running the proposed change, with the bridge
listed as trusted, uses that address for `MaximumAllowedSessionsPerIPAddress`,
the unlimited-sessions allowlist, account IPs and admin displays. A player with
three native clients open and a fourth in the browser then counts as four
sessions from one address. The server echoes the header on its replies, as the
spec requires, and the bridge strips it.

- **ACE:** needs the `TrustedProxyAddresses` setting from ACE#4508. If you want it
  before that is merged (or if it isn't), the PR's single commit applies to an
  ACE fork as is. You would list the bridge's egress addresses there. Datagrams
  from a listed address must carry the header; everyone else's are handled
  exactly as before. Other emulators (GDLE, ClassicACE forks) have no
  equivalent yet.
- **Bridge addresses.** Since 2026-10-16 the hosted bridge runs on AWS and sends
  from one dedicated address of its own, **184.193.176.126** (an Elastic IP; no
  other customer shares it), for every world except those listed under
  "Per-session addresses" below. That is the address to list in
  `TrustedProxyAddresses` or an IP-limit exception.
- **Turn it on at the same time on both sides.** A server that trusts the
  bridge drops datagrams without the header. One that doesn't trust it reads
  the header as a broken packet. Tell us when your server is ready, and we add
  your server id to the bridge's `BRIDGE_SPP_SERVERS` (a self-hosted bridge
  pinned to one server: `BRIDGE_SPP=1`).
- The bridge skips its era-detection login on these servers (that probe would
  carry no player address); your world's era comes from the launcher list instead.

## Accounts and registration

If your world creates accounts on first login, the launcher tells new
players that. If you require web or Discord registration, the launcher can
show a note with your link (the bridge's `registration` text plus
`registrationUrl`, in services/ws-tcp-bridge/src/serverCompat.ts): the note
and a "Register" link appear in the world's details, and a first login that
times out repeats the note with the link. Reefcull and Harvestbud have one.
Open an issue with the text and a source (your website or Discord) and
we'll add it.

## GDLE worlds

GDLE worlds that use the end-of-retail data files work and are labelled
"beta" in the launcher. See [gdle-compat.md](gdle-compat.md) for what has
been tested. Worlds that need the classic (Dark Majesty) data files load
that era's data and are labelled "Dark Majesty era"
([dark-majesty-support.md](dark-majesty-support.md)).

## Opting out

If you don't want your world listed in the browser launcher, open an issue
and we'll add it to the bridge's denylist the same day.

## Per-session addresses (worlds that limit per IP in code)

A world whose server enforces per-IP limits in code would otherwise see every
webAC player as the one bridge address. For such worlds (AC1999 today) the
bridge gives **each session its own public address** from AWS (us-east-1
Elastic IPs, allocated when the session opens and released a couple of minutes
after it ends). So the server sees one address per webAC
player, which is what its per-IP rules assume.

The bridge applies the world's own limits per **real player address** on its
side as well: at most the world's session limit at once from one player
address, and at most the world's new-account limit created from one player
address. An account counts as new when the bridge hasn't seen it before and the
server shows it with no characters. It also never lets one Elastic IP create
more accounts than the world allows per address. Each session's log line records
the player's real address next to the address the server saw (`ip=` and
`egressIp=`). If you see something from one of those addresses that you want
dealt with, tell us the address and time and we'll map it to the player and
apply your decision (including a ban) on our side.

If your server adopts real-IP forwarding (Simple Proxy Protocol, above), we'll
switch your world back to the single fixed address and send you the player's
real IP instead.
