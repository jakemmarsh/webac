# Automation & plugins: Decal research, design direction, UI mockup

Status: **research + design proposal, nothing implemented.** Researched 2026-09-28 at Jake's request
("support Decal for familiarity, or build first-party systems for the real use cases?").
No tasks filed yet. If you pick this up, file tasks from §6 with `node tools/task-status.mjs add --tier N`.

Related: GAP.47 (`docs/gap-reconciliation-2026-06-12.md`) already established that retail had **no**
chat-macro / automation feature. Everything here is a non-retail add-on layer and must ship
**off by default** (CLAUDE.md "Always Match Retail's Defaults").

---

## 1. What Decal was

- Community plugin framework for the retail client (~2001 onward), never part of AC. It injects into
  `acclient.exe`, hooks DirectX to draw overlays, parses the network protocol and reads client memory
  ("memlocs", re-published per client patch; last set for the June 2015 hotfix 0.0.11.6096).
- Plugin API (COM, later .NET via `Decal.Adapter`): `CoreManager.Current` exposing `CharacterFilter`
  (own stats/skills/spells), `WorldFilter` (every known object + create/change/release events),
  `EchoFilter` (raw server messages), `ACHooks` (actions: use item, cast, select, chat). Plus the Decal
  Hotkey System and "views" (plugin windows); Virindi View Service (VVS) later became the de-facto UI toolkit.
- Latest release v2.9.7.5 (.NET 2.0); 2021 public beta was its first update in 8 years. Still standard on
  ACE emulator servers, launched via ThwargLauncher (successors of ACQLaunch / AC Dual Client / AC Multi Client).

## 2. Turbine's policy (primary sources)

- **June 6 2002, "Macros, 3rd-Party Apps and XP… Oh My!"** (MS Zone letter, mirrored on the AC Fandom wiki):
  survey showed only a minority opposed macros "for things such as trade skills and providing services to
  other players"; a majority opposed macroing kills for XP. AC1 response: "hunt down popular combat macro
  locations and reduce their effectiveness" (not tool bans). 3rd-party apps: blocking all is "difficult or
  impossible"; majority felt they "added to the overall enjoyment of the game"; Turbine reserved the right to
  block specific bad ones.
- **Feb 27 2004, "The Envoys and the Code of Conduct"** (Katahdin, CS manager): **UCM tests**: the character is
  put in limbo (no damage dealt/taken) and must repeat a string/sentence within 30 s. Refusing, failing or
  logging out = ban; 3 days / 7 days / 1 year, all servers; mages vulning for others are testable too.
  Rationale: UCMs "hog areas and deprive characters playing legitimately of a level playing field".
- Wiki definitions: **ACM** (Attended Combat Macro) allowed; **UCM** (Unattended) forbidden.
- **Net line: attended automation, service bots and add-ons tolerated; unattended XP farming enforced against.**

## 3. The plugin ecosystem, by problem solved

(Full ~150-entry table: AC Fandom wiki "Plugins" page. Fetch via the MediaWiki API, since the HTML page 402s:
`curl -A Mozilla/5.0 'https://asheron.fandom.com/api.php?action=parse&page=Plugins&prop=wikitext&format=json&formatversion=2'`.
acpedia.org returns 403 to fetches; virindi.net wiki is intermittently 503.)

| Problem | Plugins | Notes |
|---|---|---|
| Combat/leveling bot | **Virindi Tank** (VTank, "ACM-oriented"), LifeTank/LifetankX/Lifetank 2015, SkunkWorks (scriptable, pixel checks), AC Tool (2002, external keystroke macro, blind) | VTank: melee/missile/mage/hybrid/2H/void/summoning, attack priorities, best attack type, debuffs, war/void streaks, heal, rebuff-when-idle, loot |
| Scripted bot behavior | VTank **metas** (`.met`: state machine of condition→action rules) + **navroutes** (`.nav`: circular/linear/follow/once), metaf (text editor for both), IBControl (9-char fellowship control meta) | Typical loop: hunt → town → sell → rebuff → repeat |
| Loot rules | **VTClassic** (`.utl` profiles, open source) | The shared rule format, also read by Mag-Tools and UtilityBelt |
| Buffing | Alinco Buffs / Alinco3 Buffs, BuffMe, Quick Buff, Cast It!, GearFoundry | "Self buffing in two clicks"; retail buffing = dozens of manual casts |
| Inventory/vendor/trade | Mag-Tools (autopack, vendor auto buy/sell, auto add-to-trade, auto-accept by regex), UtilityBelt (AutoVendor, AutoSalvage, AutoTinker, AutoTrade, AutoXp), Sellvage, MuleThis, mudsort, SSSort, Reloader | |
| Crafting chores | Mag-Tools (aetheria revealer, shattered key fixer, heart carver, key ringer), Fortune Hunter, The Deep, StuffExchanger, RareExchanger, ScrollReader3, XPender | |
| Navigation/maps | GoArrow, UtilityBelt (Arrow, DungeonMaps, LandscapeMaps, VisualNav, Jumper), Tings, Minimap, SkunkVision (unclimbable slopes, impassable water) | |
| Info/tracking | Mag-Tools trackers, Virindi Reporter (XP/h), Target Info / Target HUD (debuffs, weaknesses), Squire (gear spells + mana), Corpse Tracker, Mob Tracker, DamageTracker, Gleaner, Quest Timer, UB QuestTracker | |
| HUD/UI | Virindi Views/HUDs, Decal/Virindi Hotkey System, Defective (free-form item/spell bar), Hex (hide UI), Virindi Window Tool, Xnuchat | |
| Chat | Virindi Chat System 5, UB ChatFilter/ChatLogger/Aliases, Hush!, Silence, LogWiz, A.K.A, Babel Fish | |
| Gear planning | Mag-SuitBuilder, CovenantAdvisor, IronVsGranite, Endy's Tinkering Calculator | |
| Multiboxing | Virindi Follower, IBControl, Mag-Filter (auto login/retry), ThwargLauncher, AC Dual Client | Mag-Plugins says outright it's built for multi-account players |
| Online stats | TreeStats, CharInfo, HWACStats, PK Hunter | |

### Service bots (automated characters serving other players by `/tell` keyword)

- **Buff bots**: in Holtburg / Shoushi / Yaraq / Sanamar / allegiance mansions; free on donations or paid in
  comps/tradeables; usually also summon 2 portal ties. Castaway, ACManager (ACE-only buff bot, profile
  fallback L8→L1), DoThingsBot, BuffCaster (VTank meta), OpenAC BuffBot.
- **Portal bots**: summon ties on command; multi-character on one account for many destinations (Tings, ACManager).
- **Trade bots**: sell via Secure Trade, mostly in the Marketplace, priced in MMD notes (Darktide: behind
  housing barriers). Mule Trade It!; buyer side: ShoppingCart, Bot Shopper.
- **Tinker/craft bots**: CraftBot, DoThingsBot (tinker/buff/craft/portal, `recipes.xml`), Tings (cooking/tinkering).

### Underlying use cases

1. The grind (steep XP curve, then luminance). 2. Tedium (rebuff, pack, vend, salvage, turn-ins).
3. Multiboxing was normal. 4. The client hid information (no XP rate, no nav arrow, no buff timers,
no target debuff display). 5. Player services (buffs/portals/trade/crafting) as a social economy.

## 4. Precedent: OpenAC

`github.com/eriknihlen/OpenAC`: open-source C#/.NET 10 + Vulkan client for ACE (Win/Linux/macOS, beta). Faced
the same decision and chose **first-party, not Decal-compatible**: plugins target a small documented contract
(`AcDream.Plugin.Abstractions`: game state, items, chat, trade, vendor, hotkeys, window, headless), a launcher
plugin manager with declared capabilities, a **headless host** where the same plugins run windowless, and
**MossTank** (`openac-mosstank`), a VirindiTank reimplementation that "reads VirindiTank's own profile"
with the same behavior and vocabulary. Third-party example: `SolrLabs/openac-buffbot` (playstyle keywords
`heavy`/`bow`/`mage`/`void`, fair queue, self-maintaining, local web console).

## 5. Recommendation

**First-party systems, compatible with the community's *file formats*, not Decal's *binary interface*.**

- Binary Decal compat is impossible in a browser: plugins are Windows .NET Framework/COM DLLs using Win32,
  WinForms/VVS, and `acclient.exe` memory offsets. VTank, the one that matters most, is closed source.
- Re-implementing the Decal API surface in TS buys nothing: every plugin would still need porting.
- The familiarity players value lives in their **files**: `.utl` loot profiles (VTClassic is open source),
  `.met`/`.nav` (format documented by metaf), UB expressions. Import those; reuse VTank vocabulary.
- We own the client, so expose a clean typed game-state/event API over `@ac/network`, and route every
  automated action through the same action path the UI uses (identical packets, the server sees nothing new).
  An optional sandboxed TS plugin API can come later.
- **Headless runner**: `@ac/network` is TS, so a Node host for service bots is realistic.
- **Server-declared policy, tiered by activity** (Turbine's line): info tools → attended automation →
  service bots → attended combat → unattended. The client shows and enforces what the server allows;
  optional server-driven attendance check (the modern UCM test).
- Everything off by default; clearly a non-retail layer.

## 6. Suggested build order (not yet filed as tasks)

1. **Info QoL** (what everyone ran full time): XP/h and burn trackers, coordinate arrow + dungeon/landscape maps,
   buff and quest timers, item info on ID (loot-rule match), chat filters/logging, target debuff/weakness display.
2. **Attended single-trigger automation**: buff-set sequencer, one-touch heal, autopack, auto-vendor/salvage/trade
   driven by `.utl`-compatible loot rules, scroll learning, XP spending.
3. **Service bots**: `/tell` command framework + request queue + rate limits (buff/portal/trade/craft share it).
4. **Full routine engine**: combat loop, navroutes, metas (state machine), follow/fellowship control,
   `.met`/`.nav`/`.utl` import. Server-policy gated.
5. **Headless host + plugin API**.

## 7. UI mockup

Interactive canvas (private to Jake; share from the page): https://claude.ai/artifact/14sLSsPpBPDXevEJQPR8iS
Source copied to `docs/mockups/automation/` (`canvas.json` + three `.dc.html` artboards). They are Design-canvas
component files: `./support.js` and the `/_blob/…` background only resolve inside the canvas, so read them as
markup/spec or edit the canvas itself. The background is `verification/retail-client/ab/retail-holtburg.png`.

**Visual language** (sampled from `verification/retail-client/ab/retail-options-gameplay.png` and
`retail-vendor-selling.png`; the real implementation must use the DAT LayoutDesc/texture assets instead):
panel ~`#16140a`–`#1b1a0b` dark olive with gold edge `#e4cc83`/`#c9a04a`; navy buttons `#121ea3`→`#090f4f`
with gold border (maroon variant for Stop/Cancel, as on the vendor panel); tabs with an angled top-right
corner, selected `#3d382d`; small grey bevel buttons; retail serif face (mock uses Tinos as a stand-in).

**Board 1: in game (everyday surface).**
- HUD status strip under the vitals: dot + state ("Running · Hunt"), XP/h, session time, pause. Click opens the panel.
- Docked **Automation** panel in the retail side-panel slot: profile dropdown; status line; Pause / Stop / Edit…;
  7 module checkboxes with one-line summaries (Buffs, Vitals, Combat, Looting, Navigation, Inventory, Service);
  server-rule footer. **Stats** tab: XP/h, next level, kills, deaths, kept/salvaged/sold, burn/h, time per state.
- Chat reports in a dedicated color ("[Automation] Kept Diamond Scimitar (rule: Legendary weapons)").

**Board 2: editor window (power surface)**, large floating window, tabs:
- **Routine**: VTank metas made readable. States list (running one marked); per-state ordered rules as
  dropdown sentences: *When* [Free pack slots] [below] [5] *Do* [Go to state] [Vendor run]; `and`-joined
  conditions, `then`-chained actions; categorized searchable condition picker (Character, Vitals, Buffs,
  Inventory, Nearby, Location, Routine, Chat); live trace strip (current state, acting rule, last transition,
  History, Step one rule).
- **Buffs**: named sets (own + "For others" sets used by Service), ordered spell list with target and time
  left, rebuff threshold, idle top-up, highest-known level with floor, fizzle fallback, supply warnings.
- **Combat**: weapon/attack height/power, weakness weapon swap, debuffs, target range and pick order,
  per-monster priority list, heal/stamina/mana/retreat/logout thresholds, fellowship heal/follow.
- **Loot**: ordered Keep / Keep N / Salvage / Sell rules (first match wins), "must match all" requirement
  editor (+ "any of" groups), "Try it" drop slot showing which rule matches an item.
- **Service**: offer-services toggle + who may ask; `/tell` keyword → action table; limits (per-person
  cooldown, queue size, restock pause, trade policy, periodic advert); live queue; daily counts; server note.
- Header: profile picker, Import from VirindiTank…, Export, Save.

**Board 3: states.**
- HUD variants: Running, Paused, Waiting for you (yields when a player trades or you take control),
  Combat stopped (server rule), Serving (queue).
- Attendance check dialog (only if the server enables it; timeout pauses combat only).
- VirindiTank import dialog (`.met`→routine, `.nav`→route, `.utl`→loot; anything not runnable exactly is imported
  disabled and flagged, never guessed).
- Read-only server rules table.

Player names, stats and file names in the mock are sample data; the spell names are real EoL spells.

## 8. Sources

- AC Fandom wiki (via API): Plugins, Buff Bot, Portal Bot, Trading, Combat Macro, Envoys and the Code of Conduct,
  Microsoft Zone Archive/News & Events/Macros, 3rd-Party Apps and XP
- decaldev.com; sourceforge.net/projects/decaldev; massivelyop.com 2021-11-30 Decal update article
- virindi.net wiki (Virindi Tank, Meta System, VTClassic); github.com/JJEII/metaf; github.com/immortalbob/IBControl
- github.com/Mag-nus/Mag-Plugins (+ wiki); utilitybelt.gitlab.io; ac.lastalias.com/plugins.html
- github.com/patri0t86/ACManager; gitlab.com/trevis/dothingsbot; github.com/SolrLabs/openac-buffbot
- github.com/eriknihlen/OpenAC (README: plugins, MossTank, headless)
- ac-tool.com (AC Tool FAQ); skunkworks.sourceforge.net; escapistmagazine.com (2002 combat macro locations)
