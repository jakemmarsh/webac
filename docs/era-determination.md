# Fidelity Era Determination — END OF RETAIL (January 2017)

**Decided 2026-06-09.** The fidelity target for this project is **end-of-retail Asheron's Call
(the January 31, 2017 sunset client)** — NOT Throne-of-Destiny 2005, and NOT pre-ToD classic.
This is the only era we can target confidently, and the evidence below shows our data is
self-consistently pinned to it.

## Evidence that our DATs are the end-of-retail set

1. **Iteration numbers match ACE's pinned end-of-retail constants exactly.**
   - `dat/client_portal.dat` → Iteration file 0xFFFF0001 → **2072**
   - `dat/client_cell_1.dat` → **982**
   - ACE source: `reference/ACE/Source/ACE.DatLoader/DatManager.cs` →
     `ITERATION_PORTAL = 2072`, `ITERATION_CELL = 982` ("expected end-of-retail version")
2. **CharacterGenerator (0x0E000002) contains all 13 heritage groups**, including
   Viamontian (ToD 2005), Olthoi/OlthoiAcid (March 2010), Gear[knight] (2011),
   Undead (Nov 2011), Empyrean/Umbraen/Penumbraen/Lugian/Tumerok. A 2005 ToD DAT
   would have 4.
3. **ACE itself emulates end-of-retail rules** and only supports EoL DATs. Our world DB
   is an ACE dump. Targeting any earlier era would fight the server data everywhere.

## What the end-of-retail pre-world screens actually look like

The 2012-rebrand **dark-blue art, with NO "Throne of Destiny" branding**, is baked into
our portal.dat and referenced by the LayoutDescs. Verified by dumping the layout chain
(`npx tsx tools/dump-charsel-layout.ts`) and extracting the textures
(`npx tsx tools/dump-ui-texture-pngs.ts`; JPEG-format textures need raw `sourceData` dump —
format 0x1f4 / `isJPEG`):

| Layout | Screen | Base image | Content |
|---|---|---|---|
| 0x21000004 | char-select / connecting | **0x06007576** (800×600 JPEG) | Dark-blue backdrop, **Asheron bust right**, baked-in gold "World" + "Characters" labels, silver "Asheron's Call" logo **without ToD subtitle**, faint spire silhouette bottom-left |
| 0x21000002 | **disconnected** (UILAYOUT DidMapper 0x2500000e enum 0x10000003 = "disconnected", `gmDisconnectedUI` — NOT char-create, which is 0x21000038; corrected in CORE.17.k.b) | **0x06005d3f** (800×600 JPEG) | Left: gold-framed dark armor-carving panel. Right: dark-blue texture. Plate element 0x10000333 at (430,115) 290×205 = the translucent black 48×48 texture 0x06004cc0 stretched (not parchment), holding the error text 0x10000417 and the "Quit Game" button 0x10000418 |
| 0x21000001 | splash/loading states | **0x0600610f** / **0x06006ebc** (640×480 JPEG) | Heritage-lineup art with logo / Bael'Zharon + Eater art |

Char-select overlay geometry from layout 0x21000004 (800×600 space):
- Logo plate 0x06004d64 at (21,44) 193×110
- Characters list container at (37,205) 170×334, inner list (5,7) 160×320
- Buttons: (36,522) 170×99 ×2 (bottom-left), (216,185) 254×113 (Create Character),
  **(239,289) 211×211 (the ENTER ellipse — genuine retail UI)**, (465,522) + (615,522) 170×99 (CREDITS / EXIT)

Button labels confirmed in StringTable **0x23000002**: `Create Character`, `DELETE`,
`CREDITS`, `EXIT`, `ENTER` — **all-caps is correct**. `"Quick Character"` and a
char-select `"Keyboard"` button have **zero hits** in all 15 EoL string tables — those
buttons are 1999–2004 chrome that no longer existed at EoL.

## Consequences

- The cool-blue backdrop + Asheron bust + plain "ASHERON'S CALL" wordmark our client
  renders is **era-correct**. Defects claiming "warm brown stone", "no bust",
  "missing Throne of Destiny subtitle", "round wood-and-bronze buttons",
  "Quick Character/Keyboard buttons", "jade corner gems", "green knot logo",
  "torch-lit stone hall char-create", "parchment-on-stone panels",
  "HELP/MENU/BACK/NEXT/TO END toolbar" were verified against **2001–2005 reference
  screenshots and are era-refuted**. See `verification/PREWORLD-BACKLOG.md` for the
  per-defect re-triage.
- `reference/images/preworld/` refs are mostly wrong-era: `char-select-release/divide/
  pillars/smallvictory` are 2001–2004; the warm-brown `*-ref*`/`*-web*` connecting and
  char-create shots are ToD-2005. **When hunting new refs, use 2012–2017 footage**
  (sunset-night streams, late YouTube videos) — or better, trust the DAT layout chain,
  which IS the ground truth for every pre-world screen.
- In-world HUD panels were continuously patched; the EoL DAT LayoutDescs (0x21xxxxxx)
  remain the authority there too. The in-world VISUAL backlog used late-era refs and is
  not affected by this re-triage.

## In-world HUD family: floaty windows, NOT the classic full-width statusbar (2026-09-07)

Re-derived for CORE.17.a/.b after the first gestalt audit filed "vitals should be
the full-width 800×28 statusbar 0x21000013 with the indicator strip at its right
end" — the same wrong-era premise CORE.5.b had already refuted on 2026-08-25.

- **Decompiled EoL client:** `gmGamePlayUI::SetupChildren @ 004e9ec0` builds the
  in-world screen from root layout **0x21000005** and binds `m_pStackedVitals` =
  child **0x100005fa** (base 0x2100006c, 160×58, edges L3/T1/R3/B2 = top-center),
  `m_pSideBySideVitals` = **0x100006d5** (base 0x21000075, 460×26), the radar
  **0x100006d2** (base 0x21000074, flush top-right) and the smartbox **0x1000049a**
  (base **0x2100000f** — the 3D-view element with its drag borders, verified by
  dump: no statusbar inside it). The indicator strip is its own window
  **0x10000611** (base 0x21000071, 150×30, authored (0,0) L1/T1/R2/B2 = top-left).
  No element of the classic statusbar (0x100000e2 / 0x21000013) is reachable from
  0x21000005 through base-layout inheritance (`tests/verify-eol-vitals-cluster.ts`).
- **Why the shutdown-day shots differ from the DAT defaults:**
  `gmFloatyIndicatorsUI::UpdateFromPlayerModule @ 004d34f0` (and the vitals /
  radar floaties alike) restore the window's saved x/y/w/h/visibility from
  `PlayerModule::InqChatWindowOption(windowId, 0x10000086..0x1000008a)` — per-
  character persisted geometry. reddit-shutdown.jpg shows the stacked cluster
  stretched to ~550 px and the strip dragged to the top-right; steam-final-
  seconds.jpg shows the same cluster dragged to the bottom-center. A fresh
  character has no saved geometry and sees the DAT positions: stacked cluster
  top-center, strip top-left.
- **Wrong-era refs for the top bar:** every `rawg_01`–`rawg_12`, `chat-panel.jpg`,
  `reddit-floppy.jpg`, `reddit-oldschool.jpg`, `shoushi-players-allegiance-chat.jpg`
  show the CLASSIC HUD frame — a full-width vitals row with the ornate 300×120
  radar (layout 0x21000017) hanging below it at y=28. That family exists in the
  EoL DAT only as unreferenced layouts; the EoL binary never instantiates it. Those
  images stay valid for panel INTERIORS, bar art, icons and chat text; they are not
  evidence for HUD placement.
- **Toolbar art is also era-bound (CORE.17.c, 2026-09-08):** the classic-frame refs
  show a brown toolbar with bronze slot numerals. The EoL toolbar (0x21000016
  content inside floaty window 0x21000070) draws BLUE UIItem empty-slot tiles
  (0x060010fa..0x06001102) and gold-ringed round panel buttons (0x10000197..
  0x1000019b media 0x0600111f etc.); both the ring and the blue are baked into
  the portal.dat textures, and reddit-shutdown.jpg shows exactly that row. Do not
  file "slots should be brown" or "the gold rings are invented" from a classic-frame
  reference. Guard: `tests/verify-core17c-toolbar-button-art.ts`.

## DAT provenance + acquisition (2026-06-09)

Where our files come from, and how to re-acquire any of them:

- **End-of-Retail bundle** (cell/portal/local + acclient.exe, the source of our original
  DATs — same Jul 17 2019 timestamps):
  `megadl 'https://mega.nz/file/Q98n0BiR#p5IugPS8ZkQ7uX2A_LdN3Un2_wMX4gZBHowgs1Qomng'`
  → `ac-updates.zip` (484 MiB). This is the bundle linked by emulator.ac / accpp.net /
  dekarutide. It does NOT contain client_highres.dat.
- **client_highres.dat (iteration 497 — the exact EoL version ACE pins)** lives in the
  official installer, which survives on the Wayback Machine:
  `https://web.archive.org/web/20201121104423/http://content.turbine.com/sites/clientdl/ac1/ac1install.exe`
  (599 MB). It is an InstallShield package; extract on macOS by carving the embedded
  volumes at fixed offsets, then `unshield`:
  ```
  python3 -c "d=open('ac1install.exe','rb').read(); \
    open('data1.cab','wb').write(d[152617:459624]); \
    open('data1.hdr','wb').write(d[459624:493313]); \
    open('data2.cab','wb').write(d[493313:597499596])"
  unshield -d out x data1.hdr "*client_highres.dat"
  ```
  Highres was never patched after this installer build — that's why the standard
  community install (installer + 4-file EoR overwrite) ends up with iteration 497.
- **Scanned 2026-06-09**: all 2,294 highres 0x06 textures are high-res WORLD art
  (terrain/architecture/creature/clothing detail). It contains NO UI textures — the
  paperdoll-pictogram hypothesis for VISUAL.39 is disproven by direct inspection.
- The installer also yielded **acclient.exe + acclient.pdb (29 MB of retail debug
  symbols!)** → saved to `reference/client-eol/` (plus the EoR final acclient.exe in
  `reference/client-eol/eor/`). The PDB names every function/global in the retail
  client — a major asset for faithfulness reverse-engineering.
- client_highres.dat is also copied into the ace-server container (`/ace/Dats/`); ACE
  loads it at startup (enables the `highres-export` console command).
- **Cloud provisioning (2026-09-12, CORE.17.h.g.c.d):** the file is cached on the
  in-repo `reference-bundle` branch as the raw chunk layer `dat-highres/` (2 parts +
  sha256 manifest); `tools/fetch-eor-dats.mjs` restores it into `dat/` after the EoR
  DATs (and publishes it from a valid local copy when the layer is absent —
  `--highres-only` runs just that step). The Wayback copy of the installer resets the
  TLS tunnel from the cloud egress; the Mega mirror linked from emulator.ac/how-to-play
  (`https://mega.nz/file/S8dSSCxJ#…`) served the 599 MB installer instead. The client
  mounts it as retail's HiFi DAT: `RenderTexture::DropUnwantedLevels` keeps the
  SurfaceTexture level 0 only at Environment Texture Detail "Very High" with it present
  (`docs/retail-client-symbols.md`, CORE.17.h.g.c.d section).
