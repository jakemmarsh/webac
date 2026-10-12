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

## If your world blocks VPNs or proxies

The hosted bridge runs in a cloud data centre, so IP-reputation and anti-VPN
checks flag every browser player. Seen on Conquest (2026-10-12): the server
says "VPN/Proxy connections are not permitted on this server" in chat and
leaves the character in portal space. To let browser players in, exempt the
bridge's egress address from the check (as of 2026-10-12, `50.18.108.214`;
it can change when the hosting moves, so open an issue to confirm the current
one), or run your own bridge as above. The bridge logs each session's real
address if you want to screen players yourself.

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
  VPN / proxy disallowed by server policy").
- **1 unclear:** Modclaim completes the handshake but never sends the
  character list (2+ minutes, twice); a silent block or a server problem.
- **2 need web registration first** (no first-login account creation, not an
  IP block): Reefcull and Harvestbud (GDLE web form). A fresh account times
  out with "Client timed out the connection".
- Seedsow and Snowreap (same host) timed out during the survey, but a fresh
  account's first login on Seedsow worked minutes later through
  playwebac.com, and a local GDL-Classic server creates and logs in a fresh
  account on the first try: a transient server-side stall, not a webAC bug
  and not registration.

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
been tested. Worlds that need the classic (Dark Majesty) data files are
listed but can't be entered yet.

## Opting out

If you don't want your world listed in the browser launcher, open an issue
and we'll add it to the bridge's denylist the same day.
