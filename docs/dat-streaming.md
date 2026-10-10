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
- **Animations** are leaves (56 MB in total). The default-stance cycles are prefetched with the object.
  - A first-ever combat stance switch: prefetch the stance's animation set when the stance-change command is issued. The stance transition itself plays for ~0.5 s, which covers 1–2 RTT.
  - If an action animation is still missing, hold the current cycle until it arrives rather than skipping it.
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
  - `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) on the game's HTML, set by whatever serves it on Railway;
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
