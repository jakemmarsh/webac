# VirindiTank file formats: .met, .nav, .utl

Written 2026-10-07 for the acjs routine importer. Every layout below comes from source code. I then checked it by parsing real files:
108 `.met`, 108 `.nav` and 92 `.utl` from community repos, all parsing with 0 errors. The reference parsers are in `tools/vtank/` (`python3 -I tools/vtank/metscan.py <files…>`); the community samples are not in the repo (their sources are listed below). Our importer: `packages/shared/src/routines/vtank.ts` (AGENT.vtank-import); its fixtures in `tests/fixtures/vtank/` are our own files, checked with these parsers.

## Sources (pinned commits)

| Tag | What | URL |
|---|---|---|
| MF | metaf (J. Edwards), C# .met/.nav reader/writer, **GPLv3**: implement from this spec, do not copy code | https://github.com/JJEII/metaf/tree/838640fdfd/project |
| MF-notes | metaf's own reverse-engineering table of the .met/.nav layout | `project/notes.txt` lines 41–125 |
| VTC | VTClassic loot plugin source, an MIT-style Virindi public SVN clone | https://github.com/leo-duran/virindi-public-clone/tree/4a228c1149/trunk/VirindiTankLootPlugins |
| UB | UtilityBelt VTNav reader, independent confirmation of .nav axes and Z units | https://github.com/jaylane/utility-belt/tree/86db7ea235/UtilityBelt/Lib/VTNav |
| UB-geo | UtilityBelt landblock⇄coords math | https://github.com/jaylane/utility-belt/blob/86db7ea235/UtilityBelt/Lib/Geometry.cs (lines 109–131) |

Corpora I validated against: FlyingRagnar/asherons-call-metas@66986f2762 (108 met, many nav and utl), lino-ranta/vtank-routes@28bd2c2fa9 (nav), lino-ranta/vtank-loot-profiles@b30db19a39 (big real loot profiles), and Mag-nus/Mag-Plugins docs/Mag-Tools/Samples (utl).

## 0. Common text conventions (all three formats)

- These are line-oriented text files. **VTank writes CRLF.** Git checkouts are often LF-only: 20 of the 108 navs and 46 of the 92 utls were. Any **length/char counts embedded in the files** (.met `ba`, .utl requirement length codes, .utl block lengths) are always computed with **CRLF = 2 chars**, even in LF-only copies. All 70+ LF-only files validated only under that assumption. Recommendation: normalize to CRLF first (`\r?\n` → `\r\n`), then parse as a char stream.
- No BOM in any sample, and every sample was pure ASCII. **Unverified:** the encoding of non-ASCII names. VTC writes with .NET `StreamWriter(Stream)`, which is UTF-8 without a BOM. The VTank .met/.nav writer is closed-source. Accept UTF-8 and fall back to Windows-1252.
- Numbers: ints are decimal and **signed int32**. Landblocks and GUIDs ≥ 0x80000000 appear negative, e.g. BlockE `-924254208` = 0xC8E90000. Doubles are written with `.` in every sample. VTC's `HaxConvertDouble` (Constants.cs:416) does `s.Replace(',', '.')` before parsing, which suggests comma-decimal files exist from European locales. Accept `,` as a decimal point.
- Regex fields are **.NET regex** syntax. Samples use `(?<name>...)` named groups, which JS also supports. Empty pattern = match anything (for ChatMatch and ChatCapture).

---

## 1. `.met`: VirindiTank meta

### 1.1 It's a generic typed-value serialization

`.met` is VTank's generic "typed value" serializer. Each value is a **type tag line** followed by its payload:

| tag | payload |
|---|---|
| `i` | 1 line: int32 |
| `s` | 1 line: string (raw, no escaping; cannot contain CR/LF) |
| `d` | 1 line: double |
| `ba` | 1 line: N (int), then **exactly N chars** of raw content (may contain CRLFs; **may NOT end with CRLF**, see CreateView) |
| `TABLE` | `ncols` line, `ncols` column-name lines, `ncols` column-type lines (always `n`), `nrows` line, then `nrows × ncols` typed values (row-major) |

(I found no other tag in 108 files. Counts: i 37855, s 35460, TABLE 14251, ba 1347, d 72.) The fully generic char-stream parser in `validators/metscan.py` parsed all 108 files with 0 leftover bytes. **Recommendation:** parse generically into a value tree, then interpret it. This is order-agnostic for keyed tables, and the `ba` byte counts take care of CreateView's missing newline for free.

Only two TABLE headers ever occur: `2 / K / V / n / n` (4850×) and `2 / k / v / n / n` (9401×).
- Uppercase `K`,`V` = a **list of typed child ops**: key = `i <typeId>`, value = that op's data. Used by All/Any/Not/DoAll.
- Lowercase `k`,`v` = a **named-parameter dict**: key = `s <paramName>`, value = typed param.

### 1.2 File header and rules (MF Meta.cs:12, 73–107; Rule.cs:148–194)

```
1
CondAct
5
CType
AType
CData
AData
State
n
n
n
n
n
<ruleCount>
{ruleCount ×:
  i            ← CType
  <condTypeId>
  i            ← AType
  <actTypeId>
  <condition data (typed value, see 1.3)>
  <action data   (typed value, see 1.4)>
  s            ← State
  <stateName>
}
```
This is the same generic table shape as `TABLE` but without the leading `TABLE` tag: `1` then the table name `CondAct`. **Unverified:** what the leading `1` means (maybe a table count or version). Every file has exactly these 13 lines.

**States** are not stored separately: a state is the set of rules whose `stateName` matches, in file order. metaf starts a new state whenever the name changes between consecutive rules (Meta.cs:90–104). To be robust against interleaving, **group by name, keeping first-appearance order**. The meta starts in state `Default` (VTank convention; every sample has one). Rule order within a state is evaluation order.

### 1.3 Condition type IDs and data (MF Enums.cs:6–38; MF-notes:56–86; per-type files `Operations/Conditions/C*.cs`)

Leaf data is shown as the exact line sequence after the rule's `i <id>`. "dict{…}" means a lowercase `TABLE 2 k v n n <count>` followed by `s <key>` + typed value pairs.

| id | name (metaf) | in-game | data on disk |
|---|---|---|---|
| 0 | Never | Never | `i` `0` |
| 1 | Always | Always | `i` `0` |
| 2 | All | All | `TABLE 2 K V n n <count>` then count × (`i` `<condId>` `<cond data>`) (recursive) |
| 3 | Any | Any | same as All |
| 4 | ChatMatch | Chat message matches regex | `s` `<regex>` |
| 5 | MainSlotsLE | Main pack slots ≤ | `i` `<slots>` |
| 6 | SecsInStateGE | Seconds in state ≥ (resets on meta stop/start) | `i` `<seconds>` |
| 7 | NavEmpty | Navroute empty | `i` `0` |
| 8 | Death | Character death | `i` `0` |
| 9 | VendorOpen | Any vendor open | `i` `0` |
| 10 | VendorClosed | Vendor closed | `i` `0` |
| 11 | ItemCountLE | Inventory item count ≤ (exact name, not regex) | dict{ `n`: s itemName, `c`: i count } (2 rows) |
| 12 | ItemCountGE | Inventory item count ≥ | dict{ `n`: s itemName, `c`: i count } |
| 13 | MobsInDist_Name | Monster name count within distance (≥ count) | dict{ `n`: s nameRegex, `c`: i count, `r`: d range } (3 rows) |
| 14 | MobsInDist_Priority | Monster priority count within distance | dict{ `p`: i priority, `c`: i count, `r`: d range } |
| 15 | NeedToBuff | Need to buff (VTank's buff settings) | `i` `0` |
| 16 | NoMobsInDist | No monsters within distance | dict{ `r`: d range } |
| 17 | BlockE | Landblock == | `i` `<int32 landblock, low 16 bits 0>` (e.g. 0x8B370000) |
| 18 | CellE | Landcell == | `i` `<int32 full landcell>` |
| 19 | IntoPortal | Entered portal space | `i` `0` |
| 20 | ExitPortal | Exited portal space | `i` `0` |
| 21 | Not | Not | `TABLE 2 K V n n 1` `i` `<condId>` `<cond data>` (count must be 1) |
| 22 | PSecsInStateGE | Seconds in state (persistent) ≥ | `i` `<seconds>` |
| 23 | SecsOnSpellGE | Time left on spell ≥ | dict{ `sid`: i spellId, `sec`: i seconds } |
| 24 | BuPercentGE | Burden percent ≥ | `i` `<percent>` |
| 25 | DistToRteGE | Distance to route ≥ | dict{ `dist`: d distance } |
| 26 | Expr | Expression | dict{ `e`: s expression } |
| 27 | (ClientDialogPopup) | (not in current VT; metaf rejects it) | **unknown**: treat as unsupported |
| 28 | ChatCapture | Chat message capture | dict{ `p`: s regex, `c`: s colorIdList } (colorIdList is `;`-separated chat-type ids, e.g. `0;2`; empty = any) |

Units: the distances in 13/14/16/25 and the watchdog range are in **yards** in VTank's UI, per the metaf reference examples (`metafReference.af` 304, 348–360, 519–528). AC treats 1 yard ≈ 1 m in game units, so this is close but not exact. **Unverified** from VTank source.

### 1.4 Action type IDs and data (MF Enums.cs:40–59; MF-notes:88–106; `Operations/Actions/A*.cs`)

| id | name | data on disk |
|---|---|---|
| 0 | None | `i` `0` |
| 1 | SetState | `s` `<stateName>` |
| 2 | Chat | `s` `<text>` (sent as if typed, e.g. `/vt nav load foo`) |
| 3 | DoAll | `TABLE 2 K V n n <count>` then count × (`i` `<actId>` `<act data>`) (recursive) |
| 4 | EmbedNav | `ba` `<N>` then N chars = `<navName>\r\n<nodeCount>\r\n<.nav body>` (see 1.5) |
| 5 | CallState | dict{ `st`: s toState, `ret`: s returnState } |
| 6 | Return | `i` `0` (pops the CallState stack) |
| 7 | DoExpr | dict{ `e`: s expression } |
| 8 | ChatExpr | dict{ `e`: s expression } (evaluates, then sends the result as chat) |
| 9 | SetWatchdog | dict{ `s`: s state, `r`: d range, `t`: d seconds } (calls `state` if the player hasn't moved ≥ range in the last `t` s) |
| 10 | ClearWatchdog | dict{} (`TABLE 2 k v n n 0`) |
| 11 | GetOpt | dict{ `o`: s vtOptionName, `v`: s variableName } |
| 12 | SetOpt | dict{ `o`: s vtOptionName, `v`: s expression } |
| 13 | CreateView | dict{ `n`: s viewName, `x`: **`ba`** N + N chars of XML } |
| 14 | DestroyView | dict{ `n`: s viewName } |
| 15 | DestroyAllViews | dict{} |

**CreateView quirk** (MF Meta.cs:142–163, ACreateView.cs:37–97, notes.txt:89): the XML bytes are written with **no trailing CRLF**, so the next line (`s` + state name) starts on the same physical line as the end of the XML. A char-stream reader that reads exactly N chars after `ba N` handles this. A line-splitting reader breaks here. metaf also tolerates multi-line XML. No CreateView appeared in the samples, so this comes from the metaf source only.

### 1.5 Embedded navs (MF AEmbedNav.cs:33–91)

`ba N` content = `navName CRLF nodeCount CRLF` followed by a complete `.nav` body (section 2, starting at `uTank2 NAV 1.2`). N counts all of these chars, CRLF = 2. Verified on all 1347 embeds in the corpus: N matched exactly, and the outer `nodeCount` equaled the nav's own node count in every case. Embed names are free text. metaf maps `[None]` to "no name".

**Unverified:** the layout of an embed that never had a nav loaded. metaf only reads the nav body when N > 5, and no corpus sample had an empty embed. Handle it defensively: if the content after the two header lines is empty, treat the nav as empty.

Once it runs, an EmbedNav action loads that route as VTank's current nav.

### 1.6 Expressions

Expr, DoExpr, ChatExpr and SetOpt values are VTank meta-expression strings (`getvar[x]`, `setvar[...]`, `echo[...]`, etc.). The function list is in metaf `Bundle/metafReference.af` §8 (lines ~633–760) and at virindi.net/wiki "Meta_Expressions". Many metas also call UtilityBelt functions, and Chat actions send `/ub ...` commands, both of which assume plugins we don't have.

---

## 2. `.nav`: VirindiTank navroute (MF Nav.cs:87–143; NavNodes/*.cs; UB VTNavRoute.cs:63–170)

```
uTank2 NAV 1.2
<navType>                     ← 1 circular, 2 linear, 3 follow, 4 once
if navType == 3 (follow):
  <targetName>                ← s
  <targetGuid>                ← int32 (signed)
  (end of nav)
else:
  <nodeCount>
  nodeCount × { <nodeType> <node fields...> }
```
Nav types (MF Enums.cs:61–67; UB enums.cs:21–26, where 3 is called "Target"): **1 Circular** loops forever. **2 Linear** ping-pongs back and forth. **3 Follow** chases a player. **4 Once** consumes each node as it is reached. Corpus counts: 1:17, 2:50, 4:41.

### 2.1 Node types (MF Enums.cs:77–92; notes.txt:111–125; UB enums.cs:7–19)

Every node starts with `<type>` `<X=EW>` `<Y=NS>` `<Z>` `0`. The 4th line is always the literal `0`; metaf rejects anything else. Then come the type-specific lines:

| type | name | extra lines after `0` |
|---|---|---|
| 0 | Point | (none) |
| 1 | Portal (**deprecated**) | `int32 portalGuid` |
| 2 | Recall | `int32 spellId` (table below) |
| 3 | Pause | `pause` in **milliseconds**. Corpus: `5000`. metaf's reference.af says ms, but its notes.txt wrongly says "seconds". UB parses it as int |
| 4 | Chat | `text` (a chat line or command, e.g. `/ub jumpsw 180 1000`) |
| 5 | OpenVendor | `int32 vendorGuid`, `vendorName` |
| 6 | Portal/NPC ("Use Portal/NPC") | `objName`, `int objectClass` (14 portal, 37 NPC, 10 container), literal `True`, `objX(EW)`, `objY(NS)`, `objZ` |
| 7 | NPCTalk | same 6 lines as type 6 (objectClass 37) |
| 8 | Checkpoint | (none) |
| 9 | Jump | `headingDegrees` (double; UB parses int), `holdShift` (`True`/`False`), `delayMs` (double) |
| 99 | Other | defined in VTank source per metaf/UB enums. No layout is known and it was never seen. Reject it |

The literal `True` line in types 6 and 7: metaf requires exactly `True`. Its meaning is **unknown**. GUIDs in .nav files are only valid on the server that recorded them, so on import prefer the name and coordinates over the GUID.

Recall spell ids (MF NRecall.cs:32–59): 48 Primary Portal Recall, 2647 Secondary Portal Recall, 1635 Lifestone Recall, 1636 Lifestone Sending, 2645 Portal Recall, 2931 Recall Aphus Lassel, 2023 Recall the Sanctuary, 2943 Recall to the Singularity Caul, 3865 Glenden Wood Recall, 2041 Aerlinthe Recall, 2813 Mount Lethe Recall, 2941 Ulgrim's Recall, 4084 Bur Recall, 4198 Paradox-touched Olthoi Infested Area Recall, 4128 Call of the Mhoire Forge, 4213 Colosseum Recall, 5175 Facility Hub Recall, 5330 Gear Knight Invasion Area Camp Recall, 5541 Lost City of Neftet Recall, 4214 Return to the Keep, 6150 Rynthid Recall, 6321 Viridian Rise Recall, 6322 Viridian Rise Great Tree Recall, 6325 Celestial Hand Stronghold Recall, 6327 Radiant Blood Stronghold Recall, 6326 Eldrytch Web Stronghold Recall.

### 2.2 Coordinates

- **Line 1 = E/W, line 2 = N/S, line 3 = Z.** East and north are positive; west and south are negative. Sources: UB VTNPoint.cs:72–75 (`EW`, then `NS`, then `Z`), and confirmed on data: `runToHbCasino.nav` starts at `33.579 / 42.070` = Holtburg 42.1N 33.6E, and `Kara-AroundLake.nav` sits at `47.29 / -83.63` = Kara 83.6S 47.3E.
- Units are **map units** (the numbers you see in "42.1N, 33.6E"). 1 map unit = 240 m, so 1 landblock (192 m) = 0.8 units.
- **Z = world altitude in metres / 240** (UB multiplies by 240 everywhere: VTNPoint.cs:92, 106–107, VTNavRoute.cs:282). Holtburg samples show z ≈ 0.39, i.e. ~94 m.
- Conversion to and from a landblock-local position (UB-geo 109–131, simplified):
  `EW = (lbX*192 + localX)/240 − 101.95`, `NS = (lbY*192 + localY)/240 − 101.95`, where lbX = cellId>>24 and lbY = (cellId>>16)&0xFF. Inverse: `lbX = floor((EW+101.95)*240/192)`, `localX = (EW+101.95)*240 − lbX*192`, and the same for NS.
- **Dungeons:** VTank still records these "global" coordinates indoors. Dungeon landblocks sit off the normal map, giving values like `-101.7 / -96.5` (Town Network, landblock 0x0167). Converting them with the formula above gives back the dungeon landblock and its local offset. You **cannot recover the EnvCell id** (the low 16 bits) from a nav point: resolve it by point-in-cell lookup.
- metaf's EmbedNav transform `{a b c d e f g}` (`x' = a x + b y + e`, `y' = c x + d y + f`, `z' = z + g`) uses this same unit system. The documented hive offsets are multiples of 0.8, one landblock (metafReference.af 479–496).

---

## 3. `.utl`: VTClassic loot profile (VTC "VTClassic Shared/LootRules.cs", FileVersioning.cs, UTLFileExtraBlockManager.cs, UTLBlock_SalvageCombine.cs, Constants.cs)

### 3.1 File layout (LootRules.cs:3129–3173 read, 3176–3195 write)

```
UTL                       ← absent in version-0 files (then line 1 is ruleCount)
<fileVersion>             ← 1 (MAX_PROFILE_VERSION, FileVersioning.cs:49); reject > 1
<ruleCount>
ruleCount × RULE
EXTRA BLOCKS until EOF
```
Version 1 has both features (FileVersioning.cs:51–64): a rule expression line and requirement length codes. Version 0 has neither. Every one of the 92 corpus files was version 1.

### 3.2 RULE (LootRules.cs:2944–3001 read, 3003–3043 write)

```
<name>
<customExpression>        ← v1 only; in practice always empty (blank line)
<pri>;<action>[;<reqType>]*     ← the "big line"
<keepCount>               ← ONLY if action == 10 (KeepUpTo)
for each reqType in the big line (in order):
  <lengthCode>            ← v1 only: number of chars of this requirement's data, CRLF=2 each
  <requirement data lines>
```
- `pri` is written and read but **never used for ordering**. `Classify` (LootRules.cs:3059–3072) walks the rules in **file order, first full match wins**, and no match means NoLoot.
- A rule matches when **all** of its requirements match (AND). A rule with zero requirements matches everything.
- Unknown requirement types are skipped using the length code (2973–2985). **Keep-up-to-N** is action `10` plus the next line N, which is `LootActionData` and is passed to VTank as data1 (LootCore.cs:118).

Action ids, `eLootAction` (Constants.cs:314–327): 0 NoLoot, **1 Keep**, **2 Salvage**, **3 Sell**, **4 Read**, 5–9 User1–User5, **10 KeepUpTo**.

### 3.3 Requirement types (eLootRuleType, LootRules.cs:130–170; Read() of each class)

`vk` = a Decal value key. A double is any decimal, with `,` also accepted (HaxConvertDouble). Data lines are listed in order.

| id | name | data lines | match semantics (Match()) |
|---|---|---|---|
| 0 | SpellNameMatch | regex | any spell on item whose name matches |
| 1 | StringValueMatch | regex, `StringValueKey` | regex matches item string prop (Name=1 most common) |
| 2 | LongValKeyLE | int value, `IntValueKey` | prop ≤ value (missing prop = 0) |
| 3 | LongValKeyGE | int value, `IntValueKey` | prop ≥ value |
| 4 | DoubleValKeyLE | double value, `DoubleValueKey` | (float)prop ≤ (float)value |
| 5 | DoubleValKeyGE | double value, `DoubleValueKey` | (float)prop ≥ (float)value |
| 6 | DamagePercentGE | double | **always false** (obsolete) |
| 7 | ObjectClass | `ObjectClass` id | item's Decal ObjectClass == id |
| 8 | SpellCountGE | int | number of spells ≥ n |
| 9 | SpellMatch | matchRegex, notMatchRegex, int count | ≥ count spells match `matchRegex` and don't match `notMatchRegex` (empty = ignore) |
| 10 | MinDamageGE | double | `MaxDamage − Variance*MaxDamage ≥ v` |
| 11 | LongValKeyFlagExists | int mask, `IntValueKey` | `(prop & mask) > 0` |
| 12 | LongValKeyE | int value, `IntValueKey` | prop == value |
| 13 | LongValKeyNE | int value, `IntValueKey` | prop != value |
| 14 | AnySimilarColor | R, G, B (ints), maxDiffH, maxDiffSV (doubles) | some palette's example color is within the HSV tolerance |
| 15 | SimilarColorArmorType | R, G, B, maxDiffH, maxDiffSV, armorGroup (string) | color match restricted to an armor group |
| 16 | SlotSimilarColor | R, G, B, maxDiffH, maxDiffSV, slot (int) | color match on one palette slot |
| 17 | SlotExactPalette | slot (int), palette (int) | exact palette in slot |
| 1000 | CharacterSkillGE | int value, VTCSkillID | **character's** buffed skill ≥ value |
| 1001 | CharacterMainPackEmptySlotsGE | int | character's free main-pack slots ≥ n |
| 1002 | CharacterLevelGE | int | character level ≥ n |
| 1003 | CharacterLevelLE | int | character level ≤ n |
| 1004 | CharacterBaseSkill | VTCSkillID, int min, int max | min ≤ base skill ≤ max |
| 2000 | BuffedMedianDamageGE | double | Mag-Tools computed (melee) |
| 2001 | BuffedMissileDamageGE | double | computed |
| 2003 | BuffedLongValKeyGE | double value, `IntValueKey` | computed buffed prop ≥ |
| 2005 | BuffedDoubleValKeyGE | double value, `DoubleValueKey` | computed buffed prop ≥ |
| 2006 | CalcdBuffedTinkedDamageGE | double | computed |
| 2007 | TotalRatingsGE | double | sum of ratings ≥ |
| 2008 | CalcedBuffedTinkedTargetMeleeGE | 3 doubles: targetDoT, targetMeleeDefBonus, targetAttackBonus | computed |
| 9999 | DisabledRule | `true`/`false` | when `true` the **whole rule never matches** (it acts as a rule-level "disabled" flag stored as a requirement). In VTC's EarlyMatch it never matches even when `false` (LootRules.cs:1823–1832), which is odd. Treat `false` as a no-op and `true` as "rule disabled" |

Corpus frequency (22 big profiles): 1, 1001, 3, 5, 7, 4, 2, 12, 13, 9999, 9, 11, 10, 15, 1004, 14, 0, 17, 1003, 1000, 2007, 16, 8. Every one of the 23 types seen validated its length codes. Types 6, 1002, 2000, 2001, 2003, 2005, 2006 and 2008 never appeared. Their layouts come from source only.

Example (Bellas.utl), with the length codes verified:
```
(*) Rare            ← name
                    ← empty expression
0;1;12              ← pri 0, Keep, one LongValKeyE requirement
18                  ← "23308\r\n218103850\r\n" = 18 chars
23308               ← value
218103850           ← IntValueKey.IconUnderlay (0x0D00002A): the "rare" underlay icon
(*) Aug Gem

0;10;1              ← KeepUpTo, one StringValueMatch
1                   ← keep up to 1
27
Blank Augmentation Gem   ← regex (unanchored; note many profiles use ^...$)
1                   ← StringValueKey.Name
```

### 3.4 Value-key enums (Constants.cs:42–259, the editor's copy of Decal's enums)

- **Low ids are AC/ACE property ids.** `IntValueKey` < 0x10000 = ACE `PropertyInt`: Burden 5 = EncumbranceVal, Value 19, ArmorLevel 28, Workmanship 105, Material 131 = MaterialType, WieldReqType 158, WieldReqValue 160 = WieldDifficulty, Imbued 179, DamRating 370, and so on. `DoubleValueKey` low ids = ACE `PropertyFloat`: ManaRateOfChange 5 = ManaRate, MeleeDefenseBonus 29 = WeaponDefense, ElementalDamageVersusMonsters 152 = ElementalDamageMod. `StringValueKey` low ids = ACE `PropertyString`: Name 1, Inscription 7, and so on. I spot-checked these against `reference/ACE/.../Properties/*.cs`.
- **High ids are Decal-synthesized** and have no ACE property. You must compute them: IntValueKey 0x0D000000+ (Type, Icon 0x0D000001, Container, Landblock, StackCount 0x0D000006, SpellCount 0x0D00001E, MaxDamage 0x0D000022, IconOutline 0x0D000010, IconUnderlay 0x0D00002A, …) and DoubleValueKey 0x0A000000+ (SlashProt…ColdProt 0x0A000000–6, Variance 0x0A00000B, AttackBonus 0x0A00000C, DamageBonus 0x0A00000E, SalvageWorkmanship 0x0A000009, …). The full lists are at Constants.cs:61–210. StringValueKey SecondaryName = 0x0B000000.
- **ObjectClass** (Constants.cs:212–258) is **Decal's** classification, not ACE `ItemType`: 0 Unknown, 1 MeleeWeapon, 2 Armor, 3 Clothing, 4 Jewelry, 5 Monster, 6 Food, 7 Money, 8 Misc, 9 MissileWeapon, 10 Container, 11 Gem, 12 SpellComponent, 13 Key, 14 Portal, 15 TradeNote, 16 ManaStone, 17 Plant, 18 BaseCooking, 19 BaseAlchemy, 20 BaseFletching, 21 CraftedCooking, 22 CraftedAlchemy, 23 CraftedFletching, 24 Player, 25 Vendor, 26 Door, 27 Corpse, 28 Lifestone, 29 HealingKit, 30 Lockpick, 31 WandStaffOrb, 32 Bundle, 33 Book, 34 Journal, 35 Sign, 36 Housing, 37 Npc, 38 Foci, 39 Salvage, 40 Ust, 41 Services, 42 Scroll. **Unverified:** Decal's exact derivation from ItemType/flags, since Decal itself isn't in these sources. You will need a mapping from ItemType plus heuristics.
- **VTCSkillID** (Constants.cs:260–312) = AC skill ids (Axe 1 … Summoning 54), the same numbering as ACE `Skill`.

### 3.5 Extra blocks (UTLFileExtraBlockManager.cs:94–120)

After the rules, repeat until EOF: `<blockTypeId>`, `<lengthChars>` (CRLF = 2), then that many chars. Skip unknown blocks by length. The only known block is **`SalvageCombine`** (UTLBlock_SalvageCombine.cs:272–300). It is present in every corpus file. Inside it:
```
<formatVersion>           ← 1
<defaultCombineString>    ← workmanship ranges that may combine, e.g. "1-6, 7-8, 9, 10" (',' or ';' separated, 'a-b' ranges)
<nMaterialOverrides>
n × { <materialId (ACE MaterialType)>  <combineString> }
-- optional (newer blocks only; absent if the block ends here, e.g. Mag's "I Hold Steel.utl"): --
<nValueModes>
n × { <materialId> <int value> }      ← MaterialValueModeValues (meaning not traced)
```
This drives salvage-bag combining. It isn't needed for keep/sell/salvage decisions.

---

## 4. Unverified items and gaps

1. The .met header's leading `1`, and the `n` column-type markers: they are constant in every file, and their meaning is unknown.
2. The .met/.nav text encoding for non-ASCII characters (every sample is ASCII).
3. Empty EmbedNav `ba` content (no sample).
4. Condition ids absent from the 108-file corpus: 0, 5, 9, 10, 14, 22, 23, 24, 25 (and 27). Action ids absent: 11–15. Their layouts come from the metaf source only. They are consistent with the generic tag grammar that every observed id followed.
5. Follow navs (type 3) and node types 5 (OpenVendor), 7 (NPCTalk), 8 (Checkpoint) and 9 (Jump) were not in the corpus. Their layouts come from metaf, and UB agrees for Jump, OpenVendor and Follow.
6. The `True` literal in nav node types 6 and 7: meaning unknown.
7. The units of the distance fields in .met (yards per the metaf docs). VTank's own source is closed, so nothing here is checked against it.
8. Decal ObjectClass derivation and the semantics of the Decal-synthesized value keys (0x0A……/0x0D……) need Decal's source. That is not covered here.
9. DisabledRule (9999) with value `false` is never a match in VTC's EarlyMatch but is a match in Match(). That inconsistency is in VTC itself.
10. VTank (closed source) may write .met tables with dict keys in a different order than metaf expects. metaf requires the fixed order and parsed every corpus file, but a key-based generic parse is safer.

11. **What our importer maps, and what stays "can't test" (2026-10-07).** Decal keys mapped to ACE properties: Type → PropertyInt ItemType 1, Coverage → ClothingPriority 4, EquipableSlots → ValidLocations 9, DamageType 45, MaxDamage → Damage 44, Variance → PropertyFloat 22, Icon → DID 8, IconOverlay → DID 50, IconUnderlay → DID 52 (rares: 0x06005B0C). Object classes HealingKit 29 / Lockpick 30 / Book 33 → ObjectDescriptionFlags Healer 0x10000 / Lockpick 0x20000 / Book 0x100; Salvage 39 → ItemType TinkeringMaterial (ACE salvage bags). Character requirements 1000–1004, MinDamageGE 10 and SlotExactPalette 17 (`Palettes[slot] & 0xFFFFFF`, our ObjDesc subpalettes in order) run. TotalRatingsGE 2007 runs: the sum of PropertyInt 370–376 and 379, from VTClassic's `ComputedItemInfo.cs`. **Correction (2026-10-07):** the full VTClassic source is public and MIT-licensed at `http://www.virindi.net/repos/virindi_public/trunk/VirindiTankLootPlugins/`, including `VTClassic/VTClassic/ComputedItemInfo.cs`, `VTClassic Shared/ColorXML.cs` and `ColorSlots.Default.xml` (the armour-group slot table). Our first pinned copy was a subset of it. VirindiTank itself (uTank2) is closed source; Virindi publishes only the loot plugin, the View Service Connector, Reporter and the orderer. **Similar colour (14/15/16) runs (2026-10-07), with the example colour inferred clean-room.** VTank's license forbids decompiling it, so we didn't. `PaletteData.ExampleColor` is taken to be the palette's colour at the middle of the subpalette's range, `palette[offset + length/2]` (entries). Evidence: of the corpus's 23 distinct target colours, 21 are exactly that colour for a palette/range pair that a ClothingTable can put on an item (first entry explains 7, last 8, middle−1 9). That includes all 12 distinctive colours, which occur only 1–6 times anywhere in portal.dat. The other two (85,238,17 and 48,128,204) appear nowhere in the DAT, so they were typed by hand. Live, Scribe Renald the Elder's robe shows example cfcfcf, the corpus target 207,207,207. The match test is VTClassic's own: hue diff ≤ maxHue with no wrap-around, and the S/V Euclidean distance ≤ maxSV. Armour groups → slots come from `ColorSlots.Default.xml` (`VTCLASSIC_COLOR_SLOTS`). Test: tests/verify-vtank-import.ts ("the example colour is the middle of the subpalette range", DAT-backed).

## 5. Files

- `tools/vtank/metscan.py`, `navscan.py`, `utlscan.py`: the reference parsers that validated this spec over the corpora (`python3 -I tools/vtank/x.py <files…>`).
- `tests/fixtures/vtank/`: our own small `.met` / `.nav` / `.utl` files in these formats (All, Any, Not, EmbedNav, a pause and a recall step, KeepUpTo, ObjectClass, a disabled rule, a SalvageCombine block).
