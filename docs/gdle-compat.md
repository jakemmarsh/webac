# GDLE compatibility (roadmap-era-variants Tier 2)

Status of the browser client against vanilla GDLEnhanced (GDLE) servers.
Latest pass: **2026-10-04, a local GDLE 1.34 server** (tools/gdle/). The
whole flow runs: first-login account creation, character creation, world
entry, movement, /say, inventory and character panels, NPC use, logout and
log back in. It took four client wire fixes (quirks 2 to 5 below), all
checked against ACE as well.

## Local server (tools/gdle/)

| Piece | What |
|---|---|
| `tools/gdle/Dockerfile` | Builds GDLE 1.34 (gitlab.com/Scribble/gdlenhanced @ `353cbab5`, the last public release) for **linux/amd64**, run under Docker Desktop's emulation on Apple Silicon (MathLib.h needs `<x86intrin.h>`). Debian bookworm, not upstream's Alpine: musl's C++ `NULL` is `nullptr` and GDLE passes `NULL` to `uint32_t` parameters. GCC 12 needs `-include cstring -include strings.h`. The image carries GDLE's world data (`Bin/Data`: cache.bin, json/, worlddesc; `Data/misc` laid out lower-case as `data/misc`, which Linux needs) and `Bin/sqldumps`. About 6 min to build. |
| `tools/gdle/server.cfg` | Upstream config with `bind_port=9110` (GDLE also binds 9111; 9100-9101 belong to `tools/retail-client-udp-relay.mjs`), DB host `gdle-db`, `world_name=GDLE-local`, **`auto_create_accounts=1`**. |
| `tools/gdle/start-gdle.sh` | `start` (default: build if missing, create or start `gdle-db` + `gdle-server`), `stop`, `status`, `reset`. Network `gdle_net`, volume `gdle-db-data`, MariaDB 10.11 (native arm64, no host port; use `docker exec gdle-db mariadb -ugdle -pgdle gdle`). Schema = `gdle_db.sql` + `1_34.sql` + the two `blob_update_*` procedures, extracted into the gitignored `tools/gdle/run/`. The EoL `client_portal.dat` / `client_cell_1.dat` are mounted read-only from `./dat` (`GDLE_DAT_DIR` overrides; a worktree whose `dat` is a symlink should pass the real path). Ours match GDLE's published MD5s exactly (`2c89662a…`, `6401b73f…`). Stop sends SIGINT: GDLE ignores SIGTERM. |
| `tools/gdle/probe-flow.ts` | Headless SwiftShader Playwright flow driver: `login`, `create:<Name>`, `enter`, `world` (move, /say, F12 inventory, F9 character, object list), `use:<npc>`, `logout`, `relogin`. |

It never touches `ace-server` / `ace-db` / `ace_default` or ports 9000-9003 / 3306.

**Without Docker (cloud containers):** `bash tools/gdle/start-gdle-native.sh`
builds the same commit natively on x86_64 Linux (about 10 min the first time,
in `~/.cache/acjs-gdle-native`, outside the repo because CMake writes a
`compiler_depend.ts` that `tsc -b` would pick up) and backs it with the local
MariaDB from `tools/provision-ace-stack.sh` (database `gdle`, user gdle/gdle).
Cloud containers can start `dockerd`, but Docker Hub rate-limits their pulls
(429), so the Docker path does not work there. `GDLE_TELEPORT=1` turns on
GDLE's player `/teletown` and `/teleloc` for probes. The agent tools play it
with `era=gdle` (`tools/ac-agent/eras.ts`: end-of-retail client, ports
9110/9111, its own `…gd` account).

```bash
bash tools/gdle/start-gdle.sh                                   # ~5 s when built; world loads in ~2 s
npx tsx services/ws-tcp-bridge/src/bridge.ts 9092 127.0.0.1 9110 9111
# then  http://localhost:<vite>/?ace&bridge=ws://localhost:9092&account=<new lower-case name>&password=<pw>
CONSOLE_LOG=/tmp/gdle-console.log GDLE_BASE=http://localhost:<vite>/ \
  npx tsx tools/gdle/probe-flow.ts gdleprobe3 probepw3 /tmp/gdle-shots login create:Gdleprobe world logout relogin enter
bash tools/gdle/start-gdle.sh stop
```

Footprint while running: gdle-server about 540 MB RSS and 3% CPU idle under emulation; gdle-db about 115 MB.

## Flow results (local GDLE, 2026-10-04, headless SwiftShader)

Screenshots: `verification/gdle-probe/`.

| Step | Result | Evidence |
|---|---|---|
| Login, first-login auto-create | **OK after fixes 2 and 3.** Before fix 2, GDLE ignored every LoginRequest. Before fix 3, GDLE dropped the session right after our DDD response. | GDLE log `Client gdleprobe1 … connected`, then `disconnected` 30 ms after the 0xF7E6. After the fix: `DDD_EndDDD` and a stable session. |
| Character list (empty account goes to chargen) | OK. Before fix 5, the list arrived 2 s late on every login (fragment gate stall). | `01-first-login-chargen.jpg` |
| Character creation | OK: `CharacterCreateResponse` with GUID 0x50000001, then straight into the world in the Training Academy start room (0x870301AD). GDLE's welcome book opens. | `02-world-after-create.jpg` |
| Character select / enter world | OK; world plate shows `GDLE-local` (ServerName). | `03-charselect.jpg`, `04-in-world.jpg` |
| Movement | OK: the position persisted across logout (12.32,-28.48 to 5.53,-34.45). This needed fix 4. Before it, GDLE logged `Bad instance.` and dropped our AutonomousPosition. | `05a-after-move.jpg` |
| /say chat | OK: `You say, "Hello from acjs on GDLE"`. | `05b-say-chat.jpg` |
| Inventory (F12), character panel (F9) | OK: 12 starting items, burden, paperdoll; skills, level 1, heritage. | `05c-inventory.jpg`, `05d-character.jpg` |
| NPC use (Academy Crier, Academy Shopkeep) | Server answered `UseDone` (0), then a `PlayerTeleport` to the player's own cell, both times; no vendor window and no speech. The client handled the teleport correctly (portal space, then back in the room). **Cause not established** (see open items). | `05e-npc-use-teleport.jpg`, `05f-after-npc-teleport.jpg` |
| Logout | OK: `Client N is exiting the world`, and the character list returns after 6 s (the retail logout animation). | `06-after-logout-charselect.jpg` |
| Log back in | OK and quick (3 to 10 s). The bridge's Disconnect on WS close frees GDLE's slot, so the "relogin while old session alive" stall did not occur. | `07-relogin-charselect.jpg` |
| ACE regression | The same worktree client logged in to the local ACE (new account `gdlecheck1`): DDD_EndDDD, then the character list with no stall. | console log |

**Environment limit, not a protocol bug:** GDLE kills a client after **30 s
without a packet** (`CClient` `lastactivity >= 30.0f`). Under headless
SwiftShader on a loaded machine, our first world entry blocks the page's
main thread for 22 to 51 s (measured: the first ping after entry
round-trips in 22-51 s). Three of seven entries hit the limit and were
dropped (GDLE `disconnected` about 30 s after `entering the world`). ACE
tolerates it. On a real GPU the stall should be far shorter (not measured
here: GPU modes were off-limits during this pass). Still worth tracking: a
slow machine would see the same drop on GDLE.

## Quirks (GDLE 1.34 source vs our client)

### 1. AccountToLoginAs carried the account name: FIXED

* Root cause: `packages/network/src/ClientConnection.ts` `sendLoginRequest`
  (~line 869) wrote the account name into the `AccountToLoginAs` String16L.
  Retail leaves it empty: `NetAuthenticator::NetAuthenticator` @ 005407f0
  sets `m_AccountToLogonAs` to the null buffer, and nothing else sets it. ACE
  reads the field and ignores it ("special admin only, AuthFlags has 2",
  PacketInboundLoginRequest.cs). **GDLE's AuthenticateUserQuery (Network.cpp,
  auth type 2) reads that slot as a fixed `uint32`**, so a non-empty string
  shifts the password read. With auto-create on, GDLE would have created the
  account with a garbage password taken from account-name bytes.
* Fix: send an empty String16L (4 bytes), matching retail. DataLength was
  updated to match.
* Tests: `tests/verify-login-auth-enums.ts`. The existing wire test now
  expects `''`. New tests run the real `sendLoginRequest` and parse its bytes
  the ACE way (PacketInboundLoginRequest order) and the GDLE way (fixed u32,
  dataLen, packed-u16 length, chars), for account names of several lengths
  that hit every alignment case. Both parsers must recover the password.

### 2. LoginRequest header Id was 1: FIXED

* Root cause: `ConnectionData`'s constructor defaulted `clientId` to 1, and
  `sendPacket` stamps `clientId & 0xFFFF` into the header Id. GDLE
  `CNetwork` (Network.cpp, IncomingThreadProc and ProcessQueuedIncoming)
  only treats a datagram as a login when `wRecID == 0`
  (`ProcessConnectionless`). Anything else goes to `ValidateClient`, finds no
  session, and is dropped silently: four retries, then "Login timed out". ACE
  ignores the Id on LoginRequest. Retail takes its id from the server's
  ConnectRequest (`ClientNet::HandleConnectionRequest` @ 00545ac0).
* Fix: `packages/network/src/ConnectionData.ts` defaults `clientId` to 0
  until ConnectRequest assigns it.

### 3. DDD_InterrogationResponse was not retail's format: FIXED

* Root cause: `buildDDDInterrogationResponse` wrote each list as tag `(0, id)`
  plus `[N, -(N+1)]`. Retail tags each list with the DAT header's 64-bit
  `(DataSubset, DataSet)` (`CAllIterationList::AddIterationList(unsigned
  __int64)` @ 006780a0): portal (0,1), cell (1,2), local (1,3). The body is
  the raw iteration record from file 0xFFFF0001, `[N, -N, 1]` (12 bytes,
  confirmed byte-for-byte from all three EoL DATs). GDLE (Client.cpp
  `case 0xF7E6`) switches on both tag words, `memcmp`s a fixed 12 bytes
  against its own iteration file (`TurbineData::CompareIteration`), and on
  mismatch sends `STR_LOGIN_CLIENT_VERSION` and drops the session. ACE reads
  the id word only and accepts both encodings; with retail's, its
  `|-N| == total` shortcut recognises the client as up to date.
* Fix: `packages/network/src/MessageSerializer.ts`. **This is one of
  acjs-1f's files; the change is in the worktree only.**

### 4. AutonomousPosition carried zero physics stamps: FIXED

* Root cause: `MovementSync`'s instance / server-control / teleport /
  force-position sequences started at 0 and were only updated by a self
  UpdatePosition, which a fresh login may never get. GDLE
  (ClientEvents.cpp `MOVEMENT_AUTONOMOUS_POSITION`) drops a position whose
  instance stamp differs from the player's (`Bad instance.`) or whose
  teleport / force-position stamp is older, so the server never learned where
  we walked. Retail copies them from the PhysicsDesc of our own CreateObject
  (`CPhysicsObj::set_description`). ACE reads these stamps and ignores them.
* Fix: `MovementSync.adoptPhysicsTimestamps(timestamps)`, called from the
  self-CreateObject branch of `packages/renderer/src/main.ts` (**main.ts is
  acjs-1f's file; worktree only**).

### 5. Fragment gate waited for sequences GDLE never sends: FIXED

* Root cause: `OrderedFragmentBuffer` (a port of ACE's server-side gate)
  expects a session's first fragment to be 0. GDLE pre-increments
  (`dwFragSequence = ++m_out.fragment_counter`), and its first fragment is 2.
  The gate held the character list until the 2 s stall timeout skipped
  ahead (`[AC:FRAG] Fragment sequence(s) 0..1 lost`) on every login. Retail
  has no such gate (`PacketController::AddReceivedBlobToQueue` @ 00541490).
* Fix: `OrderedFragmentBuffer.adoptFirstSequence()`, fed by
  `ClientConnection` with the lowest fragment sequence of the session's first
  fragment-bearing packet. It applies only when that is 2 or more. ACE's
  first packet always starts at 0, and a first packet starting at 1 keeps the
  existing "swapped first pair" reorder behaviour.

### 6. SetTurbineChatChannels arrives as a top-level 0x0295 message: FIXED 2026-10-06

GDLE sends it with `SendNetMessage(..., PRIVATE_MSG, FALSE, FALSE)`, which
is not wrapped in 0xF7B0 the way ACE sends it, so we log
`[ServerMsg] Unhandled direct: 0x295`. Its channel ids (allegiance 1 …
society 10) are the same fixed values our client already uses, so nothing
breaks. A one-line direct-opcode route in ServerMessageHandler (acjs-1f's
file) would silence it.

### 7. Smaller observations

* GDLE build banner says "Debug 32-bit"; that is its string, not our build.
* PropertyInt 125 (Age) arrives as a large negative number on a level-1
  character (GDLE content); our client logs it without harm.
* Outgoing packets stayed under GDLE's 484-byte inbound cap for the whole
  session (no truncation seen); keep them at 484 B or less.
* The bridge needed no change: its ConnectResponse to port+1, its source
  filter, and its Disconnect on close all work with GDLE.

### 8. Notes from the GDLE source (from the first pass)

* **Ports:** GDLE binds `port` (read) and `port+1` (write) and reads from
  both (Network.cpp Init and IncomingThreadProc). It sends everything from
  the base port. The bridge's ConnectResponse→port+1 routing and its source
  filter both work as-is.
* **Inbound datagram cap 0x1E4 (484 B)** (`QueueIncomingOnSocket` buffer).
  Larger datagrams are truncated and fail the size check. Our fragment
  packets max out at 20 + 464 = 484 B (`MAX_PACKET_FRAGMENT_BYTES` =
  MAX_SERVER_PACKET_SIZE), so they fit. The 1024-B `MAX_CLIENT_PACKET_SIZE`
  is ACE-only headroom we never use. **Keep outgoing packets at 484 B or
  less**, or GDLE silently drops them.
* **Client version must be "1802"**. Auth types 1 (`account:password` in one
  string) and 2 (separate account and password) are both accepted
  (`AuthenticateUserQuery`; anything else gets `STR_LOGIN_INVALID_AUTH`). We
  send "1802" with type 2, and that is what logged in live.
* **Address check is IP-only** (`CClient::CheckAddress`), so the bridge's
  per-session UDP source port does not matter.
* **Re-login while the old session is alive is silently ignored**
  (`AcceptClientLogin`: an existing client for the account returns with no
  reply unless the source port is 9000). The client's LoginRequest retry and
  timeout loop covers it, but quick logout/relogin can stall until GDLE
  drops the old slot. The bridge sends Disconnect on WS close, and GDLE honors
  it: verified live, relogin took 3 to 10 s every time.
* Packed-word password length: we write one byte, which is correct up to 127
  chars. GDLE's limit is 64.

## Open items

Resolved 2026-10-06 (RELEASE.gdle-npc-use-teleport, -30s-idle-drop, -turbine-chat-0x295):

1. **NPC use teleported the player to their own cell: FIXED.** The UseDone(0)
   was the use being *cancelled*: `Movement_Teleport` → `OnTeleported` →
   `UseManager::Cancel()` (WeenieObject.cpp ~6996-7017), then EnterPortal
   sends 0xF751. The teleport was WorldLandBlock's "no cell" repair
   (WorldLandBlock.cpp ~953-962, to `m_LastValidPosition`). The player lost its
   cell because our client walked the server's MoveTo straight along its
   heading *after* the collided movement step, through walls, and reported
   AutonomousPositions outside every EnvCell; GDLE's `AdjustPosition`
   (PhysicsObj.cpp ~2756) found no cell and `GotoLostCell` nulled it. ACE does
   no such containment check. Fix: `OutdoorMovement.stepMoveToMotion` runs
   the walk through the collided step (retail `CPhysicsObj::UpdateObjectInternal`
   @ 005156b0). Live: from the start room the walk now stops at the wall (retail
   has no pathfinding either); next to the NPCs the Shopkeep opens its vendor
   and the Crier speaks.
2. **30 s idle drop at world entry: FIXED.** GDLE only refreshes
   `lastactivity` for an in-order sequenced packet (PacketController.cpp
   `ThinkInbound`), so our cleartext ACKs never kept the session alive, and a
   busy page sent nothing. The client now sends retail's ~3 s sequenced
   TimeSync + EchoRequest (ClientFlowQueue::IncrementLocalInterval @ 00547f10)
   and runs the connection in a Web Worker. Live: entries with 46 s and 73 s
   main-thread stalls (headless SwiftShader) stayed connected.
3. **Top-level 0x0295: FIXED** (routed to the SetTurbineChatChannels parser).
4. **"Invalid login" on every login after the first since a GDLE restart: FIXED.**
   GDLE builds the type-2 password from the bare `char*`
   (Network.cpp `AuthenticateUserQuery`: `m_password = login_credentials`), so it
   reads to the first NUL. When the String32L (4-byte count + packed length +
   chars) ended on a 4-byte boundary (a 7-character password) there was no
   padding, and GDLE read its reused receive buffer's leftovers. The
   LoginRequest now always pads the password with at least one zero byte.
   Retail logs in with auth type 1 and never takes this path.

Resolved 2026-10-09 (RELEASE.gdle-untested-surfaces, native GDLE, headless SwiftShader):

5. **Melee combat: OK.** Training Dagger against an Academy Carpenter Wasp:
   hits, evades, the dagger's Bleeding Assault proc, "You killed Carpenter
   Wasp!" (`/teleloc 0x870301AB 1 -56 0.01`).
6. **Vendor buy: FIXED.** GDLE's `CContainerWeenie::SpawnInContainer` sends
   ServerSaysContainId (0x0022) for the new item, then its CreateObject with
   no container (and a Position), a PickupEvent, then the Container
   PublicUpdateInstanceID. ACE sends the CreateObject first. Our client
   routed the item to the world, so the pyreals left and nothing appeared.
   Retail's 0x0022 case lists a still-unknown item in the known container
   (`ACCWeenieObject::ServerSaysContainID` @ 0058be40); ours now does the same
   (`PendingContainIds`, objectSubjectRouting.ts). Affects every GDLE spawn
   into a pack (quest rewards too). Live: Grapes bought from Fispur land in
   the pack.
7. **Vendor sell: OK** (Grapes sold for 6 pyreals; GDLE refused the starter
   Bread, which it marks unsellable). Each sale also prints "Unable to move
   to object!" (InventoryServerSaveFailed 37 for the sold item): filed as
   RELEASE.gdle-sell-unable-to-move.
8. **Spellcasting: FIXED.** GDLE sends PlayerDesc bool 68
   SpellComponentsRequired = true (ACE never does), so our retail component
   pre-check runs there. It walked the full formula even for a caster with
   the school's foci, so an Item-magic character with Foci of Artifice and
   Prismatic Tapers was refused every cast. Retail's check walks
   `GetAppropriateSpellFormula` @ 00567d50, the scarab-only formula (scarabs
   plus Prismatic Tapers, `InqScarabOnlyFormula` @ 00597050) when the foci is
   owned or the school's Infused augmentation is set. Ported
   (`appropriateSpellFormula`, SpellComponentCheck.ts; the school → foci map
   is DidMapper 0x27000003 via master 0x25000005 [4]). Live: Aura of Blood
   Drinker Self I casts and spends mana.
9. **A fresh GDLE character shows 0 pyreals** until its first transaction:
   GDLE sends no CoinValue (int 20) until `RecalculateCoinAmount` runs.
   Server behaviour; filed as RELEASE.gdle-new-character-coinvalue to check
   what retail displays from.

Still open:

10. Untested on GDLE: trade, fellowship (both need two clients), portals out
    of the academy (the agent's approach did not reach the courtyard portal
    from the practice area), death. Filed as RELEASE.gdle-untested-surfaces.a.
11. A local GDLE (`tools/gdle/`) left running for hours is fine now; the
    "Invalid login" seen earlier was item 4, not the server.

## Public servers (2026-10-04 probe)

From `acresources/serverslist` Servers.xml plus `servers.treestats.net/api/servers/`:

| Server | Emu | Address | Dats | Online | Account creation |
|---|---|---|---|---|---|
| Reefcull | GDL | reefcull.gdleac.com:9000 | EoL ("mimic end of game retail") | yes | **web form only** (http://reefcull.gdleac.com/: email + reCAPTCHA; "do not use capital letters"). First-login auto-create is OFF. |
| Harvestbud | GDLE | harvestbud.gdleac.com:9010 | EoL | yes | **web form only** (same form, 3-account limit) |
| FunkyTown 2.0 / PK / TEST | GDL | funkytownac.com:9050/9059/9055 | EoL + custom | **no** (last seen 2026-09-04; raw UDP probe got no reply) | n/a |
| GDLE Test | GDL | test.gdleac.com:9020 | EoL | no (last seen 2025-02) | n/a |
| Seedsow / Snowreap | GDL | serafino.ddns.net | classic DM dats | yes | excluded (Tier 3) |

How we know auto-create is off on Reefcull: a correctly formed LoginRequest for
a fresh account (`acjsprobe5679`) comes back as `BT_NETERROR` (flags
0x00100000) with `STR_LOGIN_FAILED` (0x04DF9C54) in table 8 (ST_SERVER_ERRORS).
That is the same reply the `acservertracker` probe account gets. With
`auto_create_accounts=1`, GDLE would have created the account and answered
with ConnectRequest. The probe tool is a ~40-line Python sender kept only in
the session scratchpad; it is not needed to reproduce any of this.

**Result: no public vanilla-EoL GDLE server allows first-login account
creation, so the end-to-end flow could not be run.** Web registration (email
plus reCAPTCHA) was outside what was approved. Rerunning this needs one of:
1. Jake registers an account on Reefcull at http://reefcull.gdleac.com/ (all
   lowercase username and password) and hands over the credentials, or
2. a local GDLE server (done: see "Local server" above).

Note: gdleac.com's install guide also has players replace `acclient.exe`,
`client_cell_1.dat` and `client_portal.dat` with GDLE-supplied copies. Their
servers may expect modified dats (extra content). Our iteration-pinned EoL
DATs could be missing some objects and cells. Check this on the first real
session.

