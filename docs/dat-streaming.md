# DAT streaming: design, measurements and R2 publishing

Status: **implemented (2026-10-04, RELEASE.dat-streaming + RELEASE.portal-space-cell-gate)** — what was built and the live
measurements are §6. The design below is unchanged except where §6 says so. 2026-10-05: char select no longer waits for
the world packs, the resident set is LRU-bounded and the gate's progress drives the power bar's DDD mode (§6.6).
Tools: `tools/dat-access-sim.ts` (offline access measurement), `tools/publish-dats-r2.ts` (repack + upload, dry run by default).
Data: `verification/dat-streaming/access-sim.json` (per-phase numbers), `pack-sets.json` (boot/world pack lists), `publish-dry-run.txt`.

## Headline

| | Today | Streaming (recommended design) |
|---|---|---|
| Bytes before the first char-select frame (new player) | **1.28 GB** (all four DATs, whole) | **~2.4 MB** design; **~6.6 MB** as built (§6.6: manifest + boot + language + skeleton packs) |
| Bytes before in-world at Holtburg (new player, cold) | 1.28 GB | **~35 MB**: 30.6 MB of world packs, mostly fetched while the player sits at char select/chargen, + ~4.4 MB of Holtburg-specific objects |
| Bytes per landblock crossed while walking | 0 (already resident) | 0–0.5 MB, prefetched one ring ahead |
| Everything, if a player downloads it all | 1.28 GB | 564 MB (51,793 gzip objects) |
| DAT bytes held in the renderer | ~1.4 GB of ArrayBuffers | ~91 MB of packs + an LRU of downloaded files capped at 256 MB (§6.6; closes perf "proposal A") |

Gameplay verdict: streaming is safe **if** world entry and teleports are gated on the destination's assets the way retail's
`CellManager` gated them (§2.1). Walking is fully hidden by the existing prefetch ring. The one visible cost is a
first-time-ever 1–2 round-trip delay (~50–250 ms) for an object, animation, sound or icon that was not prefetched. After
that it is cached in OPFS for every later session. Game network traffic is unaffected apart from bursts competing for the
player's last-mile bandwidth, and those bursts happen behind the portal-space screen.

---

## 0. Current state (verified 2026-10-04)

- `packages/renderer/src/main.ts`:
  - `fetchDatFromNetwork` (:749) and `fetchDat` (:760) download each DAT whole into one ArrayBuffer through `loadDatWithCache`.
  - `main()` awaits portal (:883), cell (:915) and language (:919), and highres via `ensureHighResDat` (:806) when the persisted Environment Texture Detail is Very High.
  - It then builds `new DatDatabase(buf)` (:887, :997, :998).
- `packages/renderer/src/dat/DatCache.ts` is an OPFS whole-file cache, revalidated by HEAD (ETag, else size + Last-Modified).
- `RangedDat` lives in `packages/dat-parser/src/RangedDat.ts` and is used only by `PatchScreen.loadPatchSplashFiles` (:181) to draw the patch splash ahead of the download. It costs 28 Range requests and 3.99 MB.
- `FileDatBytes` (`packages/dat-parser/src/node/FileDatBytes.ts`) is the Node on-demand source. `tests/_harness/dat.ts openDat()` wraps it.
- `DatDatabase` already takes any `DatBytes`.
- **Every consumer reads synchronously** (`getFileData` → parse → build mesh/texture in the same call).
- **Missing asset today:** `getFileData` returns null, and the consumer silently skips. Nothing ever retries:
  - `ServerObjectManager.buildMesh` (:2569) returns null and the object is invisible.
  - `LandblockObjectStreamer` drops the model.
  - The UI draws no image.
  - Streaming therefore needs either "fetch before build" or "rebuild on arrival". It must never rely on null meaning "doesn't exist".
- Browsers allow no synchronous file read on the main thread. `FileSystemSyncAccessHandle` exists only in dedicated workers, and `Atomics.wait` throws on the main thread. `docs/perf-pass-2026-09-30.md` (proposal A, "Open") already records this.

## 1. Access-pattern measurement (offline, Node)

`npx tsx tools/dat-access-sim.ts --json verification/dat-streaming/access-sim.json --boot-set verification/dat-streaming/pack-sets.json`
(about 4 s). It opens the DATs through a tracing `FileDatBytes` wrapper and wraps `getFileData`. Then it drives **the shipped
loader code**:
- the real `GameUI` and `LayoutRenderer` in happy-dom for char-select and chargen;
- the real `TextureManager`, `MaterialFactory`, `ModelRenderer`, `SetupModelRenderer`, `DegradeLod` and `CharacterModelBuilder`;
- the real `TerrainManager` and `TerrainRenderer` material builders;
- the real `LandblockObjectStreamer` with real `EnvCellRenderer`, `SceneryInstancer`, `SceneryInstancePool` and scenery builder at draw distance 8;
- the real `MotionManager` (default stance);
- the real `DungeonRenderer`.

A file's bytes count in the first phase that touches it, because the cache makes later touches free.

Columns:
- **payload** is the uncompressed file bytes. **gz** is gzip -6 per file (the transfer size of a per-file object).
- **leaves** are files that would be individual objects under the publish plan (portal GfxObj, Animation, Palette, Texture, Wave and Environment).
- **sector/runs** is the Range-into-the-raw-.dat model: whole sectors touched, and the contiguous sector runs that each need one request. **coalesced** merges runs within 64 KB.

| Phase | DAT | files | payload MB | gz MB | leaf reqs | leaf gz MB | Range: sector MB / runs / coalesced |
|---|---|---:|---:|---:|---:|---:|---|
| open (header + full B-tree walk) | portal | – | – | – | – | – | 4.36 / – / 1,656 |
| | cell | – | – | – | – | – | **45.56** / – / 44 |
| | highres | – | – | – | – | – | 0.14 / – / 70 |
| splash (patch screen art) | portal | 46 | 3.91 | 0.89 | 42 | 0.87 | 3.95 / 46 / 6 |
| init (MasterProperty, 0x0E tables, RegionDesc, font + sheets, cursors) | portal | 17 | 2.43 | 0.53 | 3 | 0.10 | 2.45 / 45 / 26 |
| | local | 15 | 0.41 | 0.10 | – | – | (string tables) |
| **charselect** (GameUI ctor with the preload deferred, launcher, connecting dialog, layout 0x21000004, every pre-world layout's art; 2026-10-05, §6.6) | portal | 179 | 7.84 | 1.63 | 170 | 1.58 | 7.99 / 220 / 53 |
| | local | 7 | 0.04 | 0.01 | – | – | |
| gameui-preload (GameUI's UI texture list, released with the world packs) | portal | 318 | 14.02 | 5.14 | 318 | 5.14 | 14.28 / 382 / 65 |
| chargen (0x21000038, Aluvian male model) | portal | 145 | 2.03 | 0.50 | 78 | 0.47 | 2.14 / 146 / 42 |
| chargen-all (all 13 heritages × 2 sexes: upper bound) | portal | 425 | 8.33 | 2.96 | 248 | 2.87 | 8.66 / 476 / 112 |
| world-init (terrain/blend/road materials, detail surfaces) | portal | 77 | 31.25 | 17.76 | 38 | 17.76 | 31.45 / 170 / 55 |
| portal-space (Setup 0x02000306, DidMapper 0x25000010, Animation 0x030005AC) | portal | 12 | 0.09 | 0.04 | 6 | 0.04 | |
| **holtburg 0xA9B4** | cell | 503 | 0.12 | 0.07 | – | – | 0.15 / 503 / 25 |
| | portal | 2,008 | 9.97 | 4.41 | **759** | **4.32** | 11.63 / 2,023 / 231 |
| walk east 1 block | cell+portal | 343 | 0.41 | 0.22 | 53 | 0.18 | |
| walk east 2 | cell+portal | 183 | 0.49 | 0.20 | 59 | 0.19 | |
| walk east 3 / 4 | cell+portal | 43 / 17 | 0.07 / 0.00 | 0.01 / 0.00 | 8 / 0 | | |
| dungeon gate (Holtburg dungeon drop cell 0x01F60289 + its 27 stab cells + the block's world-DB objects) | cell+portal | 460 | 1.29 | 0.65 | 177 | 0.63 | |
| dungeon rest (the other 401 cells; ours builds the whole block) | cell+portal | 572 | 0.56 | 0.27 | 72 | 0.20 | |
| ui-all (every other LayoutDesc's art: upper bound for all panels) | local+portal | 228 | 6.49 | 1.49 | 139 | 1.42 | |

The Holtburg row splits as terrain 0.07 MB (17×17 CellLandblocks), streamer objects 8.3 MB payload (3×3 shown + prefetch
ring: buildings, statics, scenery, EnvCells, degrades) and world-DB objects 2.2 MB (150 weenies: 3×3 server ring + generator
children: setups, motion tables, idle animations).

DAT inventory (from `publish-dry-run.txt`):
- **portal**: 79,694 files, 852 MB of payload. Textures 0x06 are 606 MB (20,684 files), GfxObjs 81 MB, Animations 56 MB, Waves 52 MB and Palettes 37 MB. The other ~35.5k files (Setups, Surfaces, SurfaceTextures, MotionTables, tables, fonts and so on) total only 11.9 MB.
- **cell**: 805,348 files:
  - 65,025 CellLandblocks: 16.4 MB, 3.5 MB gzip, so the whole world's terrain;
  - 5,346 LandblockInfos;
  - 734,976 EnvCells: 192 MB, all inside those 5,346 landblocks.
- **highres**: 2,294 textures, 130 MB.
- **language**: 117 files, 0.7 MB.

Gzip per type: GfxObj 0.63, Animation 0.75, Palette 0.35, Texture 0.45, Wave 0.89, MotionTable 0.19, terrain 0.15.

### Assumptions and caveats

- Pre-world UI runs in happy-dom with a no-op 2D canvas. The DAT reads happen before any pixel reaches a canvas, so file and byte counts are real. CSS-only UI costs nothing either way.
- The `init` phase lists main()'s boot reads explicitly (`main.ts` ~1000–1420). main() also builds the world-init materials before char-select today. The table books them separately, because the streaming design moves them off the critical path.
- **Server objects** are the world DB's static instances plus generator children (two levels) in the 3×3 ring, built from their own PropertyDataId Setup, MotionTable, SoundTable, PhysicsEffectTable and ClothingBase. Not modelled:
  - live ObjDesc overrides (NPC clothing, palettes) and other players' gear, so real towns cost somewhat more;
  - Waves (decoded on play), particle/default scripts, and inventory/spell icons (13,706 icon-sized textures, 54 MB in total, fetched as used);
  - highres (off by default).
- The player model is counted once (chargen built it, so the Holtburg "player" step shows 0). A returning player pays about the chargen model share (~0.5 MB gzip) inside the Holtburg phase instead.
- The human motion table 0x09000001 references 321 animations (12.9 MB, 9.6 MB gzip). Only the default-stance cycles are counted. Combat-stance animations are fetched when the stance is entered (§2.3).

## 2. Gameplay and latency impact

### 2.1 Retail gated portal exit on DAT availability. Port it.

Retail's client also had to get the bytes from somewhere: local disk through DBCache, and for cells missing from the
install, a runtime download from the server (DDD). It hid that wait behind portal space. From
`reference/client-eol/decomp/acclient-decompiled.annotated.c`:

- **`SmartBox::HandlePlayerTeleport` @ 00452150** (:85193): an in-order teleport sets `position_update_complete = 0`, `has_been_teleported = 0` and `waiting_for_teleport = 1`.
- **`SmartBox::UseTime` @ 00455410** (:88160):
  - While `cell_manager->blocking_for_cells` is true, it only calls `CellManager::CheckPrefetchStatus`. Object maintenance, physics and LScape `UseTime` all stop.
  - Only when it is false does it run `ChangePosition`, and only then (`waiting_for_teleport == 0`) does it set `position_update_complete = 1` / `has_been_teleported = 1`.
- **`SmartBox::teleport_in_progress` @ 00451c20** (:84780) is `player && !position_update_complete`.
- **`gmSmartBoxUI::UseTime` @ 004d6e30** (:207396) begins `TAS_TUNNEL` and keeps it running while `teleport_in_progress()`. It calls `EndTeleportAnimation` only once that clears.
- **`CellManager::PreFetchCells` @ 00455820** (:88477):
  - Outdoors (cell id & 0xffff < 0x100) it calls `LScape::PreFetchCells(id | 0xffff)`. @ 00505660 (:252116) walks the ±`mid_radius` landblock grid, `DBObj::PreFetch`es each CLandBlock and then its LandBlockInfo (0xfffe).
  - Indoors it calls `CEnvCell::PreFetchCells` (the cell and its visible cells).
  - If anything is missing it sets `blocking_for_cells = true` and emits `ECM_DDD::SendNotice_RuntimeDDDStatus(true, done, total)` progress. When everything is present it clears the flag and emits `(false, 0, 0)`.
- **`CellManager::CheckPrefetchStatus` @ 00455be0** (:88704) re-polls every `5.0` s (`___real_4014000000000000`).
- LoginComplete only goes out after the teleport animation ends (our `network/LoginCompleteNotifier.ts`, DECOMP.login-complete-timing). So during the wait ACE keeps the player hidden and invulnerable, and nothing can attack a loading player.

**Ours today** calls `gameUI.endPortalSpace()` as soon as the destination position is applied: `main.ts` :4196 (login/startGame) and :5592 (teleport). The comment at :5585 says "Terrain may still be loading here". Today that is harmless because everything is in memory. Under streaming, the port is the core latency-hiding mechanism:

> Portal space (and login's initial portal) holds until the destination's **gate set** is resident:
> - outdoors: the 3×3 object ring's landblock bundles, every model/texture closure they reference, and the server objects already created there;
> - indoors: the drop cell's bundle, its stab-list cells' closures and the block's objects.
>
> Everything else prefetches by load point while walking.

Measured gate sets:
- Holtburg: ~760 leaf requests, ~4.4 MB gzip, plus 25 small bundles.
- Holtburg dungeon: 177 leaf requests, 0.65 MB.

The terrain ring itself costs nothing extra, because terrain ships as one 3.5 MB pack (§3.2). Retail's own tunnel already runs at least 2 s (PortalSpaceModel), which covers most of this on a decent connection.

### 2.2 Quantified (cold first session, gzip transfer, HTTP/2 with 64 concurrent streams)

The model is RTTs on the critical path plus bytes / bandwidth.
- Char-select costs 4 RTT (DNS/TLS, pointer, packs) plus 2.4 MB.
- World packs are 30.6 MB with no RTT term (one stream each).
- Holtburg costs about 14 RTT, from three dependent waves (bundles → GfxObjs → textures/palettes) in 64-wide rounds, plus 4.4 MB.
- A walk step costs 3 RTT plus 0.45 MB.

The "today" column is the full 1.28 GB download (or 564 MB if all of it were gzip-streamed).

| link | RTT | char-select | world packs (while at char-select) | Holtburg gate | walk step (hidden by prefetch) | today, full DATs |
|---|---|---|---|---|---|---|
| 20 Mbps | 80 ms | 1.3 s | 12 s | 2.9 s | 0.4 s | **8.5 min** |
| 50 Mbps | 80 ms | 0.7 s | 4.9 s | 1.8 s | 0.3 s | 3.4 min |
| 50 Mbps | 200 ms | 1.2 s | 4.9 s | 3.5 s | 0.7 s | 3.4 min |
| 200 Mbps | 30 ms | 0.2 s | 1.2 s | 0.6 s | 0.1 s | 51 s |

R2 latency: an edge-cache hit is ~20–80 ms in the US. A PoP that has not seen an object yet goes to R2 (+~100–300 ms). With
a small player base most first requests miss the edge, so use the 200 ms rows as the realistic early-launch case. Enable
Tiered Cache so that PoPs fill from a regional tier rather than from R2.

**Second session:** every object is content-addressed and immutable, so OPFS hits need no revalidation. The only network
request is the 1 KB set pointer (`max-age=60`). Char-select and Holtburg both become local reads (~ms), the same as today's
OPFS-cached path.

### 2.3 Case by case

- **Walking into a new landblock.** Today `LandblockObjectStreamer` builds the 3×3 ring visible and one more ring hidden (`OBJECT_PREFETCH_RINGS = 1`).
  - A block is first requested at least one block (192 m) before it becomes visible. Even at a fast run (~10–20 m/s) that is 10–20 s, against a measured 0.1–0.7 s to fetch a step's 0–0.5 MB.
  - Terrain is local (one pack). **No hitch, no pop-in** beyond what exists today.
  - The main-thread parse/build cost is unchanged, still time-sliced by the existing budgeted scheduler. Network waits are off-thread.
- **Monster/NPC with an uncached model.** ACE sends CreateObject for the 3×3 server ring, usually well outside draw range.
  - Prefetching the setup closure before `buildMesh` (2 dependent waves, ~2 RTT) lands it before it is visible.
  - Worst case: something spawned *in view* that was never seen before (a summon, a drop, a first spell projectile) appears 50–250 ms late, once ever per device.
  - Mitigation: warm the common sets (spell projectiles/particles, player heritages, starter gear) in background idle.
    Spell projectiles, missiles, arrows and every PhysicsScriptTable effect now ride the common pack (§6.14).
- **Animations** are leaves (56 MB in total). The default-stance cycles are prefetched with the object.
  - A first-ever combat stance switch: prefetch the stance's animation set when the stance-change command is issued. The stance transition itself plays for ~0.5 s, which covers 1–2 RTT.
    Shipped 2026-11-03 (STREAM.style-animations-on-first-use, webac#16): until then nothing did it, so the first swing / cast
    of each kind in a combat style missed and was dropped (an AC1999 Banderling Captain hit with no swing) or snapped to its
    hold. `animation/AnimationPrefetch.ts`: `MotionManager.enterStyle` asks for the style's cycles, links and modifiers at
    prefetch priority as any object (ours included) takes the style, once per table and style per session.
  - If an action animation is still missing, hold the current cycle until it arrives rather than skipping it.
    Shipped 2026-11-03 (STREAM.action-held-for-animation): `MotionManager` holds an action, the death fall or a link into a
    non-locomotion substate (a cast gesture, sitting, a door swing) whose Animation is a streamed miss, and plays it from frame 0
    when `onDatMissResolved` runs `retryMissedAnimation`; after `ACTION_ANIMATION_HOLD_MAX_S` (1.5 s) it is dropped as with whole
    DATs. Locomotion / Ready / style links still skip (the body is moving; the cycle catches up). A style entered again re-asks
    the files the LRU evicted (STREAM.style-prefetch-after-eviction).
- **Sounds:** WebAudio decoding is already async. Waves are fetched on first play, ~1 RTT late the first time. UI and ambient sounds go in the world pack or a background warm-fill.
- **Icons:** inventory/spell icons fetch on first display and need a repaint-on-arrival hook. Prefetch the PlayerDescription's inventory and spellbook icons at login, behind portal space.
- **Portaling:** the gate (§2.1) shows the tunnel slightly longer on a cold destination (1–4 s at the 50/200 ms rows), then never again for that place.
- **Network gameplay latency.** The WebSocket/UDP game stream is a few KB/s on a different origin, so there is no HTTP/2 head-of-line coupling.
  - The only interaction is the player's last-mile queue. A 30 MB burst can add bufferbloat delay on a weak link.
  - Critical bursts (world packs, gate sets) happen at char select or behind portal space, when the player is not acting.
  - Background warm-fill must be throttled (`fetch(..., { priority: 'low' })`, at most ~25% of measured throughput, paused while in a combat stance).
  - With that, the impact on gameplay latency is negligible.

## 3. Architecture

### 3.1 Options

**(a) Sync reads in a Web Worker: OPFS `FileSystemSyncAccessHandle` + SharedArrayBuffer + `Atomics.wait`.** Rejected.
- `Atomics.wait` is forbidden on the main thread, and the DAT consumers (renderer, UI, physics) run there. The main thread could only spin-wait (burning a core, freezing the tab until bytes arrive) or get the bytes asynchronously anyway.
- Making it truly synchronous means moving the entire renderer and game into a worker with OffscreenCanvas. That is a multi-week rewrite, and the DOM UI (LayoutRenderer, GameUI) cannot move.
- It would also need cross-origin isolation:
  - `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) on the game's HTML, set by whatever serves it (the web container's Caddy);
  - every cross-origin subresource (the R2 DAT domain, any CDN/font) served with CORS or `Cross-Origin-Resource-Policy: cross-origin`. For R2 that means a Transform Rule adding CORP, or CORS fetches.
  - COOP also breaks popup-based flows (OAuth windows).
- And it still doesn't remove the need to know *what* to fetch before a frame needs it.

**(b) Async refactor of every consumer.** Rejected as the primary approach.
- Every `getFileData` → parse → build chain would become `await`. There are hundreds of call sites across TextureManager, MaterialFactory, the model renderers, EnvCellRenderer, LayoutRenderer, GameUI, MotionManager, SoundPlayer and CursorManager.
- Async would also spread through physics/collision setup.
- Correct, but enormous, and it fights the retail-faithful synchronous structure (DBObj::Get).

**(c) Hybrid: prefetch-then-sync. Recommended.** This is exactly retail's shape (`DBObj::PreFetch` then `DBObj::Get`; `blocking_for_cells`).
- `StreamedDatDatabase` implements today's `DatDatabase` surface (`getFileData`, `hasFile`, `getFileEntry`, `listFileIds`, `fileCount`, `blockSize`, `totalIterations`). Its sync reads are served from an **in-memory map of resident files**.
- An async `DatStore` fills that map. It has a priority queue (critical / prefetch / background), coalesces in-flight duplicates, inflates gzip with `DecompressionStream`, and persists every object to OPFS by hash.
- Consumers stay synchronous. A handful of **choke points await a prefetch before running their existing sync code**:

  | Choke point | Gate before the sync code runs |
  |---|---|
  | boot | the boot pack |
  | Enter World | the world packs + `ensureGate(destination)` (the retail gate) |
  | teleport | `ensureGate(destination)` |
  | `LandblockObjectStreamer` | each queued block's closure, before `loadNow` |
  | `ServerObjectManager` | the setup + ObjDesc closure, before `buildMesh` |
  | stance change | the stance's animations |
  | icon/sound first use | fetch, then repaint/play |

- A miss outside a gate returns null (as today), enqueues a critical fetch and fires `onResident(id)`. The owning system rebuilds: the ObjDesc rebuild path at `ServerObjectManager` :1433, a texture-cache invalidation, an icon repaint.
- A dev-mode counter of misses that happened outside a gate is the regression signal (gate coverage).
- Closure discovery is local and cheap, because all small structural files ship in the **skeleton pack** (11.9 MB raw, 2.6 MB gzip): Setups, Surfaces, SurfaceTextures, MotionTables, DegradeInfos, Scenes, PhysicsScripts and the tables.
  - The dependency walk Setup → GfxObj → Surface → SurfaceTexture → Texture → Palette needs network only at the leaves.
  - That gives at most 2–3 dependent waves per gate, with no precomputed closure lists needed.
- Memory drops from ~1.4 GB of whole-DAT ArrayBuffers to the resident set: ~70 MB of payload for the Holtburg session above, plus an LRU bound. That closes proposal A.

### 3.2 Storage layout on R2

**Raw .dat + HTTP Range: rejected for the hosted path.**
- `client_portal.dat` (927 MB) exceeds the 512 MB CDN-cacheable object limit, so every Range goes to R2: higher latency and a Class B operation each.
- Raw sectors cannot be gzip'd (2.2× more bytes).
- Locating a file needs the B-tree. The cell.dat directory alone is **45.6 MB** of sectors (805k entries). A lazy walk costs 3–4 sequential round trips per cold lookup.
- One upside measured: chains are contiguous (runs ≈ files), so a lookup-free index would make it ~1 request per file. But building that index *is* a repack, so do it properly.

**Recommended: content-addressed objects plus a manifest.** Produced by `tools/publish-dats-r2.ts`; dry run in `verification/dat-streaming/publish-dry-run.txt`.

| Object | Count | Size (gzip) | Fetched |
|---|---:|---:|---|
| set pointer `v1/sets/<set>.json` (the only mutable key, `max-age=60`) | 1 | ~1 KB | every launch |
| boot pack (splash + init + char-select files, from `pack-sets.json`) | 1 | 2.3 MB | before char select |
| language pack (the whole local DAT) | 1 | 0.14 MB | before char select |
| manifest (binary: leaf table, packs, bundles) | 1 | 0.74 MB | in the background at char select |
| skeleton pack | 1 | 2.6 MB | in the background at char select |
| world pack (GameUI preloads, chargen, terrain materials, portal space) | 1 | 23.8 MB | in the background at char select, gates Enter World |
| terrain pack (every CellLandblock) | 1 | 3.5 MB | in the background at char select |
| landblock bundles (LandblockInfo + all EnvCells per landblock) | 5,346 | 85 MB total (median 1.3 KB, max 1.2 MB) | per block, by the streamer/gate |
| leaves (portal GfxObj/Anim/Palette/Texture/Wave/Environment) | 44,147 | 381 MB total | on demand |
| highres leaves | 2,294 | 64 MB total | only at Environment Texture Detail = Very High |

- Keys are `v1/o/<first 8 bytes of sha256(payload), hex>` (collision odds ~1e-9 at this scale).
- Objects are stored gzip'd as `application/octet-stream`, and the client inflates them. Do **not** set `Content-Encoding`: Cloudflare may re-encode, and it complicates any future Range use.
- Cache headers: `public, max-age=31536000, immutable`.
- The largest object is 23.8 MB, well under 512 MB, so everything is edge-cacheable.
- Invalidation is free: a new DAT set or iteration produces new hashes for changed files only, and a new pointer.
- **Era variants:** a Dark Majesty set is another pointer (`v1/sets/dm-….json`) and manifest over the same `v1/o/` space. Byte-identical files dedupe automatically, and the client picks the pointer from its era profile (`docs/roadmap-era-variants.md`).
- The boot/world pack lists come from the simulation (`--boot-set`), so they track code changes. Re-run the sim, then publish again; only changed packs upload.
- Request counts are reasonable: about 760 leaves for a cold Holtburg, spread over HTTP/2.
  - If edge-miss latency proves painful at launch, add a Cloudflare Worker batch endpoint (POST a list of hashes, get back one concatenated stream from the R2 binding). That cuts requests ~50×.
  - It is optional and should only be built if the live numbers say so.
- **Local install fallback ("use my AC install").**
  - The player picks `client_portal.dat` / `client_cell_1.dat` / `client_local_English.dat` (`<input type=file>` or `showOpenFilePicker`). The File objects are read with `Blob.slice(offset, len).arrayBuffer()` through an async `DatBytes`-style source using the existing `RangedDat` container logic. The directory walk is local (the 45 MB cell directory reads in well under a second off disk).
  - Accept a file only if its Iteration record matches the set (portal 2072 / cell 982 / local 994). Otherwise warn and fall back to R2 for that DAT.
  - Persist the FileSystemFileHandle in IndexedDB (Chromium) so the player picks once. Files from it feed the same in-memory resident map; there is no OPFS copy, because the install is the cache.
- Legal note for Jake: publicly hosting the retail DATs is a redistribution of Turbine/WB content. The emulator community does it, but the local-install path is the clean alternative if that ever matters.

## 4. R2 setup and upload (Jake: the credential steps)

0. **The live bucket is `webac-dats`** (custom domain dats.playwebac.com). The original name `acjs-dats` in this section
   was stale until 2026-10-06. Classic sets went up with `tools/upload-stream-set-r2.ts`, a temporary Worker bound to the
   bucket under Jake's wrangler OAuth with `--known <eol stage>` to skip shared objects (docs/dark-majesty-support.md
   "Hosted classic sets"). The rclone route below needs an R2 API token, which only Jake can create: the agent harness
   blocks minting it.
1. **Bucket.** Cloudflare dashboard → R2 → Create bucket `webac-dats`. Location: Automatic. Storage class: Standard. Storage is 0.56 GB (+1.4 GB if `--raw`), inside R2's 10 GB free tier, and egress is free.
2. **Custom domain.** Bucket → Settings → Custom Domains → Connect Domain → `dats.<your-domain>`. The zone must be on Cloudflare. Don't use `r2.dev`: it is rate-limited and not for production.
3. **Caching.** Cloudflare's default cache rules key on file extension, and our keys have none. Without a Cache Rule nothing caches at the edge.
   - Add one: Caching → Cache Rules → hostname equals `dats.<domain>` → **Eligible for cache**, Edge TTL **"Use cache-control header if present"**, Browser TTL **respect origin**.
   - Turn on **Tiered Cache** (Caching → Tiered Cache → Smart Tiered Caching, free).
4. **CORS.**
   - Bucket → Settings → CORS policy. Paste `npx tsx tools/publish-dats-r2.ts --print-cors`: GET/HEAD from `*`; allowed headers `Range`, `If-None-Match`, `If-Modified-Since`; expose `ETag`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `Last-Modified`; max-age 86400.
   - Wildcard is deliberate: public, credential-free data, and no `Vary: Origin` cache poisoning.
   - wrangler uses a different file shape (`{"rules":[{"allowed":{"origins":["*"],"methods":["GET","HEAD"],…}}]}` with `npx wrangler r2 bucket cors set webac-dats --file cors.json`; check `--help` for the expose/max-age keys).
   - Set CORS **before** first traffic. Otherwise purge the cache afterwards (cached responses keep their old headers).
5. **Credentials** (the only thing that needs Jake). R2 → Manage R2 API Tokens → Create API token, **Object Read & Write**, scoped to bucket `webac-dats`. Note the Access Key ID, the Secret Access Key and the account's S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
6. **Tool.** Use rclone, not wrangler:
   - `wrangler r2 object put` caps at **315 MB per object** and does one object per call, so it is unusable for 51,793 objects.
   - The Cloudflare REST API is also limited to 1,200 requests per 5 minutes.
   - R2's S3 API allows 5 GiB single PUTs and multipart up to ~5 TiB (10,000 parts of 5 MiB–5 GiB). rclone does multipart automatically, which only matters for `--raw`.

   ```
   brew install rclone
   rclone config create r2 s3 provider=Cloudflare access_key_id=<KEY> secret_access_key=<SECRET> \
     endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com acl=private no_check_bucket=true
   rclone lsf r2:webac-dats            # sanity check (empty)
   ```
7. **Publish.**

   ```
   npx tsx tools/dat-access-sim.ts --json verification/dat-streaming/access-sim.json \
     --boot-set verification/dat-streaming/pack-sets.json        # refresh pack lists (4 s)
   npx tsx tools/publish-dats-r2.ts                               # dry run: plan only (~1 min, reads + hashes + gzips everything)
   npx tsx tools/publish-dats-r2.ts --execute                     # stage to $TMPDIR (~690 MB on disk) + rclone upload
   ```

   - Idempotent:
     - objects are content-addressed and uploaded with `--ignore-existing`, so a re-run sends only new hashes;
     - the pointer `v1/sets/<set>.json` goes **last**, so a reader never sees a manifest whose objects are missing.
   - Cost:
     - 51,793 Class A PUTs, inside the 1M/month free tier;
     - reads are Class B only on edge misses (10M/month free; a cold player is ~800–1,000 objects).
   - Verify: `curl -sI https://dats.<domain>/v1/sets/eol-p2072-c982-h497-l994.json` (200 + CORS headers), then a second `curl -sI` on any `v1/o/<hash>` should show `cf-cache-status: HIT`.

## 5. Phased plan

Effort is in focused agent-days. Every item ships with behavioural tests (fake fetcher + real parsers) and a live check (cold-cache login to Holtburg, a teleport, a dungeon, perf-soak).

**Phase 1: prerequisites for public launch (~12–16 days)**

1. *(Jake, ~30 min)* R2 bucket, domain, cache rule, CORS and token (§4). Then run `publish-dats-r2.ts --execute`.
2. `DatStore` (1.5–2 d). Pointer/manifest/pack/bundle readers for the formats in the `publish-dats-r2.ts` header. A priority fetch queue with in-flight coalescing, `DecompressionStream`, an OPFS object cache keyed by hash, and an in-memory resident map with an LRU bound. Dev serves a `--stage-only` directory through Vite, so dev and prod share one code path.
3. `StreamedDatDatabase` facade (1 d). Today's `DatDatabase` surface over the resident map:
   - `hasFile` / `getFileEntry` / `listFileIds` come from the manifest + pack indexes;
   - a miss returns null, enqueues and fires `onResident`;
   - plus the dev-mode count of misses outside a gate.
4. Boot flow in `main.ts` (1–1.5 d).
   - Replace the four `fetchDat` calls with: pointer → boot + language packs → splash → char select. In the background: manifest, skeleton, world and terrain packs.
   - The Enter button waits on the world packs.
   - The gmDataPatchUI meter now reports pack bytes, which is closer to retail's runtime DDD.
   - Retire `DatCache.ts`'s whole-file path.
5. **Port the retail cell gate** (2–3 d). `ensureGate(position)` follows `CellManager::PreFetchCells`:
   - outdoors: the object-ring bundles + closures;
   - indoors: the cell + stab list;
   - also the server objects already known there.
   
   `teleport_in_progress` holds the tunnel at `main.ts` :4196/:5592 until it resolves. Keep a CheckPrefetchStatus-style re-poll and the RuntimeDDDStatus progress.
6. `LandblockObjectStreamer`: an async prefetch step per queued block, before `loadNow` (1–1.5 d).
7. `ServerObjectManager`: prefetch setup + ObjDesc closure before `buildMesh`, building when resident (reuse the :1433 rebuild path) (1.5–2 d).
8. Late-miss rebuild hooks (2 d): texture/material invalidation, icon repaint, MotionManager holding the current cycle on a missing animation, stance-change animation prefetch, async Wave fetch.
9. Hosting (0.5 d): the R2 URL in config, CORS verified from the Railway origin, and a cold-cache live run at a throttled 20 Mbps / 200 ms to confirm the §2.2 numbers.

**Phase 2: soon after launch (~4–6 days)**
- Background warm-fill, throttled and low priority: the player's motion-table stances, inventory/spellbook icons, known spells' effects, UI sounds, neighbouring towns.
- An Options toggle "Download all game data" (564 MB) for retail-like offline play.
- Local-install fallback: File/`Blob.slice` source over the existing `RangedDat` container code, an iteration check and the persisted handle (§3.2).
- Memory LRU eviction tuning with perf-soak budgets. Proposal A closed: measure renderer RSS before and after.

**Phase 3: later**
- Era-variant sets (Dark Majesty pointer, shared `v1/o/`).
- The Worker batch endpoint, only if live edge-miss numbers warrant it.
- Precomputed closure lists in the manifest, if gates show too many dependent waves.
- Service Worker offline shell.

## 6. Implementation and live measurements (2026-10-04)

### 6.1 What was built

| Piece | Where | What it does |
|---|---|---|
| Set formats (read side) | `packages/dat-parser/src/streaming/DatSetFormat.ts` | Pointer / `ACDM` manifest / `ACPK` pack parsers, `SKELETON_TYPES` (now the one list the publish tool, the sim and the client share), the synthesized Iteration record, DAT header fields (pointer `dats`, else the measured EoL headers only for the EoL set). |
| Miss epoch | `packages/dat-parser/src/streaming/DatMiss.ts` | A counter the streamed DAT bumps on every miss. Caches that keep what they built (MaterialFactory, SceneryInstancer, TextureManager level lists, LandblockScenery scenes, EmitterSprite, main.ts emitter sprites, GameUI icon caches) skip the write when a miss happened during the build. Whole DATs never miss, so nothing changes for them. |
| Resident-source DatDatabase | `DatDatabase` (`DatResidentSource`) | The same class every consumer types against, reading a resident map instead of a container. A miss returns null and enqueues a critical fetch. |
| `DatStore` | `packages/renderer/src/dat/streaming/DatStore.ts` | Pointer → manifest + packs, per-landblock bundles, per-file leaves. Priority limiter (96 network, §6.7 / 32 OPFS), in-flight coalescing by hash and by file, `DecompressionStream`, size + sha256-prefix check on every object (cache hits too), 3 retries with backoff, `cache: 'no-store'` + `readResponseBytes` length check. `MissScope` / `scoped()` tell a builder what it missed. `stats` (incl. `missesByType`) for probes. |
| OPFS object cache | `dat/streaming/ObjectCache.ts` | `acjs-dat-objects-v1/<hash>`, gzip bytes as fetched; keyed by content hash only, never by DAT iteration. `?nocache` bypasses it. |
| Closure walker | `dat/streaming/DatClosure.ts` | The §3.1 edges (Setup → parts / motion table / DefaultScript → emitters → HW GfxObj; GfxObj → surfaces / DIDDegrade; Surface → SurfaceTexture / palette; SurfaceTexture → texture levels; Texture → palette; MotionTable → default-style cycles + links; LandblockInfo → stabs / buildings / every EnvCell; CellLandblock → `generateScenery()`'s objects; EnvCell → surfaces / Environment / statics). `ensureLandblock`, `ensureLandblockRing`, `layoutArtIds` (every LayoutDesc's art). |
| Portal-space gate | `dat/streaming/PortalSpaceGate.ts` | `CellGate` = CellManager::PreFetchCells (object ring around the destination landblock + extra roots, RuntimeDDDStatus progress re-reported every 5 s, 90 s timeout / failed fetch → release + error). `GatedEventQueue` = the blocking_for_cells stop over the session's events. `settleBurst` waits (≤ 1.5 s, 400 ms quiet) for the destination's CreateObject burst so those objects prefetch before the hold releases (cap 3 s). |
| Arrival detection | `dat/streaming/ArrivalEvents.ts` | Our CreateObject with a position (login / re-creation) and our UpdatePosition while a PlayerTeleport is pending; `appearanceRoots` for an object's model. |
| Boot | `dat/streaming/StreamingDats.ts`, `main.ts bootStreamedDats` | Runtime config `datSet: { manifestUrl }` (or `?datSet=<url>`; `?rawDats` forces whole DATs). Manifest + boot + local + skeleton packs, then the pre-world layouts' art; world / terrain load behind char select (§6.6); the patch meter runs over the char-select set's bytes. UI art prefetches in the background from MasterProperty time; `ui` pack too once published. Without `datSet` the whole-DAT path is untouched (local dev, tests, tooling). `deploy/web/entrypoint.sh` writes `datSet` from `ACJS_DAT_SET_URL` and adds its origin to the CSP. |
| Hooks in the game | `main.ts`, `LandblockObjectStreamer`, `ServerObjectManager`, `SoundPlayer` | The session listener runs behind `GatedEventQueue` (login and teleport arrivals hold the tunnel; the gate opens the tunnel itself so the arrival code does not restart it). The streamer builds a block only when its closure is resident (`blockData`), requests it otherwise and re-queues on arrival; a build step that still missed rebuilds the block (`trackMisses` → `rebuildBlock`). Server objects build through `buildOrRebuild`: a missed build is redone (`rebuildMesh`: the ObjDesc path, or re-create at the latest position when there was no mesh) once the misses and the appearance closure are resident. A not-yet-resident Wave waits for its fetch and plays ~1 RTT late. A gate that gives up shows `CLIENT_NOTICES.datStreamFailed` in the spew box. |

The login gate's extra roots are the player's appearance and every LayoutDesc's art, so the HUD renders with its art: before
that was added a cold login missed 480 HUD/panel textures (LayoutRenderer draws once and never repaints).

### 6.2 Live measurements (headless Chromium + SwiftShader, Boston, against the published R2 set)

`tools/probe-dat-streaming.ts` (own Vite :3217, own bridge :9096 → local ACE, account streamprobe1). Bytes are the store's
gzip counters. "Wall" includes the login flow (auto-enter timer, ACE login, the retail tunnel's ≥ 2 s + fades) and
SwiftShader's software rendering, so the in-world times compare with each other, not with a GPU machine.

| | Cold (empty OPFS) | Warm (same profile) | Doc estimate |
|---|---|---|---|
| Char select | **1.7–2.0 s, 33–34.5 MB** (manifest + boot + local + skeleton + world + terrain = 34.6 MB wire, 6 objects) | **1.3–1.4 s, 0 B network** (34.5 MB from OPFS) | 2.4 MB (boot + local only) |
| Login gate (destination resident) | Holtburg 1.35 s (1,039 objects, 7.0 MB) + 1.08 s for 81 queued objects; Holtburg dungeon 1.5 s (1,177 objects, 6.6 MB) | 0.6 s (all from OPFS) | ~760 leaves, 4.4 MB, 1.8–3.5 s at 50 Mbps |
| In world | Holtburg 19.3 s, 46.9 MB / 2,396 objects in total; dungeon login 14.2 s, 42.2 MB | 12.0–18.5 s, 0–0.13 MB | — |
| Whole-DAT baseline (local Vite serving the raw DATs from localhost, same probe `--raw`) | in world 21.4 s with 1.28 GB read into memory | — | 1.28 GB (8.5 min at 20 Mbps) |
| Misses after entering the world | 39–41 (≈23 animation-hook particle GfxObjs, ≈15 Waves, a few icons) | 30–49 (the same files, served from OPFS) | — |

Teleports into uncached areas (cold profile, `@teleloc`; probe accounts are admin on the local ACE):

| Destination | Gate held | During the gate | Tunnel (first cover → world) |
|---|---|---|---|
| Holtburg 0xA9B40019 (from the dungeon) | 0.78 s | 579 objects, 3.0 MB | 11.2 s |
| Shoushi 0xDA55001D | 0.63 s + 1.14 s for 109 queued objects (495 roots) | 316 objects, 1.5 MB (3.7 MB incl. the objects) | 8.9 s |
| Holtburg dungeon 0x01F60289 | 2.14 s | 710 objects, 2.4 MB | 11.2 s |
| Same destination again (cached) | no hold | 0 | 3.7 s |
| Whole-DAT baseline, same teleports | — | — | 3.8–5.4 s |

Gate evidence: the tunnel covers at 0.15–0.6 s, `portal-space gate: holding for cell …` is logged at once, the arrival
code (`Teleport → …`, `Dungeon stream started`) runs only after `resident after …`, and the screenshots of every
arrival show the geometry, NPCs and the dungeon torches (`verification/dat-streaming/live/`). After the queued-object
prefetch was added a cold teleport left 4–21 misses instead of 657 (server objects that had built incomplete and rebuilt).
The tunnel on a cold destination runs longer than the gate itself (8.9–11.2 s vs 3.8–5.4 s whole-DAT): the hold, plus
the arrival's main-thread work under SwiftShader. Re-measure on a real GPU (`AC_GPU=1`) before tuning.

Closure completeness is pinned by `tests/verify-dat-streaming-closure.ts` against the real EoL DATs: after the gate,
the shipped `LandblockObjectStreamer` builds Holtburg's 3×3 (239 models, 152 cells) and `DungeonRenderer` the whole
Holtburg dungeon with zero misses, the dungeon torches' emitters resolve, and the player's Setup + default stance build
complete. The Holtburg gate there is 780 objects, matching §1's ~760 leaves + 25 bundles.

### 6.3 Republish needed (Jake; nothing was uploaded)

`tools/publish-dats-r2.ts` now writes two additions (dry run 2026-10-04: 51,794 objects; only 3 are new):

- pointer `dats`: each DAT's `blockSize / dataSet / dataSubset / masterMapId` (the client falls back to the measured EoL
  headers for the current pointer, so this is not blocking);
- a `ui` pack (role 6, 193 files, 1.5 MB gzip): every LayoutDesc's portal art not already in boot/world, from the sim's
  new `ui` list in `pack-sets.json`. The client loads it in the background when the pointer names it (today it walks the
  LayoutDescs itself and fetches the same art as leaves).
- the world pack changed (584 files vs 572: the sim follows code drift since the first publish).
- 2026-10-05 (§6.6): boot 242 files / 3.0 MB gzip (the pre-world screens' art moved in from world), world 552 files /
  23.4 MB, ui 139 files / 1.4 MB, new manifest (`publish-dry-run.txt`). Not blocking: with the 2026-10-04 boot pack the
  client fetches the same art as ~156 leaves (0.74 MB) before char select.

`npx tsx tools/publish-dats-r2.ts --execute` uploads the new world / ui / manifest objects and rewrites the pointer last.
Set `ACJS_DAT_SET_URL=https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json` on the web service to turn
streaming on for playwebac.com (the raw `assetBase` stays for the weenie side-files).

### 6.4 Not done yet

- ~~Char select at 2.4 MB~~ — done differently, §6.6 (6.6 MB: the skeleton pack stays in the char-select set).
- ~~RuntimeDDDStatus is console-only~~ — §6.6: it drives the power bar's DDD mode, as retail's did.
- Late-miss coverage outside gates: animation-hook particles, combat-stance animations (fetched on first use; the
  frame they miss plays without them). Icons, models and caches: fixed in §6.5.
- ~~Memory: no LRU bound~~ — §6.6 (256 MB LRU over leaves + bundles, `stats.residentBytes`). Renderer RSS
  before/after (perf proposal A) is still to be measured live (the probe now prints the store's resident bytes).
- Chargen's non-default heritages: the world pack carries the default heritage's model only (the sim's `chargen`
  phase); clicking through other heritages streams their parts as leaves on first use, as before.
- Local AC install fallback (§3.2): out of scope this round (Phase 2).
- Era sets: the store is set-agnostic (pointer URL in, content-addressed objects out, OPFS shared across sets by hash);
  choosing the set per server (launcher world → era) is the remaining wiring.

### 6.5 Regression gate before re-enabling (RELEASE.streaming-regression-gate, 2026-10-04)

Production was reverted to whole DATs after Jake's session with streaming on: item and paperdoll icons drew as letter
placeholders (only some filled in when a panel happened to re-render, equipped slots stayed letters/empty), and his
world model wore flat / untextured armor while the paperdoll looked right. Root causes and fixes:

| Symptom | Root cause | Fix |
|---|---|---|
| Letter icons that never fill in | Nothing prefetched an item's icon; `buildItemIconElement` returned null on a miss and every caller drew the name's first letter; nothing repainted when the file landed. | The store tracks missed files and fires a batched arrival signal (`DatMiss.onDatMissResolved`, `stats.unresolvedMisses`). An icon built across a miss is a blank holder that refills itself in place on arrival (`GameUI.pendingIconEls`); direct URL lookups that missed re-render the open icon panels (inventory, side pack, magic, spell bar, effects, vendor, trade, shortcuts) and the preload art (`loadChargenTextures`) retries. Every CreateObject prefetches its icon closure (icon, underlay, overlay, ITEM_TYPE backdrop, UiEffects tint: `GameUI.itemIconFileIds`), the login/teleport gate's queued-object pass includes icons (`queuedObjectRoots`), and `setSpellData` prefetches the spell icons' composite art. |
| Flat / untextured armor on the world model | `TextureManager.getRGBA` / `getDirectRGBA` / `getTexture` cached a paletted texture decoded **without its palette** (the `toRGBA()` fallback) when the 0x04 Palette leaf missed; MaterialFactory's guard did not help because the next material got the same cached texture. The player model is built in main.ts, outside ServerObjectManager's `buildOrRebuild`, so a missed build was never redone; ObjDescEvents (equip changes) and held items had no rebuild either. | Epoch guards on those caches. The player's own build (login and every own ObjDescEvent) runs through `streamedPlayerBuild`: a missed build rebuilds in place (part transplant) from the latest ObjDesc once the files and the appearance closure land. Other objects' ObjDescEvents use `buildOrRebuild` → `rebuildMesh`. Held items built across a miss are tagged (`WieldedItemVisual`) and re-attached with their Placement on arrival. |
| Other "built while missing, cached forever" caches (audit) | Negative / partial entries on a miss: main.ts physics-script, script-table, emitter-info and object-physics caches; LayoutRenderer resolved layouts; CursorManager mapper + CSS; GameUI icon / spell-icon / chat-font enum maps; examine enum mappers; DegradeLod chains. | All guarded (no entry when the read missed, or `hasFile` says the file exists). Clean on audit: SetupModelRenderer, ModelRenderer, ClothingRenderer, AppearanceManager, palette cache, MotionManager, SoundPlayer, EnvCellRenderer. |

**The gate:** `tools/streaming-ab.ts` runs the same scripted session twice against the local ACE (whole DATs via
`&rawDats`, then the R2 set from an empty OPFS) on a fresh admin account (`streamab1`; never testacjs*): teleport to
Holtburg, world + toolbar, inventory, wield dirk + shield + platemail (hauberk / leggings / gauntlets / sollerets, made
once with `@ci`: ClothingTable palettes on many parts), inventory + world, unwield the shield, character panel, magic
panel, teleport to Shoushi, world + inventory, take it all off. At each capture it waits for streamed misses to land and
for ACE's Hidden window to pass, then gates on: 0 unresolved misses, 0 pending icon holders, the DOM icon signature
(every data-URL image under the surface, as a hash multiset — a letter, a missing layer or a palette-less icon changes
it), the player model's material/texture signature, every shared server object's signature, and the teleport finished
(not Hidden, LoginComplete sent). Pixel diffs are reported, not gated (NPCs, animation phase, weather).

Verdict 2026-10-04 (`verification/dat-streaming/ab/2026-10-04T20-36-33/`): **PASS**, all 10 captures, every hard check;
pixel diffs 0–5 % (paperdoll pose / NPC motion / sky). The same tool on the unfixed code fails the backpack icon
signature (letters) — `unfixed-baseline/`. Streamed misses still seen in a session (all resolved within the settle):
~25 animation-hook particle GfxObjs, ~36 Waves, ~18–32 icon / palette textures fetched on first use.

Limits: SwiftShader headless; one character archetype (Aluvian male, academy kit + platemail; no loot-generated
multi-palette armor, no other heritages); world comparisons are signatures + pixel diffs of live scenes, not a
pixel-exact gate. No republish is needed for these fixes (icons and palettes are already per-file leaves).

### 6.6 Char select first, bounded memory, download progress (RELEASE.streaming-charselect-weight + RELEASE.streaming-memory-and-progress, 2026-10-05)

**Char select.** `openStreamingDats` now resolves on the char-select set and loads the rest behind it:

| Step | What | gzip (EoL set) | Awaited by |
|---|---|---|---|
| 1 | pointer, manifest | ~0.7 MB | boot |
| 2 | boot + local packs (`onBootPacks`: the splash draws now, not after the skeleton) | 3.0 + 0.14 MB (republished boot; 2.3 MB in the set published 2026-10-04) | boot |
| 3 | skeleton pack: every structural file (CharacterGenerator 0x0E000002, DidMappers, fonts, Setups …) | 2.6 MB | boot |
| 4 | the pre-world layouts' art (`PREWORLD_LAYOUTS`: 0x21000004 char select + launcher and its 0x21000040 bases, 0x21000042 DialogFactory, 0x2100003c text entry; `layoutArtIds(local, only)` follows `baseLayout`) | 0 leaves with the republished boot pack; 156 leaves / 0.74 MB with the 2026-10-04 one | boot (on the patch meter) |
| 5 | world + terrain packs (`worldPacks`, Prefetch priority), then the `ui` pack (Background) | 23.4 + 3.5 (+ 1.4) MB | `streamedWorldReady` in main.ts |

So char select needs **~6.6 MB / 6 objects** (republished set) or ~6.5 MB / ~160 objects (current set), against 34.6 MB.
Measured offline by `tests/verify-dat-streaming-charselect.ts`: a real DatStore over the EoL DATs with only steps 1–4
resident runs main()'s boot tables, the UI font + cursor, LayoutRenderer, the real GameUI constructor, the launcher, the
connecting screen and character select with **zero streamed misses**, and prints the pack sizes (gzip level 6).

Kept from the design's 2.4 MB: the skeleton pack (2.6 MB). The GameUI constructor parses CharacterGenerator, the
spell-component DualDidMapper and fonts, and a skeleton file that misses can only be refetched with its whole pack, so a
miss there would leave state built from nothing (no CharacterGenerator). With the skeleton resident every structural read
before char select is exact; only leaves can miss, and none do. (DatStore also treats a skeleton-type or CellLandblock read
while its pack is still downloading as a miss that resolves when the pack lands — never "absent" — so a negative cache
entry cannot form even if a later change reads one early.)

What moved behind char select, and where it is awaited:
- GameUI's preload art (~356 textures: chargen, HUD frames) and the heritage icons: `GameUI` ctor option
  `worldArtReady`; `showCharacterCreate` waits for it too (chargen draws heritage / clothing art from the world pack).
- main()'s terrain materials + blend/road overlays + detail surfaces, and the sky objects (after `skyObjectRoots`'
  closure — on the old path the sky's GfxObjs were leaves no gate covered, so a cold sky could build without them):
  `worldInit()` queues them; `streamedWorldReady` runs them once the packs are in. A day-group change before that does
  not rebuild the sky (the deferred build uses the current group).
- Every LayoutDesc's art (`uiArtReady`, Prefetch priority) follows the world and `ui` packs, so it never re-downloads
  their files as leaves, and is part of `streamedWorldReady`.
- **Login-gate regression found live (first version, 2026-10-05) and fixed.** The first cut loaded that art at
  Background priority behind char select; with autologin (0.5 s at char select) the login gate's critical requests for
  the HUD roots joined those background loads (browser `low` priority; queued behind everything in the store's
  limiters), so the gate held 7.2 s cold / 2.1 s warm instead of 1.6 / 0.6 s. Fixes: the art loads at Prefetch and is
  awaited before CharacterEnterWorldRequest with the world packs, so the gate holds for the destination only (offline
  model: gate 1,693 ms / 995 objects = main's 1,716 ms / 995, against 1,800 ms / 1,317 with the art racing it); and a
  request that joins an in-flight load at a higher priority now promotes it in both limiters (`Ticket`), so this
  inversion cannot recur. Ruled out: the LRU bookkeeping (36,852 resident reads: 24 ms capped vs 26 ms uncapped) and
  the copy-on-read (unchanged from before). With autologin the world packs + UI art (~27 MB cold) are now waited for
  between char select and the enter-world request instead of before char select; a player at the launcher never waits.
- **Warm profiles build the world before char select again.** Live after the fix above: cold matched main (login gate
  1,669 vs 1,574 ms, in world 24.8 vs 24.6 s) but a warm login gate took 2,457 ms against 568 ms, with no network. An
  offline cache-only benchmark (stub OPFS at 1 and 4 ms per read, 32-wide disk limiter, real DatStore + DatClosure +
  CellGate over the EoL DATs, origin/main's store vs ours) gives identical gates (90–102 ms and ~216 ms, 995 cache reads
  each). So the store path is not the difference. The likely difference, inferred because the store path matched (not
  measured live): on a warm profile the deferred main-thread work (terrain materials, sky, GameUI's ~356 preload data
  URLs and the garbage they leave) lands ~1 s before the login instead of before char select, and a gate served from
  OPFS is main-thread-bound. Now `openStreamingDats` asks the object cache
  (`ObjectCache.has`) whether the world + terrain packs are already stored; if so it awaits them and the UI art before
  resolving (`bootReport.worldCached`), and main() builds the world inline exactly as with whole DATs. Cold profiles keep
  the 6.4 MB char select.
- Awaited: the ACE `onEnterWorld` (before CharacterEnterWorldRequest) and, at the latest, the login gate
  (`gateFor` holds while `streamedWorldBuilt` is false). Whole DATs: `streamingDats` is null and every one of these runs
  inline exactly as before.
- `tools/dat-access-sim.ts` builds GameUI with the deferred preload, so the boot pack now carries what the pre-world
  screens draw (`pack-sets.json` boot 81 → 242 portal files; world 584 → 552; ui 198 → 144). **Republish** to pick
  it up (`npx tsx tools/publish-dats-r2.ts --execute`; dry run in `publish-dry-run.txt`); the client works with either.

**Memory.** Pack payloads (~91 MB: boot 14.2 + local 0.7 + skeleton 11.9 + world 47.4 + terrain 16.4, + ui 6.2) stay
resident. Downloaded leaves and landblock bundles (a bundle is one unit: all its cell files) are an LRU capped at
`DEFAULT_RESIDENT_CAP_BYTES` = 256 MB of payload. A cold Holtburg login downloads ~14 MB gzip (≈ 32 MB payload) of them,
each new town or dungeon 1.5–3.7 MB gzip, so the cap holds ~15–25 destinations; a session stays under ~350 MB against
1.28 GB of whole DATs. Eviction trims to 85 % of the cap, oldest first, and never touches a unit read or landed in the
last 120 s (`DEFAULT_MIN_RESIDENT_AGE_MS`, longer than the gate's 90 s timeout), so nothing a gate or prefetch just made
resident goes before its build: the cap is soft during a burst. Safe to evict: every read returns a copy, an evicted file
is still in the set (the next read is an ordinary miss, refetched from OPFS), and `DatClosure` drops its resident
verdicts on `onEvict` so gates and the landblock streamer re-check. A leaf fetched before its pack landed hands over to
the pack copy. Probes: `DatStore.stats` `residentBytes` / `packBytes` / `evictableBytes` / `evictions` / `evictedBytes`;
`window.__datStream.bootReport` is what boot awaited.

**Progress.** Retail does show runtime DDD progress in-world: `gmPowerbarUI::RecvNotice_RuntimeDDDStatus @ 004da5c0`
(fed by `CellManager::PreFetchCells` → `ECM_DDD::SendNotice_RuntimeDDDStatus`) switches the power bar to `PBM_DDD` (state
0x10000045), sets caption 0x10000035 to `ID_Powerbar_DDDModeText` — StringTable 0x23000001 entry 117639460,
`["Download: ", " / ", ""]` around CURRENT / TOTAL ("???" for a zero total) — and the meter to done / total; clearing calls
FinishPowerbar(PBM_DDD). `GameUI.setRuntimeDDDStatus` ports it (`ui/RuntimeDDDStatusText.ts`) and the login / teleport
gate's `onProgress` drives it (landblocks done / total, re-reported every 5 s as retail's CheckPrefetchStatus). Pre-world
the only surface stays the patch meter, which now covers the char-select set (packs + pre-world art). Nothing new was
invented: the world-pack download behind char select has no retail display (retail had nothing downloading there).

Live (lead, first version): boot awaited 6.42 MB / 160 objects in 837 ms, 0 misses at char select, resident 124–131 MB,
0 evictions; the gate regression above. Expected after the fix: login gate back to main's (~1.6 s cold / ~0.6 s warm),
teleport gates as main (Holtburg ~1.6 s, Shoushi ~0.8 s), with autologin the extra wait moves to before the enter-world
request (`world packs resident + world init built … ms` in the console). In-world totals unchanged (~47 MB).

### 6.7 Real-GPU gate check: cold edge, pipelined closure, 96 streams (RELEASE.streaming-gate-pipelined, 2026-10-06)

The gpu-worker's `dat-streaming` job (M3 Max, Seattle, `verification/gpu-results/RELEASE.streaming-gate-real-gpu-check-dat-streaming-59194bc-*`)
measured portal-space gates of **cold 21.07 s · Shoushi 10.62 s · warm 1.40 s**, against whole-DAT gates of 0.54 / 0.93 / 1.21 s.
The cloud's 1.35 s Holtburg gate (§6.2) had hit a warm Cloudflare edge. Seattle's edge was cold:

- An object that misses Cloudflare's edge costs about 0.4–0.6 s to TTFB from R2, whatever its size; an edge hit costs about 60 ms.
  Bandwidth is not the limit: 300 never-fetched objects land in about 2 s in parallel, and the 23.8 MB world pack downloads in 4–7 s.
- `DatClosure.ensure` walked level by level and awaited each whole level, so every dependent wave waited for its slowest
  edge miss.
- The store ran 48 fetches when Cloudflare advertises `SETTINGS_MAX_CONCURRENT_STREAMS = 100`. Chrome multiplexes one
  HTTP/2 connection per origin, so half the connection sat idle.

Fixes: the walk is pipelined (each file's children are requested as soon as it lands), and `DEFAULT_MAX_CONCURRENT = 96`.
Tests: `verify-dat-streaming-closure.ts` "the walk is pipelined …" (with one file held, more than 60 % of the closure lands; 15 of
473 on the old walker) and "keeps DEFAULT_MAX_CONCURRENT (96) fetches in flight" (48 on the old store).

A/B on the Mac's real GPU, same build except the two changes, with its own Vite (:3227) and bridge (:9097) on streamprobe1.
`--edge-bust` puts a per-run query on every object URL, so each run misses the edge, as a new player in a quiet region would:

| Gate (hold → released, cold edge) | Old: level waves, 48 | New: pipelined, 96 |
|---|---|---|
| Cold login at Holtburg (destination resident / whole gate) | 11.5 s / 15.1 s | 4.6 s / 8.3 s |
| Cold login at Shoushi (resident) | 13.0 s | 14.5 s (one run; the Holtburg-login run is the cleaner pair) |
| Teleport Shoushi → Holtburg | 8.0 s | 4.0 s |
| Teleport Holtburg → Shoushi | 9.7 s | 4.0 s |
| Warm login (OPFS) | 1.9–2.0 s | 1.1–1.6 s |

Each "whole gate" adds the queued-object pass (capped at 3.4 s) to the destination's own wait.

Request timing (`--req-log` writes `requests.json`) shows the new gate keeps 96 requests in flight whenever it has work.
TTFB is about 185 ms p50 and 370 ms p90. The gaps between saturated stretches are the remaining dependency chain
(bundle → GfxObj → Surface leaf → texture → palette). The next step is structural: a published per-landblock list of
closure leaves, which would collapse the chain to one wave. It would not reduce the request count (≈1,000 for a town
ring at about 520 requests/s).

Still not at whole-DAT parity for a cold first visit. A teleport to a place never visited costs about 2.5–4 s of gate on a
cold edge, against about 0.9 s with whole DATs. In exchange, a new player skips the 1.28 GB download and every revisit
comes from OPFS.

**Enabled on playwebac.com, 2026-10-06.** Jake: "i'd rather more portal time than a 1.3GB download just to get started."
Before the flip, `streaming-ab.ts` on main `6a55d9b8` (including ERA.dm-support part 2) PASSed 10/10. Then
`ACJS_DAT_SET_URL` was set on the web service and `6a55d9b8` deployed with `tools/deploy-railway.sh --ref 6a55d9b8 web`
(CI was out of minutes). `/version.json` reported `6a55d9b86afd` and `config.json` carried the `datSet` manifest URL.

The deployed site was checked with `streaming-ab.ts --prod https://playwebac.com/ --raw-from <the pre-flip run>`: the same
geared streamab1 script on the production build against a local bridge (`BRIDGE_ALLOWED_ORIGINS=https://playwebac.com`).
All 10 captures had 0 unresolved misses and 0 pending icons, and icons and the player model matched. The only differences
were Shoushi's townsfolk (jeweler, tailor, grocer …, each with a 16–17-item create list), whose clothing colors ACE
re-rolled when the landblock reloaded between the two sessions. They were fully textured, so `--raw-from` reports that
check without gating it. Rollback: unset `ACJS_DAT_SET_URL` and redeploy web.

### 6.8 Regressions Jake hit within minutes of the flip, and why the gate missed them (2026-10-06)

Streaming went live on playwebac.com. Jake played on it and reported problems within minutes:

| Symptom | Cause | Fix |
|---|---|---|
| Login / logout "purple bubbles" drawn as white squares | `CPhysicsObj::set_hidden` plays the object's PhysicsScriptTable Hidden (0x76) / UnHide (0x75) scripts (human table 0x34000004 → 0x33000331 → emitters 0x3200028C/8B → HW GfxObj 0x0100162D → textures). The gate's roots never named the table, so the emitter built with the untextured fallback quad. | `appearanceRoots` adds the CreateObject's `peTableId`, and `DatClosure` walks a 0x34 table's Hidden / UnHide scripts. |
| Other players' buff effects white | Any CreateParticle whose files had not streamed in drew white (no prefetch can cover every spell). | `PhysicsScriptPlayer` asks `emitterPending` (`StreamingDats.pendingFor`): if the emitter's info / HW GfxObj / surfaces / textures missed, the emitter is created when they land, about 1 RTT late, never white. |
| Skill icons missing in the Skills list | `getItemIconURL` missed, and `onStreamedFilesArrived` repainted inventory / magic / vendor … but not the character panel. | The character panel repaints on arrival, and main.ts prefetches every SkillTable pictogram once `datPrefetch` is wired. |
| A character-panel label in the wrong font | `loadFontRenderer` cached a Font whose glyph surface had not landed (a renderer without its spritesheet). Fonts were not UI art. | No cache entry on a miss. `layoutArtIds` includes 0x40 fonts and `DatClosure` walks Font → glyph + halo surfaces, so the UI prefetch fetches them. |

Why the A/B gate passed anyway:
- It never compared particles. Captures settle after effects finish, and the object signature is mesh materials only.
  Now `particleStats.whiteFallback` (ParticleSystem, on `globalThis.__acParticleStats`) is gated as `noWhiteParticles`:
  streaming may not draw more white-fallback systems than whole DATs.
- It captured the character panel's Attributes page only, never Skills. Now `07b-skills` is a capture.
- Text was invisible to it: DAT-font text is a `<canvas data-ac-run-text>`, which the icon signature skipped, and the
  wrong font only showed up in the (ungated) pixel diff. Now each text run's canvas pixels, or a browser-font fallback
  span, is part of the surface signature.
- Deployed `8d62a895` to playwebac.com, then `streaming-ab.ts --prod https://playwebac.com/ --raw-from <the fixed-build
  raw run>` PASSed all 11 captures, including 07b-skills, text runs and 0 white-particle systems. `--prod` adds
  `networker=0` because the net Web Worker takes its CSP from its own script response, which Playwright's bypassCSP
  cannot reach. Shared-object warnings were NPC clothing re-rolled by ACE between sessions, plus an hour's change in time of day.
- The lesson: the gate checked what had broken before (icons, armor) rather than everything a player sees in the
  first minute. Gestalt surfaces (effects, every panel page, text) need a check each.

### 6.9 Classic eras stream too (2026-10-06)

Jake: "ideally both would be streamed." Until now, picking a classic world (Doctide, Dekarutide, Seedsow, Snowreap) loaded
that era's whole DATs (about 1.1 GB). Each era now has its own streaming set, published with the same tool under the
era's name:

| Set | Source DATs | Objects / gzip |
|---|---|---|
| `classicace-infiltration-1.9` | dat-sets/classicace-infiltration-1.9 (portal 10006 / cell 10001 / local 10002, highres = EoR) | 50,971 / 530 MB |
| `classicace-customdm-1.60` | dat-sets/classicace-customdm-1.60 (portal 20044 / cell 20011 / local 20011, highres = EoR) | 51,459 / 531 MB |
| `classic-dereth-1.1` | portal + cell from dat-sets/classic-dereth-1.1; local + highres = EoR | 50,960 / 538 MB |

`npx tsx tools/publish-dats-r2.ts --dat-dir <dir> --set <name> [--stage-only | --execute]`. Byte-identical files with
end of retail dedupe in the bucket by hash, and each pointer carries its own `dats` headers (no EoL fallback).

Client: `RuntimeConfig.eraDatSets` (era id → pointer URL; `ACJS_ERA_DAT_SETS` in deploy/web/entrypoint.sh, origins added
to connect-src) and `datSetForEra()`. The era block in main.ts streams a classic era's own set when it has one and
otherwise falls back to whole DATs; end of retail's set is never used for another era. `?eraDatSet=<era>:<url>` points an
era at a locally staged set, and `?rawDats` turns every set off. `streaming-ab.ts --era <id> --set <pointer>` runs the
A/B in that era (point AC_BRIDGE at a bridge pinned to that era's server).

Live (local ClassicACE CustomDM on UDP 9200, its staged set served from localhost): login gate resident in 0.5 s
(557 objects), in world 14 s, 0 failures, 0 unresolved misses.

### 6.10 Stream-miss sweep: who reads before the files land (2026-10-06)

Jake hit an untextured chargen face on Doctide within minutes of classic streaming going live. The A/B gate had passed:
it checks that missed files *arrive* (`unresolvedMisses == 0`), never that the surface that missed them *redrew*, and it
covered end of retail only, never char select or chargen. The bug class: **a synchronous DAT read that misses, draws
or caches an incomplete result, and has no path back** (no `buildOrRebuild` / `pendingFor`, no miss-epoch guard, no
repaint on `onDatMissResolved`).

`tools/probe-stream-miss-sweep.ts` (DatStore's `window.__missTrace` probe hook gives each miss the stack that made
it) drives a cold streamed session: char select → every chargen step + Random → create → world → 15 panels →
three teleports → reload to char select, and writes `misses.json` (per phase, misses by first caller outside the DAT
layer) plus a screenshot per surface. Run 2026-10-06 against local servers for all four eras:

| Era | Chargen misses | World / panels / teleports | Notes |
|---|---|---|---|
| end of retail | 213 | 90 / 2 / 173 | chargen misses on EoR too — the BUG.classic-stream-chargen-blank repaint covers it |
| ClassicACE Infiltration | 1,219 (930 UI art) | 27 / 4 / 17 | chargen recovers (repaint); world + teleports drew correctly |
| ClassicACE CustomDM | 224 | 33 / 4 / 10 | as Infiltration |
| Classic Dereth (GDL-Classic) | 451 | — | the server refused Random's Viamontian (it allows heritages 1–3 only): not streaming |

Every screenshot matched whole DATs. The misses that had **no** way back, fixed with a test each
(tests/verify-streamed-miss-not-cached.ts, mutation-checked): PaperdollPoser (doll pose cached as missing → the live pose
all session; the sweep saw this miss on EoR and Infiltration), ExamineFigurePoser (same), GameUI.paperdollClickMap
(drops onto the paperdoll dead all session after one miss), the barber preview (kept a model built without its files).

Read but not reproduced (left as they are, with the reason): terrain materials / detail textures / sky objects built
once at world init (no terrain or sky miss in any era: the terrain packs hold them; a late fix would mean rebuilding
landblock meshes), dungeon cells after a portal-gate timeout or LRU eviction, and the splash / main font sheet null
cache (classic surface ids only; text drew correctly in every era). Sound misses (73 on entering the world, cold) are
not a bug: `SoundPlayer.fetchMissing` (main.ts) awaits the wave and plays it about one round trip late.

**Rule for new code:** anything that caches by DAT id takes `datMissEpoch()` before and skips the cache write unless
`noDatMissSince()`; anything that draws once from DAT data either goes through `buildOrRebuild` / `pendingFor` or is
repainted from `GameUI.onStreamedFilesArrived`. Run the sweep for every era before turning a set on.

### 6.11 The AC1999 era streams too: two sets, one interface and one world (2026-10-06)

The `ac1999-retail` era is the 1999 world (its own `portal.dat` + `cell.dat`) under the end-of-retail interface. It used
to load every DAT whole, including the ~935 MB end-of-retail interface portal. Now (`era/EraBoot.ts eraStreamPlan`):

| Side | Source | Download |
|---|---|---|
| Interface (interface portal, language, highres) | end of retail's `datSet`, opened with `scope: 'interface'` | the same char-select set end of retail boots (manifest + boot + local + skeleton, ~6 MB gz), then the `world` pack (24 MB gz: GameUI preload art, chargen art, portal space) and the UI art behind char select. The `terrain` pack and every landblock bundle are never fetched. |
| World (world portal, cell) | `eraDatSets['ac1999-retail']` when published: a world-only set, `scope: 'world'` | manifest 0.2 MB + skeleton 0.4 MB at boot, terrain 3.5 MB behind char select, then leaves and bundles on demand (54 MB gz in all) |
| World, no set published | the whole 1999 files (`eraAssetBases` / `<assetBase>/sets/ac1999-retail/`, cache namespace `ac1999-retail__`) | 99.6 MB + 45.1 MB once, then the OPFS cache |

Mechanics, all shared rather than 1999-specific:

- main.ts keeps two handles. `streamingDats` serves the interface (splash, layout art, UI sounds, highres) and
  `worldStreamingDats` the world (closure walker, landblock streamer, rebuild-on-arrival, the portal-space gate, icon
  prefetch, world sounds). They are the same object for end of retail and the classic eras. `worldStreamingDats` is null when
  the world is whole DATs.
- `CellGate` takes an `interfaceClosure`. The login gate's HUD-art roots close over it, while the destination ring and the
  player's model close over the world closure. With one set the two are the same closure and nothing changes.
- `SoundPlayer.fetchMissing(id, src)` fetches from the side the Wave is missing on.
- The patch meter (gmDataPatchUI) runs over everything: whole-DAT bytes plus each set's boot bytes. A second Begin
  re-announces the running total.
- The world set is built THROUGH dat-parser era1999's overlay, so it holds end-of-retail formats and the client translates
  nothing it streams. Ac1999World then wears `translatedBase` overlays, which translate only the server's 0xF7B7 patches (1999
  bytes) and pass every other file through. The one file the client still reads untranslated, CharGen (Chargen1999's text ids),
  travels as a copy under 0x0E00F002 (`AC1999_UNTRANSLATED_COPIES`). `DatClosure` walks 0x07 textures like 0x06 (ACE's Texture
  range is 0x06–0x07; the 1999 SurfaceTextures name synthetic 0x07 textures).
- With a world set published, `planEraDats` probes no hosted whole files for the world.

Build, serve, publish:

```
npx tsx tools/publish-dats-r2.ts --overlay ac1999 --dat-dir dat-sets/ac1999-retail                 # dry run (~6 s)
npx tsx tools/publish-dats-r2.ts --overlay ac1999 --dat-dir dat-sets/ac1999-retail \
  --stage-only --stage dat-sets/stream-stage/ac1999-retail-world-p102-c67                         # 12,264 objects, 54 MB gz
ln -s ../dat-sets/stream-stage/ac1999-retail-world-p102-c67/v1 dat/v1                             # dev: Vite serves /v1/… from dat/
# dev URL: …/?era=ac1999-retail&datSet=https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json
#          &eraDatSet=ac1999-retail:/v1/sets/ac1999-retail-world-p102-c67.json
UPLOAD_KEY=… npx tsx tools/upload-stream-set-r2.ts <worker url> dat-sets/stream-stage/ac1999-retail-world-p102-c67
                                                       # Jake's credentials (§4); the stage dir's name is the set name
#   or: npx tsx tools/publish-dats-r2.ts --overlay ac1999 --dat-dir dat-sets/ac1999-retail --execute   (rclone "r2" remote)
# then ACJS_ERA_DAT_SETS='{…,"ac1999-retail":"https://dats.playwebac.com/v1/sets/ac1999-retail-world-p102-c67.json"}'
```

A server's login DAT push can ride the pointer as a seed (`serverSeeds`, BUG.ac1999-slow-login-ddd-push;
docs/ac1999-support.md). Build it, check it byte for byte, then stage it into the live pointer, changing nothing else:

```
npx tsx tools/ac1999-dat-seed.ts snippet          # paste into DevTools at char select (fresh profile): downloads ac1999-push-capture.json
npx tsx tools/ac1999-dat-seed.ts build --capture ~/Downloads/ac1999-push-capture.json --out dat-sets/ac1999-seeds/ac1999.acss
npx tsx tools/ac1999-dat-seed.ts compare dat-sets/ac1999-seeds/ac1999.acss <another source>   # a capture, a seed, or server-level DATs
npx tsx tools/publish-dats-r2.ts --seed-only https://dats.playwebac.com/v1/sets/ac1999-retail-world-p102-c67.json \
  --server-seed ac1999=dat-sets/ac1999-seeds/ac1999.acss --stage dat-sets/stream-stage/seed/ac1999-retail-world-p102-c67
UPLOAD_KEY=… npx tsx tools/upload-stream-set-r2.ts <worker url> dat-sets/stream-stage/seed/ac1999-retail-world-p102-c67
```

A full republish of the 1999 set takes the same `--server-seed`; without it the new pointer lists no seeds.

The 1999 world shares no objects with end of retail (every file is a 1999 file), so `--known` saves nothing here.
Tests: `tests/verify-ac1999-world-set.ts` builds the real set into a temp stage and drives DatStore, StreamingDats,
Ac1999World and Chargen1999 over it. The EraBoot, StreamingDats, CellGate and SoundPlayer cases live in their existing
test files.

### 6.12 Area packs and the whole-hold download bar (RELEASE.streaming-area-packs, 2026-10-08)

Jake: "are the download bars at portal time faithful to retail? i dont remember them, but they also seem to take forever".

**The bar is retail; its count and its span were not.** It is gmPowerbarUI's DDD mode (`RecvNotice_RuntimeDDDStatus`
@ 004da5c0, caption `ID_Powerbar_DDDModeText` "Download: X / Y"). Retail raised it only while `CellManager` waited for cells
missing from the install (`PreFetchCells` @ 00455820), which with a fully patched cell.dat was almost never, so few players
remember it. Ours shows it on nearly every portal into a new area because the DATs stream. Two things diverged:

- Unit and formula. Ours counted gate steps (landblocks + 1 + 1). Retail counts what is still missing: the first count is
  the total (done 0); later counts raise the total if more is missing and report total − missing; a zero count sends nothing;
  `CheckPrefetchStatus` @ 00455be0 re-checks every 5.0 s; clearing sends (false, 0, 0). `PrefetchStatus`
  (PortalSpaceGate.ts) is that, over `DatStore.activeLoads` (object downloads at critical / prefetch priority).
- Span. The bar ran only for the destination prefetch. A cold login first waits for the world packs, and every hold ends
  with the queued-objects pass (up to 3.4 s), both with the tunnel up and no bar. `PrefetchStatus` now begins when the
  hold begins and ends when it releases (or on disconnect). The queued-objects pass runs at critical priority (it is the
  gate) and logs what it still needs by type.

The tunnel's 3–7 s after the hold releases is retail's own exit (`EndTeleportAnimation` @ 004d65a0: ≥ 2 s more tunnel, up
to 5 s waiting for the loop's end, 1 s zoom out, 1 s zoom in) and stays.

**"Take forever" was the request count.** Request timing on a cold teleport to Shoushi (real GPU, `--edge-bust`,
2026-10-08 at 05:5x UTC): 834 requests in 13.0 s. Under a burst of ~96, an R2 edge miss took 1–3.4 s to first byte even for a
500-byte object, and the dependency chain left 1–1.5 s gaps with nothing new to start. The same objects two hours later
took 1.9 s: R2's cold latency swings by several times, so only interleaved A/B runs compare (`tools/streaming-gate-ab.sh`: base and new
alternating, same account each, fresh profile and edge-bust tag each run).

**Area packs.** `tools/lib/area-packs.ts` runs the client's own closure walk (`DatClosure.edges` over a local-DAT
`ClosureStore`) for every landblock: its terrain, bundle (buildings, statics, EnvCells), scenery, and the world DB's static
objects plus their generators' direct spawns (`tools/lib/world-db-roots.ts`: Setup / MotionTable / PhysicsEffectTable).
A leaf more than 512 landblocks need (trees, rocks: 790 leaves, 7 MB gz) goes to one **common pack** loaded in the
background after the ui pack; every other leaf goes to the pack of each **4×4-landblock tile** that needs it. The pointer
names an area index ("ACAI", DatSetFormat.ts) as `areas`; older clients ignore the key. `DatClosure.ensureLandblock`
requests the tile's pack alongside the bundle, so a 3×3 destination ring costs 1–4 pack requests instead of hundreds of
leaves; the walk then finds them resident. A failed or absent area pack falls back to leaf-by-leaf.

| Choice measured (`measure` runs, EoL) | per-ring objects | ring MB raw | storage |
|---|---|---|---|
| per landblock, no common | 9 | 13–47 (duplicated) | 3.7 GB+ raw |
| per landblock + common (> 8 blocks) | 9 | ~1 + 86 MB common | common too big to send everyone |
| 8×8 regions + per-landblock + common > 1024 | 7–9 | 15–16 | 4.1 GB raw |
| **4×4 tiles + common > 512 (shipped)** | **1–2** | **7.5–10** | **2.9 GB raw, 1.5 GB gz** |

Generator spawns two levels deep doubled the bytes; one level (what actually spawns) is kept. The planner agrees with the
client exactly: `verify-dat-streaming-closure.ts` "area packs carry exactly the leaves the gate's walk fetches" (Holtburg,
real DATs).

**Live (2026-10-08).** Objects for all five sets went up with `--no-pointer` (EoL 1,426 objects; classic Infiltration
1,166, CustomDM 976, Classic Dereth 1,161; AC1999 world 593; content addressing deduped 412). Then a fair A/B: the same
client, the live pointer vs the staged one served by `stage-proxy.ts --pointer-only` (every object from cold R2,
`--edge-bust`), three alternating rounds on the real GPU:

| Round | Login: live → areas | Teleport: live → areas |
|---|---|---|
| 1 | 7.44 → 5.19 s | 3.59 → 2.73 s |
| 2 | 5.94 → 4.40 s | 3.54 → 2.79 s |
| 3 | 6.20 → 4.58 s | 3.24 → 2.40 s |

About 28 % off cold logins and 25 % off first-visit teleports, measured while R2 was fast. The destination's own
downloads fell from ~1,050 requests to 58 at login and from ~300 to 10 per teleport. Bytes rose (7.5 → ~12.9 MB at login,
~1 → 4–5 MB per teleport): that is the trade, and on a slow connection the bytes weigh more. The queued-objects pass
(1.3–2.2 s: NPC clothing palettes and icons the world DB can't predict) is what's left. Warm logins are unchanged
(1.2–1.6 s). All five pointers were then written (live + `areas`, verified byte-for-byte otherwise); `streaming-ab.ts`
PASSes against the live set. Rollback: rewrite a pointer without `areas` (clients fall back to leaf by leaf).

The gate needed two fixes on the way, both false positives: its object signature counted hidden meshes (a door's `lod_1`
holder, built once when the camera crossed its range and hidden since, so whether it existed depended on the camera's
path), and it compared other players' characters (another session's character was casting between the two runs). It
now signs what `traverseVisible` reaches and skips player guids other than our own (checked by playerModelMatches).

**Slow connections (2026-10-09).** The same A/B at 10 Mbit/s (`probe-dat-streaming.ts --throttle-mbps 10`, 2 rounds):
cold login without / with area packs 18.6, 15.2 s / 17.3, 15.4 s (even: the world packs every new player downloads
dominate), first-visit teleports 9.2, 8.0 s / 7.4, 6.9 s (about 15 % faster with them). The extra bytes do not cost a
slow line more than the extra requests did.

**The queued-objects tail (2026-10-09), tried and dropped.** Waiting for icons only of what the player carries (not NPCs'
or doors') changed the pass's roots by a few percent and its time not beyond noise (2 interleaved rounds: 2.4–2.6 s at
login, 1.5–1.7 s per teleport either way), so it was not shipped. What fills the tail is `settleBurst` waiting for the
server's CreateObject burst to go quiet (up to 1.5 s by design) and NPC clothing (ObjDesc palettes / texture changes the
world DB cannot predict, so the area packs don't carry them).

**Dungeon arrivals hold for their own landblock (2026-10-09).** Playing playwebac.com as a new player (Mistwood), the
first login held for 21.8 MB: the training academy (cell 0x8C0401AD) is a dungeon, and the gate fetched the 3×3 landblock
ring, whose neighbours are other dungeons in three other tiles (11–19 MB each; the academy's own tile is 7.2 MB, the same
as the academy landblock alone). Retail's `CellManager::PreFetchCells` sends an EnvCell to `CEnvCell::PreFetchCells` (the
cell and the cells it sees), never to the landscape grid. `CellGateOptions.sealedInterior` (an EnvCell whose flags lack
SeenOutside) now limits the hold to the destination's landblock; building interiors that see outside keep the ring.

Publishing to a live set without touching anything else: `publish-dats-r2.ts --areas-only <live pointer url>` reads the
live boot / world / ui packs (this checkout's pack lists had moved on since the 2026-10-04 publish: boot 242 vs 81 files)
and stages only the area objects plus the live pointer with `areas` added. Classic sets use `--world-db none` (their
servers run other world DBs); the 1999 world adds `--overlay ac1999`. Upload: `tools/r2-uploader/README.md` (objects
with `--no-pointer` first, measure through `tools/stage-proxy.ts --pointer-only`, then the pointer).

## Reproducing

- `npx tsx tools/dat-access-sim.ts`: tables in about 4 s. It never reads a whole DAT and needs only `dat/` + `dat/world.sqlite`.
- `AC_BASE=http://localhost:<your vite>/ AC_BRIDGE=ws://localhost:<your bridge> AC_ACCOUNT=<fresh account> npx tsx tools/probe-dat-streaming.ts [--teleports holtburg,shoushi] [--raw] [--gpu] [--edge-bust] [--req-log]`:
  the §6.2 live numbers (cold → teleports → warm), screenshots + `result.json` into `--out` (default `verification/dat-streaming/live`).
- `npx tsx tools/probe-stream-miss-sweep.ts --base http://localhost:<your vite>/ --bridge ws://localhost:<bridge> --account <fresh> --out <dir> [--era <id> --set <pointer>]`: §6.10, misses by caller per surface + screenshots (EoR: omit `--era`; `--set` defaults to the EoR pointer).
- `npx vitest run tests/verify-dat-streaming-store.ts tests/verify-dat-streaming-closure.ts tests/verify-dat-streaming-rebuild.ts tests/verify-portal-space-gate.ts tests/verify-dat-streaming-charselect.ts tests/verify-runtime-ddd-status.ts`.
- `AC_BASE=http://localhost:<your vite>/ AC_BRIDGE=ws://localhost:<your bridge> AC_ACCOUNT=streamab1 npx tsx tools/streaming-ab.ts`:
  the §6.5 regression gate (≈ 12 min; sheets + `verdict.json` into `verification/dat-streaming/ab/<stamp>/`). Must PASS
  before `ACJS_DAT_SET_URL` is set on playwebac.com.
- **Cloud sessions:** the container's Chromium does not trust the agent proxy's CA, so it cannot fetch
  `dats.playwebac.com`. Stage the set locally (`publish-dats-r2.ts --stage-only --stage <dir>`, about 10 min, 0.7 GB; the
  manifest hash matches the published set) and serve `<dir>` on localhost with CORS `*`, then pass `--set
  http://localhost:<port>/v1/sets/<set>.json` to the probe and to streaming-ab. Pre-create the probe accounts as admins
  (`echo "accountcreate <name> <name> 5" > /opt/ace-server/console.fifo`), or `@teleloc` is ignored.
- `npx tsx tools/publish-dats-r2.ts`: the dry-run plan in about 1 minute. `--stage-only --stage <dir>` writes the objects without uploading. This was validated on 2026-10-04: 51,793 objects, the manifest and boot pack parsed back correctly, and the stage was deleted afterwards.

### 6.12 A new player's first visit, measured (2026-10-08)

A fresh profile on playwebac.com (real GPU, `tools/live-drive.ts`) reached the login screen **2 min 13 s** after opening the page:
char-select set resident at 47 s (10.6 MB, about 0.23 MB/s), then about 86 s on "Patching Done!" before the launcher, and the
world packs landed 55 s after char select. The same cold profile shape, re-run against the same deployment after the edge
had served those objects once:

| Run | Login screen | Post-patch → launcher |
|---|---|---|
| playwebac.com, first visit after the upload | 133 s | ≈ 86 s |
| Vite + the production set, real link, warm edge | 9 s | 0.3 s |
| playwebac.com, warm edge, throttled to 2 Mbit/s (`live-drive --throttle 2000`) | ≈ 47 s | ≈ 6 s |

No long tasks over 300 ms in any run, so the main thread was never the wait. A thin link alone does not reproduce the 86 s;
the first visit after an upload met a cold edge (§6.7: each miss is 0.4–0.6 s to TTFB, and the boot's small reads queued
behind 96 background world-pack fetches that were all missing too). The first player in a region after each upload pays it.
Client side, Create Character no longer looks dead during the world-pack wait: it raises retail's Please Wait
(BUG.chargen-silent-wait-for-world-art). Throttle the production page, not Vite: a dev page loads its source modules one by
one over the throttled link (one took 27 s), which production's bundle never does.

### 6.13 3D previews hold their last whole figure; chargen choices prefetch (UX.chargen-preview-no-placeholder, 2026-11-01)

Rebuild-on-arrival (§6.5) fixes a figure *after* it drew incomplete. For a preview the player is looking straight at, that
is the bug: every chargen change flashed a white face for about a second (Jake, playwebac.com). The rule for a preview
that **replaces** a figure already on screen: build off-screen, and swap only a build that read every file.

- `ui/PreviewBuildHold.ts`: a build with no DatMiss epoch move swaps in the caller's frame (whole DATs: no change). A build
  that missed is dropped and retried on each arrival batch; a newer request supersedes it; a 1.75 s cap, anchored at the
  oldest unresolved request, shows the latest build as it is, and later arrivals keep rebuilding it (bounded) until it is
  complete. Its misses are subtracted from GameUI's chargen repaint flag (the hold retries itself). Used by the chargen
  appearance + summary views, the barber, and the own player's ObjDescEvent (the world figure and the paperdoll).
- The first miss of a held build fetches that appearance's whole closure at Critical priority (`chargenAppearanceIds`),
  so the retry costs one wave instead of one dependency level (GfxObj → texture → palette) per arrival batch.
- `models/ChargenPrefetch.ts` warms, at Background priority with one closure in flight, the focused heritage + sex's
  every Appearance option and then every heritage + sex's base figure (`UIHost.prefetchPortalFiles` →
  the world set's `DatClosure.ensure`). Root a Setup on its **part GfxObjs**: a Setup root walks its motion table's
  default-style animations (~3 MB gz for a human) that a preview never plays.
- Bytes: `npx tsx tools/measure-chargen-prefetch.ts` (closure leaves, gzip -6, local DATs). End of retail / Dark Majesty:
  3.45 MB gz mean per heritage + sex (max 6.45 MB, Undead), all base figures 3.70 MB; AC1999 ≈ 0.32 MB per heritage + sex.
- Still draw-then-rebuild (not previews): other creatures' appearance changes in the world.

### 6.14 Effect leaves ride the common pack (STREAM.spell-projectile-first-use, webac#16 item 4, 2026-11-03)

A creature's first spell projectile (the 1999 Banderling Captain's Whirling Blade, Setup 0x020003FC) flew for ~430 ms as a
3-triangle partial mesh: its GfxObjs and textures were fetched at the projectile's CreateObject, one RTT per dependency
level, and later casts were fine. The client cannot know a creature's spells or ammunition ahead of the first cast, so
the fix is in the sets: the **effect leaves** go in the common pack, which every client already loads in the background
at boot (`StreamingDats`: after the ui pack, Background priority, so no gate or login waits for it) and keeps for the
session (`DatStore.addLeafPack`, not evictable). No client change.

- Roots (`tools/lib/effect-leaves.ts`, all from the set's own data): every ProjectileSpell (33), Missile (4) and Ammunition
  (5) weenie's Setup / MotionTable / PhysicsEffectTable / SoundTable (every Wave) / icons (Icon, IconOverlay,
  IconOverlaySecondary, IconUnderlay: `GameUI.itemIconFileIds` prefetches them at every CreateObject), from the world DB
  the era's server runs (ACE's `dat/world.sqlite` for end of retail and the classic sets, whose servers run the retail
  weenies; the AC1999 SQL tree for 1999); every PhysicsScriptTable in the portal DAT with **every** script (caster /
  target spell effects, level up, blood and hit splats, portal storm, fizzle) and their Sound hooks' Waves, not only the
  Hidden / UnHide pair the arrival walk takes; and every Animation's CreateParticle / CallPES hook emitters (cast
  gestures, breath attacks). The walk is `DatClosure.edges`.
- First live check (lead, AC1999 staged pointer, 2026-11-03): Whirling Blade drew 27 triangles from its first frame. The
  leaves still fetched at the Captain's Shockwave / Whirling Blade CreateObject were four Waves (0x0A000251 / 252 / 26D /
  26E, their SoundTables' launch and impact sounds) and the projectile icon 0x06001066 — no visuals. Hence the sound
  tables and icons above.
- Sizes added to each live common pack. Waves barely compress (3.7 MB raw → ~3.2 MB gz in end of retail), so each set is
  staged twice: with Waves (`verification/dat-streaming/effects-staged/`) and without (`--no-effect-waves`,
  `verification/dat-streaming/effects-staged-nowaves/`; a first sound then plays ~1 RTT late, as before):

  | Set | leaves added (of them Waves) | common gz before | with Waves | without |
  |---|---|---|---|---|
  | eol-p2072-c982-h497-l994 | 742 (52) | 7.0 MB | 11.5 MB | 8.3 MB |
  | classicace-infiltration-1.9 | 751 (52) | 1.5 MB | 6.0 MB | 2.9 MB |
  | classicace-customdm-1.60 | 754 (52) | 1.3 MB | 5.8 MB | 2.6 MB |
  | classic-dereth-1.1 | 751 (52) | 3.6 MB | 8.1 MB | 5.0 MB |
  | ac1999-retail-world-p102-c67 | 271 (28) | 0.7 MB | 1.8 MB | 0.9 MB |

- Live sets: `npx tsx tools/publish-dats-r2.ts --effects-only <live pointer url> [--dat-dir <that set's DATs>] [--overlay ac1999]
  --stage <dir>/<set>` stages the new common pack (the live one's files byte-for-byte plus the effect leaves, each checked
  against the live manifest's hash), a new area index naming it with every live tile unchanged, and the live pointer with
  only `areas` changed (serverSeeds kept). A full publish (`main` / `--areas-only`) puts the effect leaves in the common
  pack too (`planAreas` `commonExtra`: never in a tile). `--effect-weenies <world.sqlite | SQL dir | none>` overrides the roots.
- Objects uploaded 2026-11-03 (immutable, content-addressed; nothing live references them until a pointer flips; each
  set's common pack + area index):

  | Set | with Waves | without Waves |
  |---|---|---|
  | eol | `aef431f3a5fbe543` + `1fcb51b12335ea60` | `bb10599322f0c4b8` + `5fa807c90f078cc0` |
  | classicace-infiltration | `1d03cf8a4e425107` + `22419130a8061ded` | `c5dfa0ea233ff805` + `53fab7ec36e9cb32` |
  | classicace-customdm | `68fdad7ab393cdb1` + `685be9c609830777` | `378d419ef3ae2bd9` + `b149d145561caf4c` |
  | classic-dereth | `bc5ee7754d436691` + `fd80972ae85d78d5` | `cb64e21f26754586` + `e58b906383b017a9` |
  | ac1999 world | `be04228f3b6c05eb` + `8a12067f98825784` | `ed166cfbc6f836db` + `57c60925e9b765c8` |

  The first upload's objects (no Waves or icons; e.g. eol `23ade3187c271f17` + `eb79da46662b6912`) are superseded and
  unreferenced.
- The flip is the pointer upload, per set: `npx wrangler r2 object put webac-dats/v1/sets/<set>.json --file
  verification/dat-streaming/effects-staged[-nowaves]/v1/sets/<set>.json --content-type application/json --cache-control "public,
  max-age=60, must-revalidate" --remote`, after checking the live pointer still equals the staged one minus `areas` (a
  republish since would be lost). Rollback: upload the previous pointer (same command, old `areas`: the old index and
  common pack stay in the bucket).
- Test before the flip: `npx tsx tools/stage-proxy.ts verification/dat-streaming/effects-staged[-nowaves] --pointer-only` and load
  the game with `&datSet=http://localhost:9177/v1/sets/<set>.json` (1999: `&eraDatSet=ac1999-retail:http://localhost:9177/v1/sets/ac1999-retail-world-p102-c67.json`).
- Tests: `tests/verify-effect-leaves.ts` builds every effect weenie's Setup and every table's emitters with the real
  renderer over a DatStore whose only portal leaves are the common pack (loaded through `ensureCommonPack`), with no miss,
  in end of retail and AC1999 (Whirling Blade whole), and the negative without them.
- Not covered: Waves of animations' Sound hooks (creature attack / footstep sounds), which stream on first play (§2.3).

### 6.15 Slow links: one network link, background yields to gates, stalled first bytes (2026-11-03)

Follow-ups from the live check of §6.14 / STREAM.action-held-for-animation, all three eras, production builds
(`VITE_ACJS_URL_OVERRIDES=1 npx vite build` served locally: a Vite dev page loads hundreds of modules over the throttled
link), cold profiles, CDP `Network.emulateNetworkConditions` from page load, the agent auto-login (Enter at once, the
worst case: a real new player spends minutes in chargen while the packs land). Scripts: the session scratchpad's
`t1/login.ts` (per-request timings + a 500 ms sampler of each store's LinkMeter / limiter / gate), `t1/ab.sh` (interleaved).

**The 265 s AC1999 login was the probe, not the client.** Its URL carried `eraDatSet` but no `datSet`, so on Vite (no
config.json) the end-of-retail interface loaded whole: `[AC:DatCache] portal.dat: downloading from network`, 884 MB of
client_portal.dat at 4 MB/s (reproduced: 235 s, the same URL on a production build). Production's config.json always names
`datSet`. Probe URLs for AC1999 and the classic eras must pass both (`&datSet=<eol pointer>&eraDatSet=<era>:<set>`).

**Not a regression from 2026-11-03.** 150 ms / 10 Mbit/s, the build at 7caa236a7 with the pre-flip pointers (served by a
Playwright route) vs main 3f8d72d99 with the live ones: AC1999 51.8 → 52.8 s to the world, end of retail 63.2 → 63.2 s,
Dark Majesty 56.6 → 56.7 s. The effect leaves grew each common pack (end of retail 6.96 → 8.33 MB gz, AC1999 world
0.69 → 1.85, CustomDM 1.30 → 2.64), but the login does not wait for it.

**Where the time goes (10 Mbit/s).** Bytes before the world: end of retail ~67 MB (boot 10.6, world pack 23.4, terrain 3.5,
ui 1.4, the gate's area packs and leaves ~8, the common pack 8.3), AC1999 ~48 MB (its interface world pack is the same
23.4 MB). At 1.25 MB/s that floor is ~54 s / ~38 s; the rest is the login itself and the queued-objects pass, which hits
its 3 s cap on every era at this speed. What was ours to fix:

1. **Background work shared the link with the gate.** The limiter never pre-empts running work, and the common pack
   (Background) starts after the ui pack, so on an immediate login it began ~2 s before the gate and downloaded beside
   the gate's own area packs for 14 s (end of retail: common 39.3 → 53.3 s, gate 41.2 → 54.9 s). Chrome's throttling,
   like a real last mile, splits bandwidth between streams whatever their priority hint. Now `NetworkLink.holdBackground`
   (main.ts, from the hold's start to `afterRelease` or a disconnect): background downloads with more than
   ~1 s / 256 KB to go stop and queue again (their bytes so far are fetched again later: `stats.yieldedBytes`), and none
   start while held. Background also starts only on an idle link (no critical or prefetch fetch running), so the AC1999
   world's common pack no longer splits the link with the interface world pack the login waits for.
2. **Two sets, two limiters.** AC1999 boots two DatStores; each had its own 96-fetch limiter and LinkMeter (192 streams on
   one HTTP/2 connection, a critical-first rule blind to the other set's gate, and a meter that saw half the link: the
   world store marked a 10 Mbit/s line slow, rate 300 KB/s with 1.4 MB in flight, while the interface's world pack took
   the bandwidth). `NetworkLink` is now the page's one link (main.ts `streamNetwork`, passed to every `openStreamingDats`).
3. **A stalled first byte held a gate with nothing else to fetch.** About one object per cold gate took 3-16 s to its
   first byte from dats.playwebac.com (a 22 KB leaf: 16.0 s, the end-of-retail gate idle at 36/37 for 13 s). A fetch with
   no byte after `FIRST_BYTE_STALL_MS` (4 s) while the link delivered ≥ 64 KB to others and is not slow is now asked for
   again, once per object, not counted as a retry (`stats.stalls`).

Two interleaved rounds, 150 ms / 10 Mbit/s, main → fix (round 1 without the meter and Critical-style-prefetch changes
below, round 2 the final build):

| Era | in world | gate (destination) | queued-objects pass |
|---|---|---|---|
| End of retail | 63.3 / 63.2 → 60.5 / 59.7 s | 14.3 / 14.3 → 10.8 / 10.0 s | capped 3.4 s in all four |
| Dark Majesty (CustomDM) | 56.4 / 56.5 → 56.1 / 56.1 s | 7.5 / 7.5 → 7.1 / 7.1 s | capped 3.4 s in all four |
| AC1999 | 52.8 / 52.7 → 52.7 / 52.3 s | 2.0 s in all four | ~2.05 s, resident |

(one earlier run of the yield-only build: end of retail 59.8 s, gate 10.3 s; one with the 16 s first-byte stall: gate
24 s, the reason for item 3.) Dark Majesty's and AC1999's common packs are small (2.6 / 1.9 MB), so their gates gain
little; AC1999's login is the interface world pack. At 200 ms / 2 Mbit/s (end of retail, one pair): 264.0 → 248.9 s to the
world, gate 59.6 → 45.5 s; char select at 65 s and the world packs at 193 s in both (42 MB of packs at ~0.24 MB/s).

**What is left is bytes, and the next cut needs a republish.** A cold immediate login waits for the 23.4 MB world pack
(§6.6: GameUI's preload art, chargen's art, portal space; ~100 s at 2 Mbit/s, ~19 s at 10). It is one object, so the
client cannot take part of it; splitting it (what the login HUD reads vs chargen and the rest) means repacking and
uploading the sets, which takes Jake's R2 credentials (§4, tools/r2-uploader/README.md). A new player rarely sees it:
the packs land while they make a character. The rest of a slow-link login is bytes: the 23 MB world pack is GameUI's preload art,
chargen's art and portal space, which every era's login waits for (§6.6).

**Held actions (STREAM.held-action-starved).** The style prefetch asked for a style's animations at Prefetch, and the
limiter holds Prefetch while any critical load runs or waits; in a fight on a high-latency link (1 s added to every object
fetch) that was nearly always, so the Banderling Captain's swing 0x03000570, asked for on entering SwordCombat at 4.9 s,
was still missing at 9.9 s: held, then dropped after `ACTION_ANIMATION_HOLD_MAX_S`. The held miss did promote the queued
request to Critical (`residentSource.get` → `noteMiss` → `request(Critical)` → `promoteFile` → `Ticket.promote` →
`requeue`; pinned in tests/verify-stream-network-link.ts), but from 1.5 s before the drop, one 1 s+ round trip behind a
busy critical queue. Two causes, both fixed:

- `storeAnimationPrefetch` now asks at Critical: the files are needed within the style change's own link and are few
  (24-40 per style).
- **The LinkMeter took latency for a slow link** (STREAM.link-meter-latency). Its windows were wall-clock seconds from a
  fetch's start, so a second spent waiting for first bytes read as a saturated slow link, and the flag only cleared on a
  ≥ 512 KB/s window, which light in-world traffic never makes. With 1 s on every object fetch (4 MB/s, 150 ms) it read
  slow in 154 of 159 in-world samples (main), which caps the bytes in flight at the 32 KB floor: every fetch bigger than
  that waits for the one running. Windows now count body time only (while some fetch's body is arriving): 0 of 159.

Same run after (AC1999, 1 s on every object fetch from entering the world): the Captain's SwordCombat files were asked
for at Critical on entering the style at 6.53 s and landed at 7.72 s (the 1 s delay + the round trip); the link misses at
7.67 s resolved 48 ms later; no hold reached its cap, no action dropped, slow-link samples 0. End of retail (drudge fight)
and Dark Majesty (CustomDM drudge) the same way: no give-ups, slow samples 0 of 86 / 0 of 107.

**The "In Portal Space - Please Wait..." line 2 s into the world is retail.** gmSmartBoxUI::UseTime @ 004d6e30 posts it at
every roll segment in TAS_TUNNEL_FADE_IN / TUNNEL / TUNNEL_CONTINUE / TUNNEL_FADE_OUT, and gmSpewBoxUI's item lives 5 s
(`SPEW_ITEM_LIFETIME_MS`): the last line posted before the zoom-out outlives TAS_OFF by about 1.2-4 s
(tests/verify-portal-space-retail.ts pins no post once the tunnel is torn down).

Tests: tests/verify-stream-network-link.ts (shared limit, cross-store critical-first, idle-only background, the gate's
yield / keep-small / promoted cases, the stall retry and its slow-link negative, the style prefetch at Critical, the held
miss promoting a queued prefetch).

### 6.16 The login waits for its own part of the world pack (STREAM.login-pack-split, 2026-11-03)

§6.15 left one cut: every cold login that enters at once waited for the whole 23.4 MB interface `world` pack (one object,
so nothing could take part of it). What is in it, by the access simulation's phase that first reads each file
(`tools/dat-access-sim.ts --boot-set` now writes these as `worldPhases` in `pack-sets.json`; gzip -6, end of retail):

| Phase | files | gz | what |
|---|---|---|---|
| world-init | 77 | 17.8 MB | the terrain materials: 30 land textures 512×512 ARGB (fmt 21, 0.3-0.8 MB gz each), alpha / road maps, their SurfaceTextures |
| gameui-preload | 321 | 5.1 MB | GameUI's preload list: 3.9 MB of it is the 13 heritage portraits (265×451) and the 6 attribute overlays, drawn only by chargen; the rest HUD frames, toolbar / inventory / paperdoll art |
| chargen | 143 | 0.5 MB | the chargen preview's base figures, palettes, clothing (also every human NPC's) |
| portal-space | 12 | 0.04 MB | the tunnel |

An AC1999 login never reads the 17.8 MB: its landscape comes from the 1999 world set (§6.11). No login reads the portraits.

**The split** (`packages/renderer/src/dat/streaming/WorldSplit.ts`, one rule for the publish tool and the client):

- `worldLand`: the world-init files plus the set's own RegionDesc TexMerge closure (`tools/lib/world-split.ts regionTerrainLeaves`).
- `worldChargen`: art that only the character-creation layouts draw (`CHARGEN_LAYOUTS`: chargen_master 0x21000038 and its
  pages 0x21000046-0x2100004c), closures included, and no other layout draws: the portraits, the chargen backdrop
  0x06004d26, the attribute overlays, the start map.
- `worldCore`: everything else. A first cut also moved the chargen phase's models into the chargen part; the first live
  run then read 0x01001860 / 0x01001864 (human base-figure GfxObjs) at the login for an NPC, so models stay in the core.

| Set | world (whole) | worldCore | worldChargen | worldLand |
|---|---|---|---|---|
| eol-p2072-c982-h497-l994 | 555 files 23.4 MB | 453 / 1.5 MB `f1d38a110003f1d5` | 25 / 4.1 MB `cb8fd1d7c0fa46eb` | 77 / 17.8 MB `90b3d269dcea2733` |
| classicace-customdm-1.60 | 552 / 22.1 MB | 450 / 1.5 MB `124140827e71d381` | 25 / 4.2 MB `52b8621b080190da` | 77 / 16.4 MB `a9b87681ee1f2b2b` |
| classicace-infiltration-1.9 | 552 / 22.1 MB | 450 / 1.5 MB `6f8899e7879e2acf` | 25 / 4.2 MB `52b8621b080190da` | 77 / 16.4 MB `a9b87681ee1f2b2b` |
| classic-dereth-1.1 | 552 / 22.0 MB | 450 / 1.5 MB `c307e5d209ff3066` | 25 / 4.1 MB `cb8fd1d7c0fa46eb` | 77 / 16.4 MB `522210d21a0b9a26` |

(MB = MiB of gzip; the AC1999 world set has no split: its own world pack is the 0.9 MB terrain closure; AC1999 gets the
split through the end-of-retail interface pointer.) What a login waits for from the world pack: end of retail and the
classic sets 23.4 → 19.3 MB, AC1999 23.4 → 1.5 MB.

**Client** (`StreamingDats`): a pointer naming all the parts its scope needs (`hasWorldSplit`; interface scope:
worldCore + worldChargen) loads `worldCore` (+ `worldLand` + `terrain`) as `worldPacks`, then the ui pack and the in-world
layouts' art, then `worldChargen` at Background (it yields to a gate and starts on an idle link). `chargenArtReady` =
worldCore + worldChargen + the chargen layouts' art; GameUI opens chargen on it (`chargenArtReady` option; Please Wait
until then) and asks for the pack at Critical when the player clicks Create Character (`onChargenArtWanted` →
`wantChargenArt`), so a new player's chargen no longer waits for the land textures either. GameUI's preload runs its
HUD part at `worldArtReady` and skips what is still on its way (`chargenArtDeferred`: not resident while worldChargen is
pending, so nothing is fetched twice as a leaf), and its chargen part when the pack lands. `uiArtRoots` (the login gate's
HUD roots and `uiArtReady`) now leave the chargen layouts out (`inWorldLayoutIds`), in every pointer. A profile that
cached the whole `world` pack before the split and not the parts keeps using it (`wholeWorldPackCached`), so returning
players download nothing again.

**Compatibility.** The parts are pointer-only `packs` roles (`worldCore` 7 / `worldChargen` 8 / `worldLand` 9 in
`PACK_ROLE_CODE`; never in a manifest), and every split pointer keeps the whole `world` pack. An older client skips roles it
does not know (`parseSetPointer`) and loads `world` as before; checked live: the origin/main build on the staged EoL
pointer fetched `001964aaf55ec211` and entered normally. A newer client on an old pointer has no split and behaves as before.

**Measured** (production builds served locally, cold profiles, CDP throttle from page load, agent auto-login with Enter at
once; base = the origin/main build on the live pointers, split = this build on the staged pointers through a Playwright
route, every object from R2; interleaved, one browser at a time; scripts in the session scratchpad `split/`):

| Era | 150 ms / 10 Mbit/s, base → split (two rounds) | 200 ms / 2 Mbit/s, base → split |
|---|---|---|
| End of retail (local ACE) | 60.2 / 60.0 → 56.5 / 56.4 s | 249.2 → 231.8 s |
| AC1999 (local AC1999 server) | 52.5 / 52.5 → 32.7 / 32.8 s | 216.8 → 124.4 s |
| Dark Majesty (local ClassicACE CustomDM) | 62.5 / 56.1 → 52.6 / 52.6 s | 230.3 → 212.7 s |

(Seconds from page load to in the world. End of retail's and Dark Majesty's login packs landed 3.4 s earlier at 10 Mbit/s
and 17 s earlier at 2; AC1999's interface stopped being the wait at all: its world set is now the last to land. The gate
itself is unchanged: 9.9 / 9.9 s end of retail, 2.0-3.2 s AC1999, 6.8 s Dark Majesty except one 13.3 s base outlier.)
Every split run: no read of a worldChargen file before or after entry (the probe's `__missTrace` against the pack's ids),
entry screenshots match the base runs (HUD, terrain, sky; only the arrival bubble's phase differs), and the in-world miss
counts are the base's (NPC clothing / icons, §6.12).

What is left for end of retail and Dark Majesty is the 17.8 / 16.4 MB of land textures: TerrainRenderer builds every
terrain type's material once (`buildTerrainMaterials`), and a landblock mesh takes `terrainMaterials.get(type) ??
this.material` when it is built, so waiting only for the destination's terrain types needs materials that rebuild the
meshes when a type's texture lands. That is a renderer change with a visible failure mode (a far landblock drawn with the
fallback), not a repack, and was not made here.

Inverse sweep: no in-world layout's art is in worldChargen (`inWorldLayoutIds` closure; the barber 0x21000068 is in-world,
so its art and anything chargen shares with it stays in the core). The one surface that waits is chargen: opened before
its pack, it shows Please Wait, asks for the pack at Critical, and opens complete when it lands
(tests/verify-dat-streaming-world-split.ts, real EoL DATs: the HUD, inventory, character, magic, social and map panels and
the terrain materials build with no miss while the pack is absent; chargen opens with every deferred preload texture).

**Publishing.** `npx tsx tools/publish-dats-r2.ts --world-split-only https://dats.playwebac.com/v1/sets/<set>.json --stage
<dir>/<set>` (no DATs needed: it reads the live packs and `pack-sets.json` worldPhases; the parts hold the live world
pack's bytes; a full publish builds the parts too). The 2026-11-03 objects above are uploaded (each 404'd first, verified
byte-identical through the CDN after); nothing references them until a pointer flips. Staged pointers (the live ones with
only the three `packs` entries added): `verification/dat-streaming/world-split-staged/v1/sets/`. Superseded and
unreferenced from the same day's first cut (chargen models in the chargen part): `2ea9fc8c75f6d58d`, `cbbfda1763f8d542`,
`dfe973291ce8c6fd`, `b229132fb9cd74cf`, `2de7663436702ea1`, `c3435580c815f8ac`, `63557efe3834ff50`.

**The flip** (the client must be deployed first or with it; an older client ignores the parts either way), per set:
re-run `--world-split-only` against the live pointer into a fresh stage dir (keeps any change made to the pointer since,
e.g. an effects-pack flip; the part objects come out the same), check the staged pointer differs from the live one only
by `packs.worldCore` / `worldChargen` / `worldLand`, then `npx wrangler r2 object put webac-dats/v1/sets/<set>.json --file
<stage>/v1/sets/<set>.json --content-type application/json --cache-control "public, max-age=60, must-revalidate" --remote`.
The end-of-retail pointer carries AC1999's gain (its interface). Rollback: upload the live pointer without the three entries.
Live check before the flip: a production build (`VITE_ACJS_URL_OVERRIDES=1 npx vite build`) with the staged pointer served
by a route or `tools/stage-proxy.ts verification/dat-streaming/world-split-staged --pointer-only`
(`&datSet=http://localhost:9177/v1/sets/eol-p2072-c982-h497-l994.json`; classic / AC1999 add
`&eraDatSet=<era>:<their pointer>`), a cold profile: the boot log names `worldCore` / `worldLand` resident and never
fetches the whole world pack (`001964aaf55ec211` for end of retail), and Create Character opens with the portraits.

Tests: tests/verify-dat-streaming-world-split.ts (the rule, pointer parsing old and new, openStreamingDats over split /
old / interface-only / cached-whole-pack pointers with priorities and order, chargen asked for first; the real-DAT login
and chargen above), tests/verify-chargen-finish-silent.ts (chargen's wait is `chargenArtPending`).

### 6.17 A slow cache read races the network; prerendered boots are not slow boots (PERF.cache-read-slower-than-network, 2026-11-04)

**Signal.** Boots whose object-cache (OPFS) reads took longer than downloading would have:

| When (UTC) | Who | What the phases said | Cause |
|---|---|---|---|
| 2026-11-04 01:32 (8658ebcf) | 69.156.98.60, Windows, 4 GB, Vega 8 | warm, 37,168,872 B / 111 objects from the cache, `cacheReadMs` 40037, `cacheReadMaxMs` 19158, `worldCacheMs` 21139, `lagMs` 81, `hiddenMs` 0, `netBytes` 0 | one read stalled: the disk under it |
| 2026-11-02 22:19 (d0eb70b8) | 76.33.184.45, Windows, 32 GB | `dirMs` 129384, `hiddenMs` 129346, `cacheReadMaxMs` 128961, `manifestMs` 129079 | a Chrome prerender |

*The 19 s read.* 37,168,872 B / 111 objects is exactly what a warm end-of-retail boot reads from a profile holding the
§6.16 parts (measured here: same bytes, same object count), so the biggest read was `worldLand` (18.6 MB gzip). The same
player's boot six minutes earlier read its biggest object in 1.97 s (already the slowest in 213 production boots of
2026-11-01..04; the median slowest read is 81 ms; here it is 60-70 ms). Nothing in the page explains it: no writes that
boot (`netBytes` 0), the main thread free (`lagMs` 81), no queueing in the timer (it starts inside the disk slot), and the
other 110 reads summed ~21 s over a 24 s boot. The page before it in that tab (a Classic Dereth boot) sat 17.7 s in the
same `world_cache` stage, so for about a minute the laptop's disk was slow for everything big. Locally, CPU throttling
(6×) only moved the slowest read 39 → 235 ms; a 19 s read does not come from our read pattern
(`getFile().arrayBuffer()`, 32 reads at once) but from the machine. What we controlled: the store awaited every read to
the end, so the boot was as slow as the disk's worst minute even with a fast network one request away.

*The 129 s read.* `dirMs` (opening OPFS: `navigator.storage.getDirectory()`) − `hiddenMs` = 38 ms: OPFS opened the
moment the page was first shown. Chrome defers `getDirectory()` and `storage.estimate()` in a prerendered page until
activation. Reproduced with Chrome for Testing 1223 and no DevTools attached (DevTools disables prerendering:
`PrerenderingDisabledByDevTools`): a speculation-rules prerender's `getDirectory()` resolved 32 ms after activation,
5.8 s after it was called, while `fetch` and `CompressionStream` ran at once. The player waited ~0.3 s; boot_slow and the
phases counted the 129 s nobody watched.

**Fix.**
- `DatStore` (`dat/CacheHedge.ts` policy): a cache read still running `3 s + gzSize / 8 MB/s` after the object was asked
  for (disk-slot wait included; inflate excluded) also downloads the object. The first verified payload wins. A cache win
  aborts the download (no failure, no retry counted); a network win leaves the cached copy alone (it is valid, only
  slow; rewriting 18 MB onto a struggling disk would make it worse) unless the read then comes back unusable, when the
  downloaded copy replaces it. A failed download leaves the read to finish. worldLand's deadline is 5.3 s.
- The whole-DAT cache (`DatCache.loadDatWithCache`: AC1999's 99.6 MB / 45.1 MB world DATs) takes the same race
  (`hedgedCacheRead`; 99.6 MB → 15.5 s), its download aborted when the cache wins. Chargen's and area packs go through
  `DatStore.loadObject`, so they have it. The AC1999 patch restore (`Ac1999World.restore`) has no network copy to race.
- The deadline's timer does not run while `document.prerendering` (`prerenderAwareWait`): a prerender would otherwise
  download the whole set for a page the player may never open. It starts again on activation.
- Telemetry: phases `hedges`, `hedgeWins`, `prerenderMs` (BootWatch; the bridge keeps them). boot_slow counts
  BOOT_SLOW_MS from when the page was shown.
- Dev knobs for measuring (`urlOverridesEnabled` only): `?cacheReadDelayMs=N&cacheReadDelayMinBytes=B` delays every
  cache read of B+ bytes by N ms (`SlowReadObjectCache`), `?noCacheHedge` turns the race off.

**Measured** (`tools/probe-warm-boot-cache.ts`, own Vite, production end-of-retail set from dats.playwebac.com,
headless Chromium, one per-run profile; "boot" = char-select set resident, "world" = world packs resident, which a warm
boot awaits before resolving):

| Run | boot | world | hedges / won | cacheReadMaxMs |
|---|---|---|---|---|
| cold (network, unthrottled) | 1.1 s | 2.9 s | - | - |
| warm | 0.47 s | 0.73 s | 0 | 57 |
| warm, CPU 6× | 1.1 s | 4.0 s | 0 | 235 |
| network only (`?nocache`) at 20 Mbit/s | 4.5 s | 23.8 s | - | - |
| every read ≥ 1 MB stalls 19 s, race off | 76.5 s | 76.7 s | 0 | 19051 |
| every read ≥ 1 MB stalls 19 s, race on | 17.2 s | 17.5 s | 7 / 7 | (stalled reads finish later) |
| the same at 20 Mbit/s, race on | 26.3 s | 34.5 s | 7 / 7 | |
| only worldLand (18.6 MB) stalls 19 s, race off: the production signature | 19.4 s | 19.7 s | 0 | 19058 |
| only worldLand stalls 19 s, race on | 6.9 s | 7.1 s | 1 / 1 | 39 (the stalled read lands later) |
| the same at 20 Mbit/s, race on | 13.3 s | 19.9 s | 1 / 1 | |

Inverse: a healthy warm boot asks the network for nothing (hedges 0, netBytes 0 in every warm run; tests pin it), and a
race holds at most one extra copy of the object it raced.

Tests: tests/verify-cache-read-hedge.ts (store race both ways, abort, unusable copy replaced, failed download falls back,
null policy / non-persistent cache, deadline math, phases + bridge keys, prerender timer, BootWatch prerenderMs,
boot_slow from activation, whole-DAT race), tests/verify-warm-boot-slow-breakdown.ts.

**One wait per limiter (BUG.streaming-hedge-shared-ticket, 2026-11-05).** A hedged load's Ticket waits in two limiters
at once: the disk limiter (its cache read, 32 slots) and the network limiter (the hedge's download). The Ticket used to
hold one `wake` / `queuedIn`, so the second queue overwrote the first: the disk limiter's pump started the network wait
(past the link's rules), the cache read never ran and its disk slot leaked, and the network limiter later popped a ticket
whose wake was null (prod 2026-11-05: `TypeError: n is not a function` at Limiter.pump from holdBackground's release).
It needs 33+ stalled reads at once, so the 33rd queues in the disk limiter. Now each Limiter keeps its own
`Map<Ticket, {wake, queue}>`; the ticket records every limiter it waits in, `promote` requeues in each, `requeue` moves
only a ticket waiting there (never a second entry), and `run` refuses a ticket already waiting or running in that limiter.
The whole-DAT race (`hedgedCacheRead`) shares no waiter: it has no limiter. Tests: tests/verify-streaming-hedge-shared-ticket.ts.

### 6.18 A cache that keeps answering slowly is bounded, then bypassed (PERF.slow-cache-bypass, 2026-11-06)

**Signal.** One player (Brazil, one address, builds 491864d24 then 5a407a377, 2026-11-06), with §6.17's read race shipped:

| When (UTC) | ms | dirMs | hasMs | cacheReadMaxMs | hedges / won | other |
|---|---|---|---|---|---|---|
| 17:08:44 (cold) | 11947 | 22 | 5517 | 5516 | 2 / 2 | 43 cache misses, each answered in up to 5.5 s |
| 17:10:38 | 22614 | 22100 | 130 | 22185 | 4 / 4 | pointer + packs + art + has = 4.4 s; 18 s unaccounted |
| 17:11:07 AC1999 world set | 12528 | 12525 | 9203 | 12493 | 5 / 5 | packs 3.3 s + has 9.2 s |
| 17:27:26 | 46622 | 46097 | 57 | 44907 | 4 / 4 | pointer + packs + art + has = 6.2 s; 40 s unaccounted |

**Cause.** Every OPFS operation awaits the objects directory (`OpfsObjectCache.dir`: `getDirectory()` + the directory
handle), which on this machine took 12-46 s to open; on the cold boot the directory opened in 22 ms but each file lookup
took seconds. Reads were raced (§6.17), so each paid its 3 s deadline and then the network won. The two has() checks
were not raced at all: the warm-profile check (`hasMs`, 9.2 s on the AC1999 boot) and the split-pack check
(`wholeWorldPackCached`, untimed: the "unaccounted" 18 s and 40 s above). Retail has no counterpart (browser streaming
layer).

**Healthy distribution** (677 streamed-set boots 2026-10-23..11-06, `bash tools/aws-logs.sh bridge --since 14d --filter
cacheReadMaxMs`, prerenders excluded): hasMs median 4 / p95 90 / p99 605 / slowest healthy 649 ms; dirMs median 10 /
p95 83 / p99 570; cacheReadMaxMs median 77 / p95 386 / slowest healthy 1969 ms. Incidents: hasMs 3.9-12.1 s, dirMs
12.5-46 s (129 s for the prerender of §6.17).

**Fix** (`dat/CacheHedge.ts` `CacheHealth`, `boundedHas`; `DatStore.fetchAndVerify`; `StreamingDats`; `Ac1999World.restore`):
- A has() check answers "not stored" once it passes `CACHE_HAS_BOUND_MS` (1.5 s, prerender-aware). That is the cold
  path: the world packs load behind char select, their reads raced as usual. A late answer is dropped.
- `CacheHealth` (one per page: `DEFAULT_CACHE_HEDGE.health`, shared by an AC1999 boot's two sets) counts slow cache
  operations: reads that reached their deadline and has() checks that reached their bound. After
  `CACHE_SLOW_OPS_TO_BYPASS` (2) the cache is bypassed for the rest of the page: reads go straight to the network and
  fall back to the cache only when the network fails (offline still boots from the cache, however slow); has() answers
  "not stored" at once; nothing is written to it. Reads waiting on their deadline when the bypass begins ask the
  network then. Writes were already never awaited by a load.
- AC1999's stored server patches (`Ac1999World.restore`, a whole-DAT blob store on the same OPFS): with a server seed
  offered (the network copy), the stored state is read for at most `delayMs(0)` (3 s), and not at all once the page's
  cache is bypassed; the seed serves and the server pushes anything newer. Without a seed, or when the seed fails to
  load, the stored state is waited for (it is the only copy).
- Telemetry (stream phases; the bridge keeps them): `splitMs` (the split-pack check, now timed), `hasTimeouts`,
  `bypassReads`, `cacheBypassed` (0 / 1), beside `hedges` / `hedgeWins`.
- Not changed: the whole-DAT cache (`loadDatWithCache`) is not on any production path (every era streams); its reads
  keep §6.17's race.

Inverse: a healthy cache never reaches a bound (the 1.5 s has() bound is 2.3× the slowest healthy one; the 3 s read
deadline is 1.5× the slowest healthy read), so a healthy warm boot still reads everything from the cache and downloads
nothing (tests pin it). Expected on the 17:27 boot: the manifest and boot-pack reads hedge at 3 s, the cache is bypassed,
the split check answers at once: about 6 s instead of 46 s.

Tests: tests/verify-slow-cache-bypass.ts (CacheHealth, boundedHas, bypassed reads, bypass starting waiting hedges,
offline fallback, healthy inverse, unawaited writes, a fully stalled OPFS boot, has-only stalls, phases + bridge keys),
tests/verify-ac1999-server-seed.ts (the bounded stored-patch read both ways).

### 6.19 Object blocks load nearest and ahead first; the object ring is critical (BUG.scenery-pop-in-order, 2026-11-07)

Report (Jake, 2026-09-30, around Holtburg): small trees and plants popped in right next to him while big trees far
away were already drawn. Whole DATs never reproduce it; retail has no order to copy (LScape::update_block @ 005063a0
loads its grid synchronously, CLandBlock::init_static_objs @ 00530a40 builds a full-detail block's statics, buildings
and scenery at once). Objects appearing at their DIDDegrade distances (get_degrade @ 0051e4b0) is retail and unchanged.

Root causes in the streamed path:
1. LandblockLoadScheduler scored blocks by block-centre distance from the player's BLOCK. The 16 prefetch-ring blocks
   tie in fours and went lowest key first: running east out of Holtburg, 0xA7B4 (behind) was fetched first and the
   blocks ahead 4th and 11th-16th.
2. Every block was fetched at prefetch priority, all 25 at once. A block the 3x3 object ring had already reached waited
   behind the rest, behind blocks issued for a direction the player left, and after a teleport behind the old place's.
   On a bandwidth-bound link the nearest block shared the link with 24 others.
3. SceneryInstancePool.levelMeshes and DegradeLod.holderFor cached "no meshes" when a degrade level's GfxObj missed
   (an evicted leaf, a swept template rebuilt later). Those instances drew nothing until the player was near enough
   for another level.

Fix: `blockLoadScore` (distance from the player to the block's nearest point + up to 128 m for a block behind the
character's facing), re-scored every pump. Blocks inside the object ring are fetched at Critical
(`blockData.request(bx, by, urgent)` → `DatClosure.ensureLandblock(…, Critical)`, which now promotes an in-flight
block load). A waiting block is promoted the moment the ring reaches it. At most `MAX_PREFETCH_BLOCK_FETCHES` (4)
prefetch fetches are in flight for blocks inside the current window; the rest wait and are re-scored as each lands.
Missed degrade levels retry on `onDatMissResolved`.

Measured offline with `tools/probe-scenery-popin-order.ts` (the shipped streamer, scenery builder and degrade selection
over real DATs; a simulated block network of N s per block, 2 at a time; Holtburg east 1500 m at 10 m/s; "late" =
drawn after retail would have drawn it):

| run | before late (near < 60 m) | after late (near) |
|---|---|---|
| EoL, whole DATs | 0 | 0 |
| EoL, 3 s/block | 124 (0) | 0 |
| EoL, 4 s/block | 308 (0) | 0 |
| EoL, 6 s/block | 2,346 (34; 6 never drawn) | 263 (0; 0) |
| EoL, teleport Holtburg → 0xDA55, 4 s | 576 | 0 |
| EoL, north-east, 4 s | 405 | 59 |
| Dark Majesty, 4 s / 6 s | 203 / 867 | 0 / 267 |
| AC1999, 4 s / 6 s | 357 / 1,150 | 0 / 477 |

Usage: `npx tsx tools/probe-scenery-popin-order.ts --latency 4 --conc 2 [--path east|ne|teleport] [--era eol|dm|1999]`
(dm / 1999 need ACJS_DAT_SETS_DIR). Prints before and after. Tests: tests/verify-bug-scenery-pop-in-order.ts.
