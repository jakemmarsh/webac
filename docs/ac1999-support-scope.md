# AC1999 (Nov 1999 retail) support: scope

**Status:** scope only, 2026-10-06. Nothing here is built yet. This is roadmap tier 3b (`roadmap-era-variants.md` §2.5). It replaces the §2.5 estimate, because reading the code turned up work that section missed (§9).

**What it is for:** an option for players. Someone who wants the 1999 world can pick an AC1999 server in the launcher and play it. Players on end-of-retail and on the Dark Majesty classic servers must see no change: no new prompts, no new downloads, the same bytes on the wire and the same pixels on screen.

**What Phase 0 changed (2026-10-06)** — five lessons from running the real client, folded into the phases below:
1. **The KB is a guide, not a spec.** One live session contradicted it three times: DAT iterations, 0xF7B0 messages it says 1999 lacks, and the client's data flags/leading dword/queue groups. Real captures come first, the AGPL server's code second, the KB third (Phase 4).
2. **Building the capture corpus is partly manual.** Login, chargen, movement and logout script fine. Chat ignores injected keys, and inventory, combat and magic are hard to script. M4–M6 each need a short capture played by hand (Phase 4).
3. **Reliability is the open protocol question.** The real client never sees an ack it accepts and resends everything forever, and the server just tolerates the duplicates. We resend only on the server's NAKs. Nothing exercises those today, so Phase 3 gets a loss test.
4. **Real-client A/B is fragile.** The client crashes at startup about 50% of the time, minimises on focus loss and its 3D view never recovers. A/B runs only on an idle machine, with verified clicks and retries (Phase 7).
5. **"Parses" isn't "means the same".** 20 of 31 DAT types consume every byte, but SoundTable's enum is shifted. Phase 2 checks meaning per type, not just bytes.

**Decision (Jake, 2026-10-06): the UI comes last.** At first the 1999 world plays under our end-of-retail interface. A faithful 1999 interface is the final phase (§8), because it is most of the cost.

Sources:
- **AC1999:** gitlab.com/adamplumb/ac1999 @ 13ff8cc6 (2026-10-05). It is cited as `kb/...` (its `knowledge/kb/`) and `Server/...` (its server source).
- **Licensing:**
  - `Server/` is **AGPL-3.0**, inherited from GDLE/ClassicDereth, the same license we ship under. We may run it and read it.
  - The KB, DatInspector, the Python proof of concept and the launcher have **no license**. We use them as a spec only and copy nothing from them.
- **Our code:** citations are file:line as of f0704a4b.

---

## 1. What AC1999 is, in the terms of this project

| | End of retail / Dark Majesty (today) | AC1999 release |
|---|---|---|
| Client it was built for | Jan 2017 `acclient.exe` | Nov 1999 `client.exe`, version `"4.35752"` |
| Server | ACE, GDLE, ClassicACE, GDL-Classic | a Seedsow/GDLE fork (`Server/`), `server_mode=release` |
| UDP ports | 2 (port, port+1) | **1** (default 9110) |
| Packet header | 20 bytes: seq, flags, checksum, u16 id, u16 time, size, iteration | 20 bytes: seq, flags, **u32 recipient, checksum**, size, **u8 time, u8 table** (`kb/structures/PacketHeader/README.md` L25-37) |
| Handshake | ConnectRequest 0x40000 / Response 0x80000 | grant **0x202** carrying the version string, client ack 0x202, ServerSwitch 0x102 (`kb/networking/connection-handshake.md`) |
| Application data | flags 0x4 | **0x802** (Referral). Client NAKs on 0xA; there are no real ACKs |
| Message framing | game events wrapped in 0xF7B0 | **flat**: no 0xF7B0 wrapper, events are top-level opcodes. Client actions still go in 0xF7B1 |
| Layouts | ACE / EoL | different for most core messages (ObjectCreate field order, u16 DIDs, u16 wcid/icon, PlayerDescription, property updates 0x0E–0x57, chat 0x37) |
| DAT patching | DDD 0xF7E5/0xF7E6 | **0xF7B8 / 0xF7B7**: the server pushes zlib'd files and the client **writes them into its DATs** |
| DATs | ToD container, 4 files (portal, cell, local, highres) | pre-ToD container (header at 0x12C, 12-byte directory entries, iteration in the header), **2 files** (portal ~100 MB, cell), header iterations 102/67 on the retail CD (measured; the KB's 1625/1294 is not what our CD carries) |
| UI data | LayoutDesc, StringTables, fonts, KeyMaps in the DATs | **none**: the panels, fonts and keymap live in the exe and the OS |
| Public server | Servers.xml | `ac1999.cobradragon.com:9110` (`Launcher/launcher.h` L22-23). **Not in Servers.xml** (checked 2026-10-06) |

The beta2, beta0 and preview2 clients are further dialects: a 24-byte header, no checksum, other DAT layouts. **The scope is release only.** Each beta becomes its own profile later, built on the same seams.

---

## 2. Design principles: how this avoids regressing anyone

1. **Separate implementations, not generalised ones.** The 1999 transport is a new class beside `ClientConnection`, not a set of switches inside it. `ClientConnection` (1768 lines, `packages/network/src/ClientConnection.ts`) writes the EoL header inline in three places and keys on EoL flag values throughout. Making it generic would put every end-of-retail session at risk for the sake of 1999. Shared pieces are reused only where their semantics really match: `ISAAC`, `FragmentAssembler`, `LinkStatusAverages` and the `NetConnection` event contract.
2. **A wire adapter at the edge, so the game code stays the same** (§5). The 1999 connection turns 1999 messages into the end-of-retail messages our handlers already parse. It turns our outbound end-of-retail actions into 1999 ones. `ServerMessageHandler` (3457 lines, 151 typed callbacks), the 85 inline payload writers in `main.ts` and every panel stay untouched. All 1999 knowledge lives in one directory, `packages/network/src/era1999/`.
3. **The profile picks, and the default is end of retail.**
   - `EraProfile` gets `protocol: 'eor' | 'ac1999'` and the DAT-layout fields of §4. A missing field means end of retail.
   - Remembered launcher logins, sessionStorage era switches and older bridges all keep working.
   - Older clients already refuse an era id they don't know (`launcher/worldDirectory.ts:163-164`), so a new `ac1999` row fails safe.
4. **Seam refactors land first and must not change behaviour.** Each one ships alone, proven by the guards in §7 (byte-identical wire tests, the session replay corpus, screen regression), before any 1999 code depends on it.
5. **The repo rules still hold:**
   - DAT and decomp data, not guesses.
   - Behavioural tests only.
   - Protocol layouts stay in `@ac/network`.
   - Nothing keyed on iteration numbers or `hasThroneOfDestiny`.

   The one rule this relaxes is roadmap §5's "a profile carries values, never message layouts": a 1999 profile chooses a whole protocol. It does that by naming an implementation, not by holding layouts.

---

## 3. Architecture

```
Launcher row (era: ac1999-retail)
  │  ENTER → era switch + reload (existing EraBoot flow)
  ▼
Boot (EraBoot.planEraDats)
  ├─ UI portal  = EoL client_portal.dat (+ local, highres)   ← UI art, fonts, layouts, mappers
  └─ World portal + cell = 1999 portal.dat / cell.dat         ← terrain, models, tables
       └─ + server patch overlay (0xF7B7 files, OPFS per server)
  ▼
createNetConnection(profile)  ── protocol 'eor'    → ClientConnection (unchanged)
                              └─ protocol 'ac1999' → Connection1999
                                    ├─ Transport1999 (header, grant, 0x802/0xA, ISAAC seed-0 checksum)
                                    ├─ DddSink1999   (0xF7B8/0xF7B7 → patch overlay)
                                    └─ Adapter1999   (1999 msgs ⇄ EoL msgs)
  ▼                                        │ emits the same ConnectionEvents as ClientConnection
ServerMessageHandler / main.ts / GameUI — unchanged
  ▼
Bridge: wss://…/connect?server=<id>  — session protocol from the server row's era
        (or ?proto=ac1999 for Custom…) → single-port relay, 1999 disconnect
```

---

## 4. Work, phase by phase

Each phase ends with an **exit check** and a **regression guard**. Estimates assume one engineer-equivalent of the usual loop.

### Phase 0: local stack and ground truth (~1 week) — **built 2026-10-06; see [ac1999-support.md](ac1999-support.md)**
Everything after this is checked against it.

- **The 1999 DATs.** Install the retail client from the accpp.net ISO under Wine. AC1999's README-macOS covers Apple Silicon. Copy `portal.dat` / `cell.dat` into `dat-sets/ac1999-retail/` (gitignored). Record their hashes, iterations and sizes in `docs/ac1999-support.md`.
  - **Open:** whether the ISO holds the DATs loose or inside installer cabinets. This decides the player import story (§4 Phase 6).
- **The server.** Add `tools/ac1999/start-ac1999.sh`, alongside `tools/gdl-classic/` and `tools/classicace/`:
  - MariaDB 11.4 container `ac1999-db`;
  - the server built by our `tools/ac1999/Dockerfile` (Debian; upstream's Alpine one no longer compiles), as container `acjs-ac1999-server`, on **UDP 9310**, clear of ACE (9000s), ClassicACE (9200s) and GDL-Classic (9210s);
  - the world from `Server/Database/AC1999-World` via its `import_sql.py --fresh`;
  - `auto_create_accounts=1`;
  - the source in `reference/ac1999/` (gitignored).
- **The reference client.** Add `tools/ac1999/launch-ac1999-client-mac.sh`, modelled on `launch-retail-client-mac.sh`, running the real 1999 client against the local server. This is the A side of every comparison, as retail is for end of retail.
- **A capture corpus.** Record one scripted real-client session (`tools/ac1999/capture-ac1999-session.sh`: login → create → enter → walk → turn → jump → logout) through `tools/retail-client-udp-relay.mjs` into `tests/fixtures/ac1999-session-001.jsonl.gz`. It holds both directions, unlike `CaptureCodec`'s inbound-only `.bin`, because the adapter needs client→server golden bytes too. This is the 1999 counterpart of `ac-session-001.bin` and feeds the replay test in Phase 3.
- **Exit check:** the real 1999 client plays on the local server, the corpus is captured, and the DAT facts are recorded.
- **Regression guard:** none needed; only new tools and gitignored data.

### Phase 1: seam refactors that change nothing for current players (~1–1.5 weeks)
Each item ships on its own, before any 1999 code exists.

1. **A connection factory.**
   - Add `createConnection(url, profile)` in `@ac/network`.
   - Use it at the two places that construct the connection today: `NetWorker.ts:88` (the worker, which is the default path) and `main.ts:7980` (in-thread, `?networker=0`).
   - Add `protocol?: 'eor' | 'ac1999'` to `LoginProfile` (`LoginProfile.ts:20-25`); it already crosses the worker boundary unchanged.
   - With no protocol it builds `ClientConnection` exactly as today.
2. **Typed hand-offs where raw end-of-retail bytes cross the network boundary.** The adapter could emit end-of-retail bytes for these anyway, but typing them closes the paths that read bytes at fixed offsets and removes double parsing:
   - `ObjectCreate` is parsed twice: once at `ClientConnection.ts:1560` and again at `ServerMessageHandler.ts:1053`. Keep one parse.
   - `dat/streaming/ArrivalEvents.ts:50-54` reads UpdatePosition at fixed end-of-retail offsets. Read it from the typed handler event instead.

   `PlayerDescription`, `PlayerCreate`, `MovementEvent` and `characterList` may stay as raw end-of-retail bytes, because the adapter produces end-of-retail bytes (§5).
3. **Split UI reads from world reads in the portal.** This is the largest refactor. `portalDb`, `TextureManager`, `SoundPlayer` and `GameUI` each read UI art and world data from **one** portal. 1999 and end of retail share the same id spaces (0x06…, 0x0E…, 0x20…) but hold different files behind them. A fallback chain ("try 1999, then EoL") would **silently draw the wrong art**, so every read must name its source. The fix introduces `uiPortal` and `worldPortal`; for end of retail and Dark Majesty both are the same `DatDatabase`, so behaviour is identical.

   | Subsystem | Source |
   |---|---|
   | Layouts, fonts (0x40), StringTables, MasterProperty, enum and did mappers (icons, cursors, chat fonts, VTI, paperdoll hit-test, color wheel, chargen view animation), UI sound table 0x2000004B, splash | **ui** |
   | Terrain, RegionDesc, GfxObj, Setup, Surface, EnvCell/Environment, motion and physics scripts, emitters, CharGen, SkillTable, SpellTable, SpellComponentTable, XpTable, SecondaryAttributeTable, ChatPoseTable, object and ambient sounds, item and spell icon **DIDs from the server** | **world** |
   | Item and spell icon composites | world icon on ui underlay, backdrop and overlays |

   - Concretely: `TextureManager` becomes two instances (UI textures through `UITextureLoader`). `SoundPlayer` gets a UI table source. `GameUI`'s constructor (`GameUI.ts:2740-2757`) takes both portals. `PortalSpaceRenderer` and the chargen view animation take a world portal plus explicit UI fallbacks.
   - Line-level inventory: `ac1999-support-scope.md` §A (below).
   - **Regression guard for the split:** a unit harness that hands `GameUI`/`main` wiring two *distinct* stub DBs and asserts that a fixed list of UI ids is only ever read from `ui` and world ids from `world`. Plus a full screen-regression run (`tools/screen-regression.ts`), which must be pixel-identical within the noise floors.
4. **Turn source-text tests into behaviour tests where the refactors touch them.** 11 tests read `ServerMessageHandler.ts` as text and 32 read `ClientConnection.ts`/`MessageSerializer.ts`. Convert the ones the refactors trip on (repo rule).

- **Exit check:** suite plus `tools/ci-local.sh` green. Screen regression shows no change. Live end of retail (ACE), ClassicACE CustomDM and GDL-Classic each pass login → enter → move → chat → inventory via `tools/probe-era-switch.ts` / `tools/gdle/probe-flow.ts`.

### Phase 2: pre-ToD DATs (~2–3 weeks)
1. **Container mode in `DatDatabase`:**
   - Detect `0x5442` at 0x140 **first** (ToD), and only then at 0x12C (pre-ToD), so a ToD file can never be misread.
   - Pre-ToD reads a header with `Iteration` at +0x0C (file 0x138) and 12-byte entries `(id, offset, size)` in 984-byte nodes; `dataSet`/`subset`/`date` are 0.
   - `totalIterations` comes from the header, not the 0xFFFF0001 record. Today a missing record returns 0 and calls `console.error` (`DatDatabase.ts:199-207`).
   - Port from our own prototype `tools/era-dat-sweep.ts:80-128` (`OldDat`). Its `& 0x7fffffff` next-pointer mask and throw-on-short-chain stay **pre-ToD only** (KB: free blocks set bit 31).
   - The same branch goes into `EraImport.identifyDat` (`EraImport.ts:39-71`) and `roleForHeader` (`EraProfiles.ts:155-160`): pre-ToD has no DataSet, so role comes from BlockSize (0x400 portal, 0x100 cell). Accept the file names `portal.dat`/`cell.dat`.
   - `RangedDat` stays ToD only; the splash always reads the end-of-retail portal.
2. **Format variants as normalising adapters.** Parse the 1999 bytes into the **same in-memory shapes** our renderer already uses, so `ModelRenderer`, `TextureManager` and `EnvCellRenderer` need no era branches. They hang off a `db.format` set by the container mode and are selected at the parser entry points: `new GfxObj`, `SurfaceTexture.read`, `Texture.read`, `Surface.read`, `new Environment`/`EnvCell`, `RegionDesc`, `SpellTable`, `XpTable`, `CharacterGenerator`.

   | Type | 1999 difference | Adapter |
   |---|---|---|
   | GfxObj 0x01 | plain counts plus align4 after each polygon and BSP leaf (`kb/dat/PortalDat/GfxObj`) | read variant, same `GfxObj` shape |
   | SurfaceTexture 0x05 | **is the image** (`id, format 1–11, w, h, pixels[, paletteDID]`) | synthesize a one-level SurfaceTexture plus Texture pair, so `TextureManager.ts:115-138` stays unchanged |
   | Texture 0x06 / Surface 0x08 | not paged in the KB; per roadmap §3.2, 0x06 is raw 24-bit with no format field and Surface has a leading id | derive from the bytes in Phase 0's DATs |
   | Environment 0x0D, EnvCell | release layout paged; EoL prefixes the id and drops the align4s | read variants |
   | Region 0x13 | 2 files; terrain slots 0x15–0x1F used | read variant; check the id against 0x13000000 |
   | XpTable | u32, cap 126 | widen to the same shape |
   | SpellTable | name and description nibble-swapped, formula obfuscated, no EoL trailing fields, no SpellSets | read variant plus de-obfuscation, derived from the bytes and the KB algorithm description (no code copied) |
   | SpellComponentTable | 74 components; **no DualDidMapper 0x27000002** | read as is; the WCID map is empty for 1999 |
   | SoundTable 0x20 | SoundType enum shifted (EoL 0x8B–0x97 = 1999 0x76–0x82) | map at the call site |
   | CharGen 0x0E000002 | 1999 layout (3 heritages, 18 starter positions) | read variant into the same `CharacterGenerator` shape |

   Everything else parses clean on the 1999 set (measured 2026-10-06, `ac1999-support.md`): Animation, BadData, ChatPoseTable, Clothing, CombatTable, DegradeInfo, MotionTable, Palette, PaletteSet, ParticleEmitter, PhysicsScript, PhysicsScriptTable, Scene, SecondaryAttributeTable, Setup, SkillTable, SoundTable, SpellComponentTable, Wave, CellLandblock, LandblockInfo.

   **Byte-clean is not meaning-clean.** SoundTable parses but its SoundType enum is shifted. For each "clean" type, check the enum and id fields we *interpret* (sound types, motion commands, skill ids, combat maneuvers, physics-script hooks) against the 1999 KB pages and the server's readers. Record each verdict in `ac1999-support.md`.
3. **The server's patch overlay.** The AC1999 server pushes its curated content changes as 0xF7B7 files at login, and the client writes them into its DATs. Their recent commits restore landmarks this way. We keep an **overlay**: `fileId → bytes`, persisted in OPFS per server (key `ac1999-patch__<serverId>`), and consulted before the base DAT by a thin `PatchedDat` wrapper. The base files stay untouched, so a second 1999 server doesn't inherit the first one's patches. dbType 0–2 go to the cell; 3–0x2E go to the portal.
4. **Era profile entries.**
   - `ac1999-retail: { own: { worldPortal: 'portal.dat', cell: 'cell.dat' }, uiFrom: 'eor', protocol: 'ac1999', login: { clientVersion: '4.35752', … } }`.
   - `DatRole` gains `worldPortal`. For this era `planEraDats` loads the **end-of-retail** portal, local and highres for the UI and **skips the end-of-retail cell** (~223 MB). Whole DATs only, as classic eras already do (`main.ts:1046`). Memory cost: about +100 MB over end of retail. **Superseded 2026-10-06:** the interface streams end of retail's set and the world streams its own world-only set (or loads whole without one); [dat-streaming.md §6.11](dat-streaming.md).
   - Cache namespace `ac1999-retail__`.
- **Exit check:**
  - `tools/era-dat-sweep.ts --set ac1999-retail` parses **every** portal and cell file with 0 leftover bytes.
  - Unit tests run the real parsers over the real 1999 files: `describe.skipIf` with no `dat-sets/`, loads in `beforeAll`.
  - With `?era=ac1999-retail`, no server, and a debug landblock view, Holtburg terrain, buildings and a dungeon EnvCell render. Compare a screenshot against the real 1999 client at the same spot.
- **Regression guard:** `verify-dat-file-bytes.ts`, `verify-dat-parser-fidelity-*`, `verify-era-profiles.ts` and `verify-dat-cache.ts` unchanged and green (end-of-retail cache keys with no namespace stay bare filenames). Every ToD parser test still passes.

### Phase 3: transport (~1.5–2 weeks)
`packages/network/src/era1999/Transport1999.ts` + `Connection1999.ts`, implementing `NetConnection` and emitting the same `ConnectionEvent`s.

- **Header:** a 20-byte release layout; `table` must be 0.
- **Checksum:**
  - placeholder `0x3291975`;
  - header hash includes the size;
  - control packets: header + payload hash;
  - data packets: **header + (payload ^ isaac)**;
  - server→client ISAAC is seeded 0; seq 1 has no XOR, seq N uses `rand[N-2]`.
  - Verify inbound checksums (we don't today), with the server's measured `isaac(2)=0x182600f3` and `isaac(3)=0x300b4a8d` as test vectors. Trust the server code over the KB prose where they disagree (`kb/.../04-checksum.md` says XOR).
- **Login:** `0x075BCD15`, a u16 version length that includes the NUL, align4 against the stream, `0xBEEFBEEF`, `char[20] "user:password"`, … then the portal and cell iterations: whatever the loaded DATs' headers say (102/67 for the retail CD, confirmed in a live login).
  - The server requires exact version equality, and the grant's version must `strtod`-equal ours.
  - The 20-byte credential field holds the first 20 characters of `user:password`, with no terminator at 20 or more; the retail client truncates longer input silently (measured 2026-10-12, client.exe 4.35752 under Wine: `lenprobeab:pwprobe123` stored the password `pwprobe12`). Truncate the same way; never refuse, since accounts made by the retail client already hold the truncated password. (This line used to say "refuse longer input"; that refusal locked out a player, 2026-10-12.)
- **Handshake:**
  - send LoginRequest (seq 1, flags 0x2);
  - receive the grant 0x202 `{f64 0, f64 worldClockDelta, u32 adoptRecid, version, seeds 0,0}`;
  - reply 0x202;
  - receive ServerSwitch 0x102 and reply 0x102. Its payload's first 8 bytes must be treated as a zero time sync; never let it move the world clock.
- **Data:**
  - inbound application data is **only** on 0x802;
  - the first data fragment (seq 1) is sacrificial: count it, drop its content;
  - outbound data goes as 0x22 with a leading flow dword;
  - fragment stride 444 bytes C→S, queue groups 3/4/7;
  - datagrams of 484 bytes or less.
- **Reliability:**
  - NAK holes with 0xA `[flow][count ≤ 0x71][seqs]` on a ≥0.25 s timer;
  - always follow a burst (tail-loss rule);
  - no ACKs exist;
  - accept resends without 0x1.
  - **Don't copy the real client's resend storm.** It resends every sequenced packet without end (LoginComplete ×872 in one session), because it never sees an ack it accepts. We send once and resend only what the server's 0xA lists name.
  - **Prove the server's NAKs work.** Nothing exercises them today, since the real client brute-forces past loss. Add a drop mode to `tools/retail-client-udp-relay.mjs` (drop every Nth c2s datagram, or a burst) and check that our session survives on NAK-driven resends alone. If it doesn't, fall back to timed resends of unacknowledged packets and report the gap to AC1999.
- **Client data framing (from the capture):** client→server data goes on `0x802` (`0x803` = retransmit) with a leading u32 before the first fragment, as on `0x22`. Queue groups are **6** (char-select messages) and **5** (0xF7B1 game actions). Mirror that, not the KB.
- **Liveness:**
  - send a heartbeat 0x22 (8-byte body) every 2 s;
  - the server sends 0x202 keepalives every 5 s and drops a session after 60 s;
  - request TimeSync 0x10 only on a gap-free link, about every 60 s, and **never** unsolicited.
- **Disconnect:** 0x8000; logoff is 0xF653.
- **DDD:** 0xF7B8 ×2 then N × 0xF7B7, handled inside the connection: inflate and write to the Phase 2 overlay. Report "Updated!" progress through the existing patch-progress event.
- **The bridge** (`services/ws-tcp-bridge`) is **not** a pure relay today, which contradicts the roadmap. It reads end-of-retail flags to send ConnectResponse to port+1 (`server.ts:433-445`), reads the session id from the ConnectRequest (`bridgeUtil.ts:393-403`), and builds end-of-retail Disconnect packets (`bridgeUtil.ts:423-437`). Changes:
  - Give each session a **protocol**: from the server row's era in multi mode, from `?proto=ac1999` for Custom…, or from `BRIDGE_ERA` when pinned. **The default is end of retail**, so every existing session takes today's code path byte for byte.
  - For 1999 sessions: one port; source filter `[port]`; session id taken from the grant header's recipient (u32 at 0x08); a 1999 Disconnect on close.
- **Era detection.** Don't probe 1999 servers. The server auto-creates accounts, and a probe login with credentials would create one. 1999 rows come from the `serverCompat.ts` overlay (`byId` / host:port), and a synthetic directory row lists `ac1999.cobradragon.com:9110`, because it is not in Servers.xml. The end-of-retail literal sweep keeps skipping them.
- **Exit check:**
  - The replay test feeds the server→client half of `tests/fixtures/ac1999-session-001.jsonl.gz` through `Connection1999` and reaches CharacterList with zero checksum failures.
  - The relay's drop mode costs nothing but time: a session with 5% loss still reaches the world.
  - Live against the local server: login → grant → DDD "Updated!" → character list.
- **Regression guard:**
  - `verify-era-login-profile.ts`, `verify-gdle-compat-wire.ts`, `verify-bridge-login-probe.ts`, `verify-bridge-hosting.ts` (world-port routing), `verify-net-*` and `verify-session-replay-corpus.ts` all unchanged and green.
  - New bridge tests cover both protocols side by side in one bridge.

### Phase 4: the wire adapter, 1999 ⇄ end of retail (~4–6 weeks; the bulk)
`packages/network/src/era1999/Adapter1999.ts`, with one module per message family. **Inbound** it decodes 1999 messages (AcString, PackableHashTable, u16 DIDs) and re-encodes them as the end-of-retail messages our handlers parse. Flat events are wrapped back into 0xF7B0 with a synthetic sequence. **Outbound** it rewrites the end-of-retail GameActions and direct messages we build into 1999 layouts.

The order follows what a player sees first:

| Milestone | Inbound (1999 → EoL) | Outbound (EoL → 1999) |
|---|---|---|
| **M1 Character select** | 0xF658 list (count first; 28-byte tail; `useTurbineChat`=0, `hasThroneOfDestiny`=0) → F658; 0xF65A news → char-select text; 0xF643 create response | 0xF656 CharacterCreate → 1999 CharGenResult: heritage and gender **indices**, 6 doubles for shades, start area 0..17, `requestedAccess` 0. Delete and restore |
| **M2 Entering the world** | 0xF7C7 → synthesize 0xF7DF; 0xF746; 0xF745 (ObjDesc → **PhysicsDesc → PWD** order; u16 DIDs; no translucency; PWD u16 wcid and icon \| 0x06000000; no header2) → EoL F745; 0x000F; 0x196; **0x0013 PlayerDescription** (no Int64 table, 12-byte spellbook entries) → EoL 0xF7B0/0x0013; 0xF625 ObjDesc | 0xF7C8 → 1999 two-phase enter, 0xF657 `{op, guid, FixedBlob28 account}`; LoginComplete 0xA1, also after every teleport |
| **M3 Moving** | 0xF748 MoveEntity (PositionPack with omitted quaternion parts, 4 u16 timestamps) → F748; 0xF74C (u16 commands; the KB omits instance/movement/server-control timestamps and the autonomous byte, see `Server/Source/Animate.cpp` L202-215) → F74C; 0xF74B SetState; teleport; 0xF74A/0xF750/0xF755 | MoveToState 0xF61C (raw u32 commands, no per-axis hold keys, a flags byte on release), AutonomousPosition 0xF753 (12-byte tail), Jump 0xF61B |
| **M4 Talking** | 0x37 HearSpeech (message before name) → 0x02BB; 0x38 tell; 0xF62C server line → F7E0; 0x14A channels | Talk 0x15; Tell. **TurbineChat sends** (`main.ts:13469`, `:13848`) have no 1999 counterpart: route to the 1999 channel opcodes or report "not available" |
| **M5 Stats and properties** | 0x0E/0x0F/0x10/0x11/0x26/0x28/0x29/0x2C/0x2D/0x2E/0x2F/0x43/0x57 (no sequence byte) → the 0x02CD family, with a synthetic sequence; 0x1D1–0x1DE removes | — |
| **M6 Inventory, vendors, combat, magic, fellowship, allegiance** | the KB's confirmed pages first: 0x22, 0x19A, 0x1C, 0x62, 0x1B8, 0x4C/4D/4E, 0x1A6, 0x20, 0x1C8, 0xAF, 0x1CA, 0x1E0/0x1E2… | the matching actions: 0x19, 0x1B, 0x1D–0x1F, 0x36, 0x45, 0x87, 0x19C, 0x1A1, 0xA2, 0xCA appraisal… |

Rules for the adapter:
- **Source order: captures, then the server's code, then the KB.** The KB was wrong three times in one session. Each message's layout is settled from real captured bytes first. The AGPL server's writers and readers (`reference/ac1999/Server/Source`) come second. KB pages are a guide.
- **Decode the corpus before building.** Start Phase 4 with a full decode of every captured message, including the 13 s2c 0xF7B0 messages and the 0x4000/0x1004002 control packets. Write a per-opcode layout table into `ac1999-support.md`, and build from that table.
- **Corpus per milestone.** M1–M3 (chargen, entering the world, movement) are scripted (`capture-ac1999-session.sh`). M4–M6 (chat, inventory and vendors, combat, magic) can't be fully scripted: chat ignores injected keys, and the rest needs targeting and timing. Each gets a short capture played by hand through the relay (`AC1999_CAPTURE=… launch-ac1999-client-mac.sh`, ~10 min each), saved as `tests/fixtures/ac1999-session-00N.jsonl.gz`. Where a hand capture can't cover a message, its layout comes from the server's writer, and the gap is noted.
- **Every message is a pure function** `bytes → bytes`, tested against golden vectors. The vectors come from the captures and, second, from the AGPL server's writers, read only to understand the layout. Then a round trip runs through our real end-of-retail parser. Unknown inbound opcodes are logged once and dropped, never passed on half-parsed.
- **Things 1999 doesn't have.** Some actions have no 1999 counterpart: trade (0x1F6+), housing, consent, chess, TurbineChat, newer allegiance admin. The adapter returns a typed "unsupported on this server" result, and the UI hides those controls for the session (§6). Nothing is sent that would wedge the server.
- **Per-object sequence gates** (instance, movement, server-control, position; signed u16 wraparound) carry over field for field. The first timestamp of 0xF748 equals the instance sequence. These are correctness-critical: the client drops updates that fail them.
- **Lossy spots** are written down per message in `docs/ac1999-support.md`. For example, 1999's u16 wcid fits the end-of-retail field, but 1999 wcids are not end-of-retail wcids, which matters for the weenie side-files (§6).
- **Why an adapter and not a second set of handlers.** A 1999 `ServerMessageHandler` and a second outbound path would touch 151 handler callbacks and 85 inline writers in `main.ts`. Both are shared by every player today. The adapter touches none of it, keeps 1999 code in one place, and is pure-function testable. Its limit: the downstream semantics stay end-of-retail, which is exactly right while the UI is end-of-retail. The 1999 UI (Phase 8) can add typed side channels for anything 1999-specific.

- **Exit check (per milestone):** live on the local server, the matching flow works end to end: create and enter Holtburg, walk, see creatures move, chat, open inventory and the character panel, pick up an item, melee a creature, cast a spell. The replay corpus decodes with zero unknown opcodes in the covered families.
- **Regression guard:** adapter code is reached only through `Connection1999`. The end-of-retail suites from Phase 3 are untouched.

### Phase 5: fitting the interim interface to 1999 data (~1–2 weeks)
These are places where the end-of-retail UI assumes end-of-retail data. Each fix reads the data, so end of retail and Dark Majesty behave as before; the screen-regression run guards that.

- **Chargen heritages.** `renderRaceStep` hardcodes **13 rows** (`GameUI.ts:6567-6586`). Hide rows whose heritage the world's CharGen doesn't define; heritage lookups at `:1231`, `:1236`, `:1256-1260`, `:7134`, `:7605`, `:7961`, `:8664` must tolerate a missing entry. Portraits stay the end-of-retail UI art: `heritageGroups[].iconImage` is a 1999 id, so it must not go through the UI TextureManager.
- **Chargen towns.** `renderMapStep` (`GameUI.ts:8117-8150`) has 4 fixed towns over end-of-retail map art. 1999 has **18 starter positions**. Show a list driven by CharGen in the same layout slot (an interim surface, disclosed as such), and send the index the server expects (0..17).
- **Randomize** is gated on `hasThroneOfDestiny` (`ChargenRandomize.ts:168-182`). Gate it on the CharGen contents instead; this is also a cleanup the roadmap already asks for.
- **The chargen view animation fallback ids** (`ChargenViewAnimation.ts:176-181`) are end-of-retail; the 1999 portal has no DidMapper 0x25000010. Fall back to the world CharGen's own setups and motion tables.
- **Server-sent icon and setup DIDs** always resolve against the world portal. About 30% of end-of-retail content references ids the 1999 DAT doesn't have (KB), so every DID lookup must already fail soft. Audit the throw paths with the replay corpus.
- **Maps.** The world map (0x0600127d) and radar art describe end of retail's Dereth. For 1999, hide the world map panel (no faithful 1999 map art) rather than show the wrong continent. The radar is fine because it draws objects.
- **Weenie side-files** (`main.ts:1166-1206`: combat styles, attack types, weapon speed) are end-of-retail wcid-keyed. Don't load them for 1999; misses already fall back to defaults that only affect animation. The server sends the stats.
- **No dead-end UI** (CLAUDE.md). Controls for features a 1999 server lacks are hidden while connected to one, using the adapter's unsupported list: secure trade, housing, consent, chess, TurbineChat channels, luminance and augmentation, contracts. Retail controls whose target is gone are removed, not reproduced. This is the same rule.
- **Combat table fallbacks** (`main.ts:2519-2521`, `9618`), PE table 0x34000004, the portal vortex and storm setups and scripts, and sound tables 0x2000004B/0x20000001: check each against the 1999 portal. Each id resolves to the world portal if it exists there; otherwise it is a UI effect and resolves to `ui`. **Audited 2026-10-06, nothing to change:** player effects already use the wire PeTable (no hardcoded 0x34000004 lookup); the portal vortex plays the portal object's own Setup DefaultScript and the storm/weather scripts come from the world Region's sky objects (all world portal; 0x020001B3, 0x3300067A, 0x33000453 exist in 1999); the combat table is the server's DID 4 with a 0x30000000 fallback that is the humanoid table in 1999 too; 0x2000004B (UI sounds) and the portal-space tunnel resolve against the UI portal; object sounds use each object's wire sound table.
- **The launcher row** says what you get: the world's name and its era chip, "1999 launch era" (beta), in player terms like the classic worlds' "Dark Majesty era".

### Phase 6: launcher, import, listing (~1 week)
- **Import.** The existing DialogFactory Yes/No → file picker → OPFS flow, with `identifyDat`'s pre-ToD branch. It asks for `portal.dat` and `cell.dat` from a 1999 install, and the prompt text says where they come from. If Phase 0 finds the ISO keeps them in cabinets, the prompt asks for the installed copy (no ISO parsing in the browser).
- **Hosting.** The 1999 `portal.dat`/`cell.dat` are Turbine's unmodified retail files, the same standing as the end-of-retail DATs we already host. They are not AC1999's or any operator's work. That is unlike the classic sets, which are operators' builds and need their OK. So the 1999 pair can go in the hosted sets (`eraAssetBases['ac1999-retail']`) under the same call already made for end of retail, and import stays as the fallback. The server's login patches (0xF7B7) are AC1999's content, delivered by their server, never hosted by us.
- **Listing.** The overlay row for `ac1999.cobradragon.com:9110` gets era `ac1999-retail` and status `beta` until someone plays it end to end. A Custom… server can pick the era from the profile list.
- **Era switch.** Unchanged: stash, reload, auto-login (`EraBoot`).
- **Exit check:** `tools/probe-era-switch.ts --era ac1999-retail --import <dir>` covers import → reload → login → enter world on the local server. Then the same against the public server with one disposable account, after asking the maintainer (it auto-creates accounts).

### Phase 7: proving parity (ongoing from Phase 4)
- **An A/B harness.** Extend `tools/capture-retail-ab.ts` to drive the real 1999 client (Phase 0 launcher) and ours to the same spot, then diff the **world** render: terrain, objects, lighting, fog. The UI is excluded until Phase 8.
  - **The real client is fragile under Wine:** it crashes at startup about 50% of the time, minimises on focus loss, and its 3D view stays black after that. A/B runs only while the machine is idle (the GPU worker's idle gate), never while someone is using it.
  - Every click is verified against a settled region, as `capture-ac1999-session.sh` does, and launches retry.
- **Scorecard.** Add `ac1999.*` rows to `verification/scorecard.json`: login, chargen, enter, move, chat, inventory, combat, magic, plus a world render A/B score.
- **Docs.** `docs/ac1999-support.md` (started in Phase 0) stays the running record: how to run and verify it, gotchas, per-opcode layouts, status.

### Phase 8: the 1999 interface (last; ~2–3 months; scoped separately when we get there)
- **First, find where the 1999 interface art lives.** The real screens use painted art: buttons, scroll frames, the char-select cauldron. If it is in `portal.dat` (~3,000 0x06 images), Phase 8 takes layout from the exe and art from the DAT, and is much cheaper. If it is in the exe or separate files, the estimate stands. This is a quick check, and it decides how Phase 8 is scoped.
- **Ground truth.** The 1999 `client.exe` has no PDB, so it costs more than our end-of-retail decomp did. AC1999's `Client/` Ghidra scripts and named functions (`PanelUI_HandleCommand` @ 0x4f5700, commands up to 0x9000114) are a head start, but are reference only. Add 1999 screenshots and videos for gestalt.
- **The pieces:**
  - a 1999 `UiProfile` implementing the panel surface `GameUI` drives today, built from exe-derived layout tables instead of LayoutDesc;
  - GDI-era fonts rendered to match;
  - the 1999 keymap (`.map` file format, `InputMapper::SaveMap`);
  - 1999 chargen (3 heritages, 18 towns);
  - 1999 char select and portal space.
- **Once it ships, the 1999 era stops loading the end-of-retail portal and local** (−~1 GB to download) unless something still needs them.

---

## 5. Totals

The first estimates were in engineer-weeks at a human pace. Phase 0 was estimated at a week and took one afternoon (2026-10-06), including two dead ends: the Alpine build and the startup crash. Re-estimated at our actual pace, in working days of Claude sessions plus Jake:

| Phase | Estimate | Player-visible result | What really sets the pace |
|---|---|---|---|
| 0 Stack and ground truth | done (½ day) | — | — |
| 1 Seam refactors (no change) | ~2–3 days | — (EoL/DM unchanged, proven) | the UI/world portal split and proving it neutral (screen regression, three live servers) |
| 2 Pre-ToD DATs | ~2–4 days | 1999 world renders offline | 11 format variants; SpellTable de-obfuscation; the meaning checks |
| 3 Transport + bridge | ~2–3 days | reaches the 1999 character list | whether the server's NAKs actually work (the loss test) |
| 4 Adapter M1–M6 | ~5–10 days | playable 1999 world (M2 is the first "in world") | the hand-played captures for M4–M6, and semantic drift |
| 5 Interim interface fit | ~1–2 days | chargen and panels behave on 1999 data | — |
| 6 Launcher/import/listing | ~1 day | players can pick it | — |
| 7 Parity A/B + scorecard | ~1–2 days, then ongoing | — | real-client fragility |
| **To a playable 1999 world under our interface** | **~3–4 weeks of sessions** | | |
| 8 1999 interface | ~2–6 weeks | faithful 1999 | where the 1999 art lives (§4 Phase 8) |

Phases 1 and 2 don't touch each other and can run side by side, and so can 3 and 5. Phase 4 can start on M1 as soon as 3 reaches the character list.

## 6. Risks
- **The UI/world portal split** is the one refactor that touches code every player runs. It is mechanical, and both portals are the same DB for end of retail, but a wrong pick is invisible there. The two-stub-DB harness (Phase 1) is the guard, so build it first.
- **Adapter semantic drift.** Fields that look alike but mean different things (1999 PWD bit 0x200000 means "issuing vendor", not burden; the SoundType enum shift; property ids). Golden vectors from real captures, not from the KB alone.
- **The server's NAK path is untested.** The real client hides any problem by resending everything. If the NAKs don't work, Phase 3 needs timed resends, and AC1999 should hear about it.
- **A moving target.** AC1999 lands about 1,500 commits in 4 months. Its server may change layouts as it fixes the 1999 client. Pin the server commit in `start-ac1999.sh` and re-run the replay corpus when bumping it.
- **The 20-byte credential field** truncates `user:password` silently, as retail did (measured 2026-10-12); don't refuse on length. Auto-created accounts: say so at login. Never probe their server.
- **Memory.** End-of-retail portal (~935 MB) + 1999 portal and cell + local + highres, all whole DATs. Measure in Phase 2 with `measure-perf`. If needed, stream the end-of-retail UI portal through the existing `boot` + `ui` packs (`StreamingDats.ts:177` already computes layout art ids) instead of loading it whole. **Done 2026-10-06** ([dat-streaming.md §6.11](dat-streaming.md)): the interface streams end of retail's set and the world its own set.

## 7. Regression guard (every phase)
- **Wire bytes:** `verify-era-login-profile.ts`, `verify-gdle-compat-wire.ts`, `verify-bridge-login-probe.ts`, `verify-bridge-hosting.ts`, `verify-net-*`, `verify-session-replay-corpus.ts` (`ac-session-001.bin`).
- **DATs/era:** `verify-dat-file-bytes.ts`, `verify-dat-parser-fidelity-*`, `verify-era-profiles.ts`, `verify-dat-cache.ts`, `verify-launcher-*`.
- **Pixels:** `tools/screen-regression.ts` (pre-world, 46 scenes, HUD panels) within the noise floors after Phases 1 and 5.
- **Live:** ACE end of retail, ClassicACE CustomDM, GDL-Classic, each login → enter → move → chat → inventory after every phase that touches shared code (1, 3, 5).
- **The full gate:** `npm test` / `tools/ci-local.sh` before every push, as always.

## 8. Decisions this scope already takes
- Release client only; the betas come later as separate profiles.
- Our interface first, the 1999 interface last (Jake).
- A separate transport class plus an edge adapter, not generalised `ClientConnection`/handlers.
- Never probe 1999 servers; list them through the overlay.
- Server patches go in a per-server overlay; base DATs are never modified.
- Hide the world map and features 1999 lacks, instead of showing end-of-retail content.

## 9. Corrections to `roadmap-era-variants.md` §2.5
- "Bridge: plain UDP, none" is **wrong**. The bridge parses end-of-retail flags for port routing, the session id and Disconnect (Phase 3).
- The 1999 container keeps its iteration **in the header** (+0x0C) instead of a 0xFFFF0001 file. The 2001-CD reading of that word as "unknown" needs re-checking against the 1999 bytes.
- The release portal is ~100 MB / 17,794 files (the KB), not the 2001 CD's 170.9 MB / 30,397.
- AC1999's `Server/` is AGPL-3.0, so we may run it and read it. The rest of the repo is unlicensed: reference only.
- The 1999 server patches the client's DATs at login (0xF7B7), so a client must apply patches. That was not in the old estimate.
- There is a public host, `ac1999.cobradragon.com:9110`, not in Servers.xml.

---

## A. UI/world portal read inventory (for Phase 1.3)

Construction sites of everything that holds "the portal" today:

| Site | Becomes |
|---|---|
| `TextureManager(portalDb, …, highResDb)` `main.ts:1584` | world TM, plus a UI TM behind `UITextureLoader` (`main.ts:1649`) |
| `CursorManager` `main.ts:1593` | ui |
| `MaterialFactory`, `ModelRenderer`, `SetupModelRenderer`, `DegradeLod` `main.ts:1597-1605` | world |
| Font 0x40000000 `main.ts:1624`; `GameUI.ts:3016`, `4582-4585` | ui |
| `LayoutRenderer(langDb, uiTextureLoader, font)` `main.ts:1650` | ui |
| `SoundPlayer(portalDb)` `main.ts:1660` | world, with a UI sound-table source (0x2000004B, `main.ts:3090`; `GameUI.ts:869`; `playPressSounds`) |
| `MotionManager`, `EnvCellRenderer`, `ClothingRenderer`, `AppearanceManager`, `CharacterModelBuilder` `main.ts:1704-1709` | world |
| `serverObjectManager.setPortalDb` `main.ts:8196`; emitters `:8208-8260`; `PaperdollPoser` `GameUI.ts:12307` | world |
| `createExamineResolvers` `main.ts:1388` | ui mappers + world tables |
| `loadVtiImageDids` `main.ts:6432` | ui |
| `PortalSpaceRenderer` `GameUI.ts:5042-5045` (fallback 0x02000306/0x030005ac) | its own SetupModelRenderer on whichever portal holds the ids |
| splash `main.ts:752`, `:1134` | ui (always EoL) |
| `GameUI` `this.portalDb`: CharGen, SkillTable, SpellTable, components `:2963-3008` | world |
| `GameUI` font, icon and spell-icon enum maps (`:3420/3438/3518/3608`), chat fonts `:4561`, color wheel `:7183`, paperdoll hit-test `:15324` | ui |
| `GameUI` chargen animators `:7101/7122`, barber `:19363` | world |
| DAT tables at boot `main.ts:1212-1509` (MasterProperty, StringTables → ui; the 0x0E tables, Region, physics scripts → world) | per the column |
