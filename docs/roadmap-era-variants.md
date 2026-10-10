# Roadmap: Era Variants (ACE/EoL today → GDLE compat → classic / Dark Majesty servers)

Decided direction (Jake, 2026-08-23): finish the EoL client first, then support
two server/era variants. Sequencing is strict: nothing here outranks the
CORE.* fundamentals lane or EoL playability. This doc is the planned
follow-up for **after the EoL public release**. Jake added (2026-10-04) that
**the client must adjust to the server automatically**: the player picks a
server and the right era profile and DAT set load.

**2026-10-04 research pass: the evidence overturns the old tier-3 premise.**
The first version of this doc assumed classic servers speak a "2001 DM-era
wire" with "DM-era DATs, 3 heritages". Every classic server that is actually
running uses the **end-of-retail client and the EoL wire protocol**. Its era
comes from server content plus a custom DAT set in the ToD container format,
which our parser already reads with zero leftover bytes. A true pre-ToD client
(the 1999/2001 CDs' DATs and protocol) is a separate, much larger project. The
AC1999 project (§2.5) now runs one against a live server. Evidence is in §2–§4. The reproduction recipe is in §11.

---

## 1. Summary

| | Old assumption (2026-08-23) | Evidence (2026-10-04) |
|---|---|---|
| Client exe used by classic servers | a 2001 DM-era client | a retail EoL-generation `acclient.exe` (ClassicACE CustomDM ships build **00.00.11.6096**, compiled 2015-06-12, `NetVersion 1802`), patched only in its 4-char login version literal (`"c118"`) |
| Wire protocol | 2001 DM wire, new `@ac/network` message set | **EoL protocol, unchanged**. No opcode or layout differences in ClassicACE versus ACE. GDL-Classic and Seedsow emit the late-era PublicWeenieDesc header2. |
| DATs | DM-era DATs | ToD-format sets: the EoR `client_portal.dat` + overrides; a 2005 Infiltration or early-ToD cell converted to ToD format. Iterations are bumped to tag them (CustomDM 20044/20011). **Every added or changed file parses clean with our parser.** |
| Heritages | 3 | the DATs still hold **13** (CharGen unchanged in that respect); the *server* refuses non-classic heritages |
| What differs per server | protocol module | login version string, sometimes auth style, DAT set, iteration list in DDD, ruleset (server-side formulas, skills 55–57 on CustomDM) |

**Effort:** classic-server support ("tier 3a") is about **4–6 weeks of loop
time**, mostly server-profile plumbing, DAT-set hosting and verification
servers, not protocol work. An authentic 2001 client ("tier 3b") is **4–8
months**, needs a PDB-less 2001 exe decompiled, and has no live server to play
on. It stays parked.

### Revised tier table

| Tier | Server | Protocol | DATs | Effort |
|---|---|---|---|---|
| 1 (done) | ACE | EoL (`"1802"`) | EoL (portal 2072 / cell 982 / local 994 / highres 497) | current stack |
| 2 | vanilla GDLE (Reefcull-class) | same EoL protocol | same EoL | compat spike: login and auth quirks, DDD encoding, packet-order tolerance |
| 3a | classic servers: **ClassicACE** (Dekarutide, Unfamiliar Shores: CustomDM `"c118"`; Infiltration `"i104"`), **GDL-Classic** family (Seedsow, Snowreap) | **same EoL protocol**; per-server version string / auth style | per-server ToD-format DAT set (iteration-tagged) | 4–6 weeks (§8) |
| 3b (parked) | a true pre-ToD server: **AC1999** (gitlab.com/adamplumb/ac1999, active, §2.5) runs the Nov 1999 retail client; aetherium.ac (2001, closed, solo) | real 1999/2001 wire (different transport header, handshake and message layouts) | pre-ToD container, different file formats, no LayoutDesc UI | 3–5 months (§2.5) |

---

## 2. What classic servers actually run (evidence)

### 2.1 Server list
`acresources/serverslist` `Servers.xml` (48 entries, 2026-10-04). The classic ones:

| Server | emu | host | Client/DAT signal (description text only) |
|---|---|---|---|
| Seedsow | GDL | serafino.ddns.net:9060 | "A PVE Dark Majesty server must use classic AC .dats" |
| Snowreap | GDL | serafino.ddns.net:9070 | "A PVP Dark Majesty server must use classic AC .dats" |
| Dekarutide | ACE | dekaru.ac:9000 | "ACE-Classic Dark Majesty era custom PVE server…" |
| Unfamiliar Shores | ACE | 74.50.118.178:9000 | "…Custom Content CustomDM Client…" |

No structured field says which DAT set or exe a server needs. That is the gap §5.3 proposes to close upstream.

### 2.2 The server codebases
- **ClassicACE** (`github.com/bDekaru/ClassicACE`, active 2025-09; `Advan-tage/ACEclassic` is a 2023 fork of it). Rulesets: EoR, Infiltration (Feb 2005), CustomDM.
  - `ACE.DatLoader/DatManager.cs:16-31` defines a version string and iteration set per ruleset:

    | Ruleset | LoginRequest version | Cell | Portal | HighRes | Language |
    |---|---|---|---|---|---|
    | EoR | `"1802"` | 982 | 2072 | 497 | 994 |
    | Infiltration | `"i104"` | 10001 | 10006 | 497 | 10002 |
    | CustomDM | `"c118"` | 20011 | 20044 | 497 | 20011 |

    The fork has `"i103"`/`"c106"` and CustomDM 20006/20022/20004, so **the string is bumped with every DAT release**.
  - `ACE.Server/Network/Handlers/AuthenticationHandler.cs:172-190` boots any other string: `GameMessageBootAccount(" because you are not running the correct executable file version for this server")`.
  - The DDD flow is upstream ACE's (local `reference/ACE/Source/ACE.Server/Network/Handlers/DDDHandler.cs`). It compares the client's iterations with the server's loaded DATs:
    - client newer → boot (`DATsNewerThanServer`)
    - client older with `DDD.EnableDATPatching` (default false) → patch
    - client older without patching → boot (`DATsPatchingDisabled`)
    - equal → EndDDD
  - **Wire diff versus our ACE reference:** `GameMessageOpcode.cs`, `GameEventType.cs` and `GameActionType.cs` are identical. The four `GameMessages/Messages/*.cs` files that differ change content, not layout (CharacterList appends " [HC NPK]" to names; SystemChat and TurbineChat store fields).
  - `ACE.Entity/Enum/Skill.cs` adds CustomDM skills **Appraise, Armor, Sneaking** (ids 55–57). Heritage is restricted to Aluvian, Gharu'ndim and Sho server-side (`CharacterHandler.cs:74`), while CharacterList still sends `hasThroneOfDestiny = 1`.
- **GDL-Classic** (`github.com/bDekaru/ClassicDereth`, 2020-12; "the game as it was in February 2005, Infiltration… updated to GDLEnhanced"):
  - `Source/Network.cpp:871` **requires `"1802"`**.
  - It accepts auth type 1 (`"user:password"` in the account string) and type 2 (our format) (`Network.cpp:806-856`).
  - On DDD 0xF7E6 (`Source/Client.cpp:2305-2353`) it reads `ds, dss` and then **memcmps 12 raw bytes** against its own DAT's 0xFFFF0001 record, for portal (`ds 0, dss 1`) and cell (`ds 1, dss 2`). Any mismatch gives a critical error `STR_LOGIN_CLIENT_VERSION`.
- **Seedsow** (`github.com/Serafino97/Seedsow`, last push 2018-06; "based on the GDL project", a sibling of GDLE rather than a GDLE fork):
  - `Source/Network.cpp:572-591` reads the version string but never checks it. It **only accepts auth type 1** (`account:password` in one string) and silently drops anything else.
  - DDD always answers EndDDD, and DDD_RequestData is disabled ("Make sure you are using the appropriate cell.dat file!").
  - `PhatSDK/PublicWeenieDesc.cpp:200-232` emits the EoL header2. Caveat: the live server may run newer code than the 2018 public source.

### 2.3 The client binaries (inspected offline)
- **ClassicACE CustomDM 1.60 data files** (MEGA folder from the ClassicACE README) contain `acclient_CustomDM.exe`, `client_portal.dat`, `client_cell_1.dat`, `client_local_English.dat`, and a `client_highres.dat` byte-identical to ours.
  - The exe's VS_VERSION_INFO: FileVersion **00.00.11.6096**, "compiled Fri Jun 12 04:16:27 2015 : RETAIL", TurbineType "Player External", **NetVersion 1802**, PDB path `d:\ac1_acxp\output\bin\GAME\WIN32\retail\acclient.pdb`.
  - Our decomp's exe is 00.00.11.4186, compiled 2013-09-05, `ac1_sep13`.
  - The literal `"1802"` that `ClientNet::SendLoginRequest` sends (our decomp, `acclient-decompiled.annotated.c` around line 315488) is replaced by **`"c118"` at file offset 0x3caea8**. The EoL exe has `"1802\0"` at the matching 0x3ca0e8.
  - So the classic client is a **retail end-of-life acclient with a patched version literal**, and Decal and ThwargFilter (EoL-only) work with it. That matches every classic install guide.
- **Seedsow's published install** (Wayback 2021-10-25; seedsow.ca no longer resolves): step 1 is the stock AC (EoR) installer; step 2 replaces `acclient.exe`, `client_cell_1.dat` and `client_portal.dat`, then ThwargLauncher and Decal + ThwargFilter. Both Google Drive links are now 404. I inspected the *DATs* from the README's "Classic Dereth – Portal and Cell 1.0" MEGA link instead (below). Seedsow's exe wasn't reachable, but the source (no version check) and the Decal requirement show it must be the EoL-generation client.
- **Aside for the EoL project:** a retail 11.6096 (2015) build exists, newer than our 11.4186 decomp. `docs/era-determination.md` should note that the decomp is "the last build with a public PDB we have", not necessarily the final shipped exe (task ERA.final-exe-build, §8).

### 2.4 For contrast: the real 2001 Dark Majesty client
archive.org item `asherons-call-dark-majesty-2001-microsoft-cd` (471 MB 7z of an MDF image with 2448-byte raw sectors; recipe in §11) holds the Sept 2001 retail CD:
- `CLIENT.EXE`: FileVersion 01.00.25.0000, TurbineBuildVersion 00.00.10.4120.r, compiled 2001-09-12, PDB path `d:\source\acxp\ac\bin\WIN32\Release\client.pdb`. **No PDB is available.**
- `PORTAL.DAT` (170.9 MB) and `CELL.DAT` (88 MB).
- Login is Microsoft Zone-ticket based ("You can only run Asheron's Call from the Microsoft Internet Gaming Zone"). There is no NetVersion and no `ID_DataPatch_Interrogation`/DDD string.

The 2001 DATs use a **different container and different file formats** (§3.2), with no LayoutDesc UI, no fonts and no key maps. This is tier 3b's ground truth.

### 2.5 AC1999: a live pre-ToD project (checked 2026-10-06; this section supersedes "no live server needs 3b")

> **Superseded for planning by [ac1999-support-scope.md](ac1999-support-scope.md) (2026-10-06):** the full phase-by-phase scope (UI last, per Jake). It corrects this section: the bridge is *not* a pure relay for 1999, the server patches the client's DATs at login, `Server/` is AGPL-3.0, and the estimate to a playable world is ~12–16 weeks.
`gitlab.com/adamplumb/ac1999` (created 2026-06-18, ~1,475 commits, HEAD 13ff8cc6 2026-10-05). It runs the **original Nov 1999 retail client** (version `4.35752`, portal/cell iteration 1625/1294) against a fork of the Seedsow/GDL C++ server. It also brings up the beta2, beta0 and preview2 clients through a runtime `server_mode`. It has a Linux deploy for an internet-facing VPS (UDP 9110, auto-created accounts), but the host isn't in the repo. **No LICENSE file**, so use its knowledge base as reference only and copy no code.

Its `knowledge/kb/` is the most useful 1999 protocol reference there is: about 200 message pages plus structures, transport, DAT formats and client behaviour, each tagged with confidence and citations. What it shows about compatibility with us:

| Layer | 1999 vs ours | Work for us |
|---|---|---|
| Bridge | plain UDP | none: our WS→UDP bridge relays it unchanged |
| Transport | 20-byte header in a **different field order** (checksum at 0x0C, size u16 at 0x10, time u8, table u8); handshake is a `0x200` connect grant and `0x202` ack, not 2017's `0x40000`; TimeSync is flag `0x10`; 484-byte datagram cap; checksum is ISAAC-XORed as in EoL. Beta2 uses a reordered 24-byte header. | a second transport implementation in `@ac/network`, selected by the profile (~1–2 weeks) |
| Login | magic `0x075BCD15`, version string, `"user:password"` in a 20-byte field, then the portal and cell iterations. The client checks the **server's** version string with exact equality. | part of the transport work |
| Messages | the opcode namespace is mostly shared, but layouts differ (for example, PublicWeenieDesc has a u16 wcid and a u16 icon with different header bits). It also has 1999-only opcodes (0x1D1–0x1DE). DAT download uses 0xF7B8/0xF7B7, not EoL DDD. | per-era codecs for every message we parse (~3–5 weeks) |
| DATs | pre-ToD container (§3.2), and the formats differ per era (release, beta2 and beta0 each differ). Their `DatInspector` reads every era byte-exactly and serves as the spec. | pre-ToD container mode plus about 10 format variants (~2–3 weeks) |
| UI | **no LayoutDesc, StringTable, Font or KeyMap in the 1999 DATs.** Panel layout, fonts and bindings live in the exe (`PanelUI_HandleCommand` @ 0x4f5700, …). | the big item: a 1999 UI built from the exe and screenshots, since our whole UI is LayoutDesc-driven (~2–3 months) |

**Estimate:** about 3–5 months, and the UI is most of it. Connecting and rendering the world is about 6–10 weeks. A cheaper first step would be the 1999 world under the EoL UI (loading the EoL portal only for UI art), but that UI is not faithful to the era and needs Jake's sign-off as an exception. The profile and DAT-set design (§5) carries over: a 1999 profile picks the transport and codecs as well as the DAT set.

---

## 3. DAT parse results (our `packages/dat-parser`, offline)

Tool: `tools/era-dat-sweep.ts` (new, persisted). The baseline is the same parsers over our EoL portal: GfxObj, SurfaceTexture, Texture, Surface, Environment, String, CharGen, XpTable, Region and SpellTable are all clean.

### 3.1 Classic server sets (ToD container): **everything parses**

| Set | File | Files (EoL) | Iteration record | vs EoL | Parse of every added/changed file |
|---|---|---|---|---|---|
| ClassicACE CustomDM 1.60 | portal | 80,825 (79,694) | `[20044, -20044, 1]` | +1,131 added, 497 changed, 0 removed; changed specials CharGen, SkillTable, SpellTable, XpTable | **all clean**: GfxObj 389, Surface 380, Texture 290, SurfaceTexture 205, Palette 141, Setup 66, Scene 40, Region, CharGen, SkillTable, SpellTable, XpTable… |
| | cell | 528,250 (805,348) | `[20011, -20011, 1]` | 516k changed, 289k removed: a different world | clean (4,000-per-type cap: LandBlock, EnvCell, LBInfo 3,430) |
| | local | 118 (118) | 20011 | 3 StringTables changed (0x23000001/02/0e); **all 0x21 layouts identical to EoL** | clean |
| | highres | — | 497 | byte-identical to EoL | — |
| Seedsow "Classic Dereth 1.0" (GDL-Classic DATs) | portal | 79,694 (same) | `[2072, -2072, 1]` (**same as EoL**) | 869 changed in place, including CharGen, SkillTable, SpellTable, SpellComponentTable, ContractTable, KeyMaps, ActionMap, EnumMapper ×6, DidMapper ×5 | **all clean** |
| | cell | 598,568 | `[4, -4, 1]` (an early-ToD cell) | 23.5k changed, 210k removed | clean |

Facts that follow from this:
- CharGen in **both** classic sets still lists all 13 heritages. CustomDM renames starter area 3 "Sanamar" to "Hardcore". SkillTable has 31 skills (CustomDM), 35 (Seedsow) and 38 (EoL).
- Only 2 of our 527 hardcoded 0x05/0x06 texture ids change in CustomDM: 0x06004d5f, the chargen town map, and 0x0600127d, the world map. One changes in Seedsow: 0x06007576, the char-select backdrop. Those are re-skins we already draw from the DAT, so they come out era-correct automatically.
- Seedsow's portal reports the **same iteration as EoL (2072)** with different contents. A cache keyed on name + iteration would serve the wrong file, so the DAT cache must key on content hash (§5.4).

### 3.2 The 2001 CD (pre-ToD container): container unreadable as-is, half the formats differ

Container:
- The header is at **0x12C**, not 0x140: FileType 0x5442, BlockSize (0x400 portal / 0x100 cell), FileSize, three free-list words, an unknown word, BTreeRoot. There are no DataSet, LRU or version fields.
- Directory entries are **12 bytes** (ObjectId, FileOffset, FileSize; no BitFlags, Date or Iteration), so a node is 984 bytes.
- There is **no 0xFFFF0001 Iteration record**.
- Sector chains work the same way.
- bDekaru's Melt tool agrees (`Melt/Source/datFile/datFile.cs:58-130`; `convertRetailToToD` "add[s] iteration file that retail does not have").

Portal type census (30,397 files): 01 6642, 02 1949, 03 793, 04 1408, 05 3215, 06 4852, 08 2748, 09 110, 0a 544, 0d 540, 0e×12, 0f 485, 10 676, 11 2243, 12 248, 13 2, 20 111, 30 50, 31 27, 32 1121, 33 2519, 34 102. **No 0x14 KeyMap, 0x22 EnumMapper, 0x25 DidMapper, 0x26 ActionMap, 0x39 MasterProperty or 0x40 Font, and no local DAT at all.** The 2001 UI and fonts lived in the exe and Windows GDI. Cell: 65,025 landblocks, 2,646 LBInfo, 175,621 EnvCells.

Parsing through a small pre-ToD reader with our parsers:

| Clean (same format) | Differs |
|---|---|
| Setup, Animation, Palette, MotionTable, Wave, PaletteSet, Clothing, DegradeInfo, Scene, SoundTable, CombatTable, ParticleEmitter, PhysicsScript, PhysicsScriptTable, SecondaryAttributeTable, SkillTable, ChatPoseTable, SpellComponentTable, BadData, CellLandblock, LandblockInfo | **GfxObj**: surface count is a uint32, not compressed. **0x05** is a palettised *image* (id, type 2, w, h, P8 pixels, palette), not the EoL SurfaceTexture list. **0x06** is id, w, h, raw 24-bit RGB with no format field. **Surface** has a leading id (4 bytes left over). **String** uses a different length prefix. **Environment** and **EnvCell** differ in layout. **Region**, **CharGen** (string-id list first; 18 starter positions), **SpellTable** and **XpTable** (uint32, not uint64) all throw. |

---

## 4. Protocol: classic servers versus our `@ac/network`

**Identical** (verified in source for ClassicACE; GDL-Classic and Seedsow emit the same late-era layouts):
- Packet framing, ISAAC, fragments, sequencing
- ConnectRequest/Response
- CharacterList 0xF658 (ToD flag = 1)
- ServerName 0xF7E1
- ObjectCreate 0xF745 (ObjDesc + PhysicsDesc + PWD with header2)
- PlayerDescription 0x0013, GameEvent 0xF7B0, GameAction 0xF7B1
- TurbineChat 0xF7DE
- every opcode enum

**Differs, per server, all small:**

| # | Item | Ours today | Needed | Evidence |
|---|---|---|---|---|
| P1 | LoginRequest version string | hardcoded `writeString16('1802')` (`packages/network/src/ClientConnection.ts:887`) | from the server profile (`"1802"`, `"c118"`, `"i104"`…); ClassicACE boots on mismatch | §2.2 |
| P2 | Auth style | `NetAuthType.AccountPassword` (2) | Seedsow (2018 source) accepts only type 1 with `"account:password"` in the account string. GDL-Classic, ACE and ClassicACE accept 2. | `Seedsow/Source/Network.cpp:582-585` |
| P3 | DDD_InterrogationResponse encoding | `buildDDDInterrogationResponse` (`MessageSerializer.ts:2937-2968`) writes `(0, id, N, -(N+1))` × 3. ACE's tolerant reader accepts it. | Retail writes the raw Iteration record `N, -N, 1` per DAT (verified: every iteration file is `[N,-N,1]`) under the real DatFileType/DatFileId, plus `m_ItersWithoutKeys` and `m_dwFlags` (`DDD_InterrogationResponseMessage::Serialize @ 004f9700`). **GDL-Classic memcmps those 12 bytes**, so today's encoding fails there even with the right DATs. Fix it once, as retail does. This also belongs to the tier-2 GDLE spike. | `ClassicDereth/Source/Client.cpp:2305-2353`; decomp line 238935 |
| P4 | Iterations reported | `db.totalIterations` per loaded DAT (`main.ts:7403-7407`): already data-driven | send the loaded set's own records; nothing else is needed once P3 is retail-exact | — |
| P5 | DAT mismatch outcomes | not surfaced as "wrong data set" | map BootAccount "not running the correct executable", CharacterError `DATsNewerThanServer`/`DATsPatchingDisabled`, and GDL `STR_LOGIN_CLIENT_VERSION` to one "this server needs a different client data set" path (§5.2) | ACE `DDDHandler.cs:117-168` |
| P6 | Ruleset content | client-side formulas mirror ACE EoR | per-ruleset values where we *compute* rather than display server values (CustomDM skills 55–57, formula changes) | ClassicACE `Skill.cs` |

---

## 5. Auto-detect and boot design

### 5.1 How the client learns the era *before* loading DATs
Today the DATs load at boot (`main.ts:874-922`) and the login form appears afterwards (`main.ts:7364`). For per-server DATs the order flips: **choose a server first, then load that server's DAT set**. Retail had the same order: you launched a server-specific install. Pieces:

1. **Server picker (new first screen).** It lists entries from:
   - **(a)** upstream `Servers.xml` (raw.githubusercontent.com sends `Access-Control-Allow-Origin: *`)
   - **(b)** our own `servers.overlay.json`, hosted with the client, which maps a server `id` (GUID) to a profile: `{ datSet, clientVersion, authStyle, ruleset }`. The overlay wins until upstream carries the fields (§5.3).
   - **(c)** "Custom server…": the user enters host:port and picks a profile from the known list (EoR / ClassicACE CustomDM c118 / ClassicACE Infiltration i104 / GDL-Classic / Seedsow) or pastes a DAT-set manifest URL.

   The picker draws on the EoL portal (it is pre-DAT for every era, and the EoL portal is already cached for most players). Faithfulness: retail had no in-client server picker. ThwargLauncher was external, so this is a **named browser-UX exception** like the login form (GAP.44). Record it in CLAUDE.md when it ships.
2. **Remember the choice** per browser (localStorage `acjs.lastServer`, try/catch). The `?server=<id|host:port>` URL param skips the picker, so the test harness keeps today's `?account=` flow. `?era=` stays as a developer override.
3. **Handshake-failure detection (fallback, not primary).** No message before DDD names the era: ServerName arrives after login, and DDDInterrogation carries only region, language and product. Failures can be *detected* but the correct set can't be *inferred*. On any P5 signal the client shows "This server requires a different client data set" and opens the profile chooser for that server. An optional bounded probe could retry LoginRequest with each known version string, at one session per try and only on user consent. ACE holds a booted account for a while, so the probe costs real time. Metadata stays the primary path.

### 5.2 Profile object (shape)
```ts
// packages/shared/src/era/ServerProfile.ts (new) — no EoL literals elsewhere
interface DatSetRef { id: string; manifestUrl: string }      // e.g. 'eor-2072', 'classicace-customdm-1.60'
interface ServerProfile {
  datSet: DatSetRef;
  clientVersion: string;          // LoginRequest literal: '1802' | 'c118' | 'i104' | …
  authStyle: 'account-password' | 'account-colon-password';
  ruleset: 'eor' | 'infiltration' | 'customdm' | 'gdl-classic';  // client-side formula tables
  bridge?: string;                // ws(s) bridge URL override
}
```
The manifest is a JSON file on R2:
```json
{ "id": "classicace-customdm-1.60", "clientVersion": "c118",
  "files": {
    "portal":  { "url": "…/sha256-<hex>/client_portal.dat", "size": 935232512, "sha256": "…", "iteration": [20044,-20044,1], "base": "eor-2072", "overlay": "…/portal.overlay.dat" },
    "cell":    { "url": "…", "size": 223295488, "sha256": "…", "iteration": [20011,-20011,1] },
    "local":   { "url": "…", "size": 1048576,   "sha256": "…", "iteration": [20011,-20011,1] },
    "highres": { "ref": "eor-2072" } },
  "source": "https://github.com/bDekaru/ClassicACE (Data Files – CustomDM 1.60)", "license_note": "…" }
```

### 5.3 Upstream PR draft: `acresources/serverslist` (do not submit until we ship)
`Servers.xsd` is a strict `xs:sequence` validated in CI (`.github/validate-servers.sh` → `xmllint --schema`). New elements must therefore be **optional and appended last**. ThwargLauncher's `ServerPersister.ReadServerList` (`ThwargLauncher/GameManagement/ServerPersister.cs:102-162`) reads child elements by name and ignores unknown ones, so the change is backward-compatible. (Thwarg already honours a non-schema `custom_launch_path`, the per-server exe hook classic servers rely on.)

```diff
       <xs:element name="discord_url" type="xs:string" minOccurs="0" />
+      <!-- Client data era. Absent = EoR (end-of-retail 2017 DATs, client version "1802"). -->
+      <xs:element name="era" type="EraType" minOccurs="0" />
+      <!-- 4-char LoginRequest client version string the server requires; absent = "1802". -->
+      <xs:element name="client_version" type="xs:string" minOccurs="0" />
+      <!-- Where players get this server's DAT set (download page or machine-readable manifest URL). -->
+      <xs:element name="dat_url" type="xs:string" minOccurs="0" />
     </xs:sequence>
   </xs:complexType>
+  <xs:simpleType name="EraType">
+    <xs:restriction base="xs:string">
+      <xs:enumeration value="EoR" />
+      <xs:enumeration value="Infiltration" />
+      <xs:enumeration value="DarkMajesty" />
+      <xs:enumeration value="Custom" />
+    </xs:restriction>
+  </xs:simpleType>
```
Example entries: Dekarutide → `<era>DarkMajesty</era><client_version>c118</client_version><dat_url>https://www.dekarutide.com/dat-downloads</dat_url>`; Seedsow → `<era>DarkMajesty</era>`, with no `client_version` (GDL-Classic wants "1802"). Update `Template.xml` and the README the same way. PR text: "Lets launchers and alternative clients tell which DATs and exe a server needs. Optional, appended, ignored by ThwargLauncher." Our overlay still carries `datSet` and `authStyle`, which are client-specific.

### 5.4 DAT set selection, hosting and streaming (R2 + HTTP Range)
- **Layout on R2:** `dats/<setId>/manifest.json`, with each file under a content-hash path `dats/<setId>/sha256-<hex>/<name>`, immutable with a long cache. Identical files are shared by reference: CustomDM `client_highres.dat` is byte-identical to EoL, so the manifest says `{ "ref": "eor-2072" }`.
- **OPFS cache key = sha256 (from the manifest)**, not URL + iteration. Seedsow's portal claims iteration 2072 with different contents (§3.1).
- **Overlay portals (optimisation, phase 2).** CustomDM's portal is EoL plus 1,628 added or changed files, and Seedsow's is EoL plus 869 changed. Build `portal.overlay.dat`, a tiny ToD-format DAT of only those files, with a new `tools/build-dat-overlay.ts`. The client composes a `DatFileSource` that tries the overlay and then the cached EoL base. A returning EoL player then downloads a few tens of MB instead of 935 MB. The composite must report the *set's* Iteration record for DDD (from the manifest), not the base's. Cell DATs share almost nothing with EoL (516k / 23.5k changed and 289k / 210k removed), so cells are always full files.
- **Streaming:** the main load path downloads whole DATs (`fetchDat` → `loadDatWithCache`). `RangedDat` + `httpRangeFetcher` already exist for the splash (`main.ts:640`). The era work doesn't need full Range streaming, but R2 serves `Range:` natively, so a future "start before the 900 MB arrive" upgrade works unchanged per set.
- **Bridge:** browsers can't send UDP. The public deployment needs a hosted ws→UDP bridge that takes the target from the client (`?target=host:port` or the first WS frame) and **allowlists hosts from the server list plus explicit custom entries**, so it can't become an open UDP relay. Today's bridge is pinned to one host (`services/ws-tcp-bridge/src/bridgeUtil.ts:141`, `bridge.ts:68-81`).

### 5.5 The boot-time profile switch in code (where)
- `packages/renderer/src/main.ts`:
  - **Before 874**, resolve `ServerProfile` from `?server`, the remembered choice, or the picker, and fetch the manifest.
  - **874/883/915/919** take DAT URLs from the manifest. Today they are literal `'/client_portal.dat'` and so on. `ensureHighResDat` (806-824) and the splash ranged read (640, 847) take theirs from the manifest too.
  - **7346-7349** gets bridge and credentials from the profile.
  - **7387** becomes `new ClientConnection(bridgeUrl, { clientVersion, authStyle })`.
  - **7403-7407**: `datIterations` is already per loaded DB, so pass the raw records.
- `packages/network/src/ClientConnection.ts:869-930`: `sendLoginRequest` takes the version and auth style from options (P1, P2).
- `packages/network/src/MessageSerializer.ts:2937`: retail-exact DDD encoding from raw Iteration records (P3).
- `packages/network` keeps every protocol literal (the standing rule). The profile carries values, never message layouts, because there are no layout differences.

---

## 6. EoL-hardcoded residue, ranked (what breaks under classic data/servers)

Classic servers' reference client is the **EoL client** with their DATs, so most EoL-only UI (contracts, luminance, aetheria, cloak slot) is *correct* for them. It exists in their exe too, and the server just never fills it. The residue that matters:

**High**
1. **DAT URLs and cache identity.** Literal `client_*.dat` names at `main.ts:640, 810, 874, 883, 915, 919`. The OPFS cache is keyed per URL, and an iteration can't distinguish sets (§3.1).
2. **LoginRequest `"1802"`** (`ClientConnection.ts:887`) and **auth type 2 only**. These block login on ClassicACE classic rulesets and on Seedsow (P1, P2).
3. **DDD encoding** (`MessageSerializer.ts:2937-2968`). It fails GDL-Classic's byte compare (P3).
4. **Server-before-DATs ordering.** DATs load before credentials and server choice (`main.ts:874-922` versus `7346-7387`). The bridge is single-target.

**Medium**
5. **Client-side formulas and enums tied to ACE EoR.** `SkillId` (`packages/shared/src/ace-enums.ts:21-76`) lacks CustomDM 55–57. Hardcoded skill groups sit at `packages/shared/src/magic/EnchantmentManager.ts:170-176` and `packages/shared/src/character/CreatureStats.ts:81-90`, and FORMULA.* constants are ACE EoR. Everything the client *computes* (not displays) needs a ruleset table or must come from the DAT SkillTable (already loaded, `main.ts:1150+`).
6. **Chargen heritage behaviour.** The DATs keep 13 heritages and the server refuses 10 of them. Retail-faithful behaviour (the classic exe shows all 13) is to show them and surface the server's CharacterCreate error cleanly. Verify that the error path renders. `ChargenRandomize.ts:175-182` already has a 3-heritage roll, but it is gated on `hasThroneOfDestiny`, which ClassicACE sends as 1. Don't key era behaviour on that flag.
7. **Chargen town pins** (`ui/GameUI.ts` around 7650-7680): geometry and string ids are hardcoded from layout 0x2100004a, and each town is bound to a StarterArea index. CustomDM renames area 3 to "Hardcore" in CharGen and changes StringTables 0x23000001/02/0e. Read labels from the layout's StringTable at runtime, which also follows the DAT-only rule for EoL.
8. **Weenie JSON side-files** (`main.ts:940-995`: weenie-setups, combat-styles, attack-types, weapon-time) are exported from the **EoL ACE world DB**. They are wrong for classic content, so they need per-set copies or must be dropped where server data suffices.

**Low**
9. 506 hardcoded UI texture ids, 68 font ids, DID/Enum mapper ids and the KeyMap/ActionMap defaults baked into `KeybindDefaults.generated.ts`. All are still present in both classic sets, and changed contents (map, backdrop) render era-correct automatically. Seedsow changes KeyMaps and the ActionMap (2 + 1 files), so a per-set defaults table needs regenerating, or the defaults should be read at runtime.
10. `ContractTable`, TurbineChat and the 13-entry `Heritage` enum are supersets: harmless.

**Tier 3b only (a true 2001 client):** pre-ToD container (`DatDatabase.ts:8-20, 276-285`, header at 0x140 and 24-byte entries), the format differences in §3.2, **no LayoutDesc/StringTable/Font/KeyMap at all** (`LayoutRenderer`, 91 layout ids across 74 files, 0x2100004c alone has 59 refs), and the 2001 wire and Zone auth. That is a different client.

---

## 7. Reference material

| Need | Source | Status |
|---|---|---|
| Classic exe behaviour | `acclient_CustomDM.exe` (11.6096, 2015) | in hand. There is no PDB for 11.6096, but it is a later build of the same code base, so our 11.4186 decomp remains the behaviour reference and the patched literal is the only known delta. Optionally diff it against an unpatched 11.6096 if one surfaces. |
| Classic DAT sets | ClassicACE CustomDM 1.60 / Infiltration 1.9 (MEGA folders in the ClassicACE README); GDL-Classic "Classic Dereth Portal and Cell 1.0/1.1" (README MEGA links); Dekarutide (dekarutide.com/dat-downloads, via Wayback) | CustomDM 1.60 and Classic Dereth 1.0 downloaded (gitignored scratch), parse clean |
| Server truth | ClassicACE (C#, ACE-derived, same layout as our reference); GDL-Classic + Seedsow (C++) | public source |
| Ruleset formulas | ClassicACE `Ruleset` branches (`ACE.Common/GameConfiguration.cs`, per-system `WorldRuleset` switches) | replaces ACE EoR as ground truth for those servers |
| A true 2001 client (3b) | archive.org DM 2001 CD (client 01.00.25, DATs); also the 1999 CDs and a beta ISO | available, but **no PDB**, so decompiling it costs far more than the EoL one did |
| Patched-DAT tooling | bDekaru Melt (`convertRetailToToD`, overlay building) | public source; the model for `build-dat-overlay.ts` |

**Hosting (decided 2026-10-06):** the classic DAT sets are hosted on our R2 beside end of retail's, the same posture as EoL hosting (Jake: "why can't we load the proper DATs just like we do already?"). Players never supply files; see dark-majesty-support.md "Hosted classic sets".

---

## 8. Phased plan (starts after the EoL public release)

Estimates are loop-days of focused work, assuming the EoL client is done.

**Phase 0: door-keepers now (no tasks, ~0 days).** Keep protocol literals in `@ac/network` and honour the DAT-only rule. New rule: **never key behaviour on DAT iteration numbers or on the `hasThroneOfDestiny` flag.**

**Phase 1: server profile plumbing (≈7–9 days).** This also unlocks multi-server EoR, so it is worth having even without classic support.

| id | title | tier |
|---|---|---|
| ERA.profile-type | `ServerProfile` + DAT-set manifest types in `@ac/shared`; profile resolver (`?server`, remembered, picker, `?era` dev override) | 1 |
| ERA.server-picker | Pre-DAT server picker: upstream `Servers.xml` + `servers.overlay.json` + custom host:port/profile entry; named browser-UX exception in CLAUDE.md | 1 |
| ERA.boot-order | `main.ts`: resolve the profile before the data patch; DAT URLs, highres and splash from the manifest (`main.ts:640/810/874/883/915/919`) | 1 |
| ERA.dat-cache-hash | OPFS DAT cache keyed by manifest sha256 (iterations collide: Seedsow portal = 2072) | 1 |
| ERA.login-version | `ClientConnection` options: `clientVersion` (replaces the literal `'1802'`), `authStyle` (`account:password` single-string variant for GDL-family) | 1 |
| ERA.ddd-retail-exact | Encode DDD_InterrogationResponse as retail does (raw Iteration record `N,-N,1`, real DatFileType/Id, `m_ItersWithoutKeys`, `m_dwFlags`, @004f9700); test against a GDL-Classic-style 12-byte compare and ACE's reader | 1 |
| ERA.dat-mismatch-ux | Map BootAccount "correct executable", `DATsNewerThanServer`/`DATsPatchingDisabled` and `STR_LOGIN_CLIENT_VERSION` to a "wrong data set for this server" screen + profile chooser | 2 |
| ERA.bridge-target | Hosted bridge: client-selected target with an allowlist from the server list + custom entries; per-profile bridge override | 1 |

**Phase 2: DAT-set pipeline (≈4–6 days).**

| id | title | tier |
|---|---|---|
| ERA.r2-manifests | `tools/publish-dat-set.ts`: hash, upload to R2 content paths, write `manifest.json` (EoR, ClassicACE CustomDM, ClassicACE Infiltration, GDL-Classic) | 2 |
| ERA.portal-overlay | `tools/build-dat-overlay.ts` (diff vs EoL, emit a ToD-format overlay DAT) + composite `DatFileSource` in the client; the set's Iteration record wins for DDD | 2 |
| ERA.operator-permissions | Ask the ClassicACE/Dekarutide/Seedsow operators about mirroring; fall back to an operator-hosted `dat_url` | 2 |
| ERA.sweep-ci | `tools/era-dat-sweep.ts` (exists) as a check per published set: every added or changed file parses with 0 leftover | 3 |

**Phase 3: classic-content correctness (≈8–12 days).**

| id | title | tier |
|---|---|---|
| ERA.skill-enum-customdm | `SkillId` 55–57 (Appraise/Armor/Sneaking) + skill lists driven entirely by the DAT SkillTable; remove the hardcoded groups at `EnchantmentManager.ts:170-176`, `CreatureStats.ts:81-90` | 1 |
| ERA.ruleset-formulas | Inventory every client-*computed* value (FORMULA.* sites); per-ruleset table sourced from ClassicACE `WorldRuleset` branches; prefer server-sent values | 2 |
| ERA.chargen-heritage-errors | Chargen with 13 DAT heritages on a 3-heritage server: the server's CharacterCreate error renders as retail does; drop `hasThroneOfDestiny` as an era signal | 2 |
| ERA.chargen-towns-from-layout | Town pins and labels read from layout 0x2100004a + StringTable at runtime (CustomDM "Hardcore", changed 0x23000001/02/0e) | 2 |
| ERA.weenie-sidefiles | Per-set weenie JSON side-files or remove the dependency (`main.ts:940-995`) | 2 |
| ERA.keymap-runtime | Read KeyMap/ActionMap defaults from the loaded DAT at runtime (Seedsow changes both) instead of the generated EoL table | 3 |

**Phase 4: verification harness (≈5–7 days, overlaps phase 3).**

| id | title | tier |
|---|---|---|
| ERA.docker-classicace | Docker ClassicACE (CustomDM + Infiltration rulesets) beside today's ACE container; `tools/ensure-ace-dats.sh` analogue per set | 1 |
| ERA.docker-gdl-classic | Docker GDL-Classic (C++/MySQL) for the GDL-family login + DDD path (Seedsow's live code is unpublished; GDL-Classic is the closest public one) | 2 |
| ERA.retail-ab-classic | `tools/launch-retail-client-mac.sh` with `acclient_CustomDM.exe` + the CustomDM set against the local ClassicACE: classic retail A/B scenes (char select, chargen, Holtburg, inventory) | 2 |
| ERA.scorecard-rows | Scorecard rows per profile (`verification/scorecard.json`): login, DDD accepted, char-select, chargen-3-heritage create, enter world, ObjectCreate parse rate, screen A/B match per scene | 2 |
| ERA.final-exe-build | Note in `docs/era-determination.md` that retail 11.6096 (2015, `ac1_acxp`) exists, newer than the 11.4186 decomp; check whether anything we cite from the decomp changed | 3 |

**Total for tier 3a:** about 24–34 loop-days, so **4–6 weeks**. Phase 1 alone also gives multi-server EoR support. Tier 2 (GDLE spike) shares ERA.login-version and ERA.ddd-retail-exact, so do it first, inside phase 1.

**Tier 3b (parked; only if a public 2001-protocol server appears):** pre-ToD container mode, old file formats (§3.2), the 2001 wire + Zone auth from a decompile of the PDB-less 2001 exe, and a non-LayoutDesc UI rebuilt from that exe. Estimate 4–8 months. Seed task if ever needed: ERA3B.predod-container (tier 3).

---

## 9. Verification

- **Offline:** `npx tsx tools/era-dat-sweep.ts <set-dir> --base dat` for every published set must show 0 leftover and 0 throws on added or changed files (the §3.1 results are the baseline). Unit tests: DDD bytes equal the raw Iteration record; LoginRequest carries the profile's version and auth style; the manifest resolver; the composite overlay source.
- **Local servers:** ClassicACE in Docker with CustomDM data files (it is ACE, so the existing ACE ops and bridge apply), plus GDL-Classic in Docker. One live session at a time, per the existing rule.
- **Retail reference side:** the patched classic exe under the Mac Wine launcher against the same local ClassicACE, scored with the existing retail A/B tooling (`tools/capture-retail-ab.ts`).
- **Scorecard:** DM-profile rows next to the EoR rows; progress for this lane is that scorecard, not task counts.

---

## 10. Risks

1. **DAT redistribution.** The classic sets are third-party builds of Turbine data, so hosting needs operator consent. Mitigation: `dat_url` / operator-hosted manifests; we host only with permission.
2. **Per-release churn.** ClassicACE bumps the version string and iterations every DAT release (c106 → c118). A stale overlay or manifest means a boot. Mitigation: manifests owned per server (upstream `client_version`/`dat_url`) plus the mismatch UX.
3. **Unpublished live server code.** Seedsow's public source is from 2018, and the live server may differ (auth style, DDD strictness). Mitigation: GDL-Classic Docker as the closest public reference, plus a live login probe before claiming support.
4. **Hidden exe patches.** We confirmed only the version literal in `acclient_CustomDM.exe`. Its 11.6096 base differs from our 11.4186 throughout, so a byte diff can't rule out other behaviour patches. Mitigation: retail A/B against that exe (ERA.retail-ab-classic) as the arbiter.
5. **Open-relay bridge abuse** if the target allowlist is wrong. Mitigation: the allowlist plus rate limits.
6. **Scope creep into 3b.** Classic servers (3a) don't need a true pre-ToD client, so don't let 3b work leak into 3a. 3b is a separate lane for AC1999 (§2.5).
7. **Storage and bandwidth.** About 1.2 GB per full set (portal 935 MB + cell 223–256 MB). R2 has no egress fees; overlays cut repeat downloads to tens of MB for EoL-cached players.

---

## 11. Reproduction recipe (2026-10-04 pass)

All downloads go to gitignored scratch, never into the repo (`dat-dm/` is **not** gitignored; `git check-ignore dat-dm/` prints nothing).

- **DM 2001 CD:**
  1. `curl -L -o dmcd.7z https://archive.org/download/asherons-call-dark-majesty-2001-microsoft-cd/Asherons.Call.Dark.Majesty.2001.Microsoft.CD.7z`
  2. `7z x dmcd.7z '*/ASHERON.mdf'`
  3. Convert the MDF's 2448-byte raw sectors to ISO: for each sector, take bytes 16..2064 (Mode 1).
  4. `7z x iso CELL.DAT PORTAL.DAT CLIENT.EXE`
- **ClassicACE CustomDM 1.60:** `megadl 'https://mega.nz/folder/EzojXSTJ#VW6ry7EEC_9Tp25eoYGDww'`, then `7z x`.
- **GDL-Classic / Seedsow "Classic Dereth 1.0":** `megadl 'https://mega.nz/#!c6RgjDxa!7ng3Gm_eh7JY2nBvHY7KMxMPP0_QJUH-oyF1MMmlVnY'`.
- **Sweep:** `npx tsx tools/era-dat-sweep.ts <dir> [--base dat] [--sample 200]`. It handles both containers.
- **Exe version info:** read VS_VERSION_INFO (UTF-16) from the PE. To check the version literal, search for `1802\0` / `c118`.

## Standing guidance for current work (cheap door-keepers, not new work)

1. Keep protocol constants and message layouts inside `@ac/network`, never inlined into renderer/UI code.
2. Keep honouring the DAT-only rule. Every hardcoded EoL value added today is era debt. That counts double for anything a classic set changes: CharGen starter areas, StringTables, KeyMaps/ActionMap, SkillTable.
3. Never key behaviour on DAT iteration numbers or `hasThroneOfDestiny`. Classic sets reuse 2072, or invent 20044, and send ToD = 1.
4. No loop/backlog tasks for this until the CORE lane and the EoL public release are done. This doc is the parking spot. The task list in §8 is a proposal and is **not** in tasks.json.

## Sequencing

1. CORE.* lane → EoL client playable and publicly released (current focus).
2. Phase 1 (with the tier-2 GDLE spike folded in): server profile, picker, login version and auth, retail-exact DDD, bridge targets. This unlocks Reefcull-class GDLE servers and multi-server EoR.
3. Phases 2–4: DAT-set pipeline, classic-content correctness, ClassicACE/GDL-Classic verification servers, scorecard rows.
4. Tier 3b: there is now evidence of a live pre-ToD server (AC1999, §2.5). It still comes after 3a. Jake wants every era supported, so this is the next lane once classic servers work, not a parked idea.

Context: aetherium.ac (a from-scratch DM server, closed, solo) proves the
appetite. Oldportal population (EoR ~1700 online versus DM ~30) proves EoL-first
is the right order. Dekarutide and Unfamiliar Shores (ClassicACE CustomDM) are
newer classic servers and the most likely first targets, since they run the
ACE-derived code we already mirror.
