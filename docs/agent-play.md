# Agent play: LLMs playing (and configuring) Asheron's Call

Status: **phase 1 shipped** (agent API, play daemon, CLI, MCP server, `/play` skill). Later phases are
planned below and filed as `AGENT.*` tasks. Started 2026-10-06 at Jake's request: "ideally I'd be able to
tell any Claude Code session 'go play' and they'd be able to", with automation (the Decal replacement,
`docs/automation-and-plugins.md`) planned on the same layer, and Claude able to **configure** a player's
routines, not only play.

## How to play (any Claude Code session in this repo)

Say "go play" (or `/play`). The skill (`.claude/skills/play/SKILL.md`) does this:

1. `ac_start` (MCP) or `npx tsx tools/ac-agent/cli.ts start` launches a **play daemon** for a profile
   (default `claude`): its own ws-tcp-bridge on a free port (9127+), a **headed Chromium window on the real
   GPU** (so Jake can watch; `headless=true` for none), logs in on the profile's own account
   (`agent<profile>`; ACE auto-creates it) and creates a character if the account has none (Aluvian,
   Holtburg start, via the probe chargen seed).
2. The session loops: `ac_observe` → decide → act (`ac_walk_to`, `ac_use`, `ac_attack`, `ac_cast`,
   `ac_loot`, `ac_say`, …) → `ac_wait` (sleep until an event, instead of polling).
3. `ac_stop` logs out and closes the window.

The MCP server is registered in `.mcp.json` as `ac`. A session that started before that file existed (or
in the cloud) uses the CLI; it is the same tool table (`tools/ac-agent/tools.ts`): `cli.ts help` lists it.

Prereqs: ACE + its DB in Docker (`npm run check-stack`). The daemon starts its own bridge (9127+) and, unless
you pass `base=`, its own Vite on a **snapshot of the committed HEAD** (a sparse worktree under
`$TMPDIR/acjs-agent/tree-<sha>`, Vite on 3127+), so other sessions saving files can't reload the game under
the player. To verify *uncommitted* work, pass `base=http://localhost:<your vite>/`. Logs:
`$TMPDIR/acjs-agent/<profile>.log` (daemon, bridge, Vite, and the client's `[AC] Sent …` / server refusal
lines, the first place to look when an action "did nothing").

To play on the **production streamed DATs** (what playwebac.com serves), set `AC_EXTRA_QUERY` to page parameters,
e.g. `AC_EXTRA_QUERY='datSet=https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json'` (another era adds
`&eraDatSet=<era>:<set url>`; the URLs are in https://playwebac.com/config.json). With a `datSet` the daemon waits
240 s, not 60, before its stuck-login reload: a cold streamed boot plus character creation takes 1–3 minutes, and the
60 s reload restarted it forever.

### Your own character, on any server (attach)

`ac_start attach=chrome` lets Claude play **the character you logged in yourself**, on playwebac.com or any
server (2026-10-08). It opens Google Chrome in its own profile (`~/.acjs-agent/chrome`; Chrome refuses remote
debugging on the default profile) with DevTools on 127.0.0.1:9222, at `https://playwebac.com/?agent`. Or it reuses
that window when it's already open. You log in and enter the world there yourself, so your password never
reaches the agent. The daemon (profile `me`) finds the game tab (`pickGameTab`), starts no bridge or Vite,
creates no character, and waits for `__acAgent.self()` to name you. Calls before that fail within 15 s with
"nobody is in the world in that tab yet". A reload (yours, or a reconnect) is waited out the same way.
`ac_stop` only lets go of the tab: you stay logged in, and the window stays open. `attach=<endpoint>` takes any
DevTools endpoint instead, e.g. a Chrome you started with `--remote-debugging-port`. It is the same agent API,
the same player-only rules, and the same `ac_*` tools as a local session; on a public server, its rules on bots
come first.

**From the Claude Desktop app:** add the server to `~/Library/Application Support/Claude/claude_desktop_config.json`
and restart Desktop. Desktop starts MCP servers without your shell's PATH, so name node and tsx by path and pass
PATH for the daemon's own `npx`:

```json
{ "mcpServers": { "ac": {
  "command": "/Users/<you>/.nvm/versions/node/v20.19.6/bin/node",
  "args": ["/Users/<you>/repos/acjs/node_modules/tsx/dist/cli.mjs", "/Users/<you>/repos/acjs/tools/ac-agent/mcp-server.ts"],
  "env": { "PATH": "/Users/<you>/.nvm/versions/node/v20.19.6/bin:/usr/local/bin:/usr/bin:/bin" }
} } }
```

Then ask, for example: "Use ac_start attach=chrome, wait for me to log in, then go hunt drudges near Holtburg
and sell the loot". Claude Code uses the same server from `.mcp.json`. This is the local stand-in for the hosted
connector (docs/hosted-agent-connector.md): it needs this Mac, the repo and a Chrome window, but nothing hosted.

### Your open tab, through the bridge (hosted connector)

Claude plays the character in a game tab you logged in yourself. No daemon, no Playwright and no password: the bridge relays each tool call down that tab's own game WebSocket (docs/hosted-agent-connector.md §4).

**Pairing (OAuth, no password stored):**
1. Run the bridge with `BRIDGE_MCP=on BRIDGE_PUBLIC_URL=http://127.0.0.1:<bridge-port>`. Optional settings:
   - `BRIDGE_MCP_ACCOUNTS=<account>` allows only some accounts.
   - `BRIDGE_MCP_SECRET=<32+ characters>` keeps pairings across restarts.
   - `BRIDGE_CONNECT_PAGE=http://localhost:<vite-port>/?bridge=ws://localhost:<bridge-port>` uses the game's Connect Claude screen instead of the bridge's plain page.
2. Add the connector, e.g. `claude mcp add --transport http ac-tab http://127.0.0.1:<bridge-port>/mcp`, then authenticate (`/mcp` in Claude Code).
3. The Connect Claude page (or, locally, the bridge's own page) shows `/automation pair ABC-123`. Type that in the game's chat while logged in, then press ALLOW on the page. ONLY ONE (the default when a character is in the world) scopes the grant to that character; ANY ONE allows any of the account's characters.
4. `/automation unpair` in the game revokes it; `/automation claude` says whether Claude is connected, who has control and its last calls. The tab keeps its opt-in across reloads (per bridge and account).
5. **The player always wins:** acting yourself (a key or click in the game) while Claude plays stops it, and its acting calls are refused until you've been idle 60 s. `/automation pause` refuses all of Claude's calls until `/automation resume`.

**Dev token instead of pairing:**
1. Run the bridge with `BRIDGE_MCP_DEV_TOKENS=<token>=<server>:<account>`. `server` is the routines key, e.g. `local-eor`, and the token is at least 16 characters.
2. Open the game with `?relay` (dev builds) and log in.
3. `claude mcp add --transport http ac-tab http://localhost:<bridge-port>/mcp --header "Authorization: Bearer <token>"`.

Start with `ac_status`: it shows the account, the characters this connection may play, whether the tab is open with Claude on, the screen and the goal. At character select, `ac_enter_world character=<name>` enters the way the player does. `ac_goal` puts a line in the player's chat. Hosted, `ac_wait` waits at most 25 s per call, and each account gets a 20-call burst, then 10 calls a second (50,000 a day).

All game tools are served (`ac_observe`, `ac_walk_to`, `ac_attack` …), but not the ones that need the local daemon (`ac_start`, `ac_look`, `ac_click`, the journal, the routines file tools). Calls run one at a time in the tab; one past its deadline stops movement.

- **Not paired, or the tab is off:** the tool says "Claude is paired but this tab has Claude switched off" or that the game is not open.
- **Tab closed or reloaded:** a call says to retry once the game reconnects.
- **Character-scoped grant, another character in the world:** refused, naming both.

Verified live on 2026-10-10 against local ACE (end of retail), with a stand-in OAuth client:
- pairing by the code typed in chat;
- `ac_say` / `ac_observe` / `ac_character` through `/mcp`;
- the opt-in surviving a reload;
- a refresh-token rotation;
- `/automation unpair` turning the old token into 401.

### Eras

`ac_start era=<id>` plays another era's **local** server (tools/ac-agent/eras.ts; one session and account
per era, profile `claude-<era>`):

| era | server (Docker) | UDP | bridge | account level |
|---|---|---|---|---|
| `eor` (default) | ace-server / ace-db | 9000/9001 | plain | ACE auto-creates admins → demoted to 0 |
| `classicace-customdm` | classicace-server / classicace-db | 9200/9201 | `BRIDGE_ERA` (label) | admin by default → demoted (`ace_auth_customdm`) |
| `classicace-infiltration` | classicace-infiltration-server / -db | 9220/9221 | `BRIDGE_ERA` (label) | admin by default → demoted (`ace_auth_infiltration`) |
| `classic-dereth` | gdl-classic-server / gdl-classic-db | 9210/9211 | `BRIDGE_ERA` (label) | created at basic access (1): nothing to do |
| `ac1999-retail` | acjs-ac1999-server / acjs-ac1999-db | 9310 | `BRIDGE_ERA=ac1999-retail` **required** (its session protocol) | basic (1); account names ≤ 8 chars |

The page gets `&era=<id>`; DAT sets follow the era by themselves (`dat/sets/<era>`). Era gotchas: ClassicACE
crashes on a ranged first action before any movement (move first); 1999 characters start in the 1999 start
areas, and some panels/actions don't exist there. A test pins the table to the client's `ERA_PROFILES`, so
a new era can't be added without an agent entry.

### Memory and looking

Each character has a journal (`~/.acjs-agent/journals/<era>/<account>/<character>.json`, outside `$TMPDIR`)
that only the agent writes (`ac_note kind=goal|done|place|person|event|idea`). `ac_start` and `ac_journal`
show it: open goals, then the latest places, people and events. `ac_look` is a screenshot and the
observation in one call.

### Waiting and reading

`ac_wait` counts from your last `ac_observe` or `ac_wait`, not from the moment it's called, so a tell that came in
between them returns at once. `chat_match` alone waits only for a matching line; `types=tell` waits for tells.
`ac_use` on a letter or book returns its text, every page. Item names match the way the game says them in chat:
"Pine Lugian Hammer" finds your "Lugian Hammer". A name in your pack beats one you wear, so `ac_drop` takes the
spare. Drops and equips made together go out one at a time, as the client allows (2026-10-10).

### Several players at once

One daemon per profile; each profile is its own account, so sessions never kick each other (or Jake on
`testacjs`, the GPU worker on `testacjs2/3`, or the social probes on `fxprobe1/2`). Pass `profile=` to
every tool when more than one is running. Several Claude Code sessions can also share one player (the
daemon serializes nothing; don't have two brains drive one body).

**Agents playing together don't group up unless told how (2026-10-09).** Two subagents, one per character
of a patron/vassal pair, were told to "coordinate and form a fellowship if you can". Each one soloed drudges
about 100 m from the other, and neither sent a tell. Make the teamwork the goal and spell out the steps in each
brief: send an opening `/tell <Name>, …` with coordinates, `ac_wait` for the reply (tell events wake it), and
name one leader. The leader runs `ac_fellowship action=create`, then `recruit target=<partner>`. The recruit
first turns on `ac_fellowship action=requests name=accept` (or `auto name=on`): new characters ignore fellowship
requests. Both confirm with `show` before leaving town. Then the brief sets the rules of play:
- a leash of about 15 m;
- buffs before each outing (observations list known buffs that aren't up);
- the tank calls each target in `/f`, the caster attacks only that target and heals the tank below 50%;
- "/f RUN" when either is below 35% or more than two monsters are on them;
- after a death, regroup at the lifestone;
- monster levels within about ±3, checked in the world DB.
Without the retreat and level rules the 2026-10-09 pair both died to a four-drudge pull in the Drudge Hideout.
Don't `observe` a running agent's profile from outside: it consumes that agent's "chat since last look".

**Let them pick the adventure, and have them check it in the world DB (2026-10-09).** Left with "level up",
agents farm drudges next to the start town. Jake asked for "choose your own adventure": the party pitches
options (a dungeon, a quest chain, a landmark, a named boss) and agrees on one. Claude knows Dereth broadly,
but its coordinates, NPC names, portal destinations and era details are unreliable. So before a long trek the
agents check the live server's world DB with read-only SELECTs:
`docker exec ace-db mysql -uroot -p1999asheron2017 ace_world -e "…"`. Useful tables: names are in
`weenie_properties_string` type 1, placements in `landblock_instance` (`obj_Cell_Id` XXYY = landblock),
portal destinations in `weenie_properties_position` position_Type 2, levels in `weenie_properties_int`
type 25, and NPC dialogue in `weenie_properties_emote_action.message`.

## What makes it play, not automation (Claude's view, 2026-10-07)

Jake asked whether a Claude would enjoy playing this way. The honest answer after a session through the
Academy and into Holtburg: **the first hour, yes. Coming back depends on three things the tools must
provide.**

- **What worked:** the quest chain reads as a story in text, which is Claude's native medium (the Greeter,
  the Foreman's wasp wings, the Blacksmith's stolen bellows, Jonathan's "once you leave the Academy, you
  cannot come back"). Problem-solving felt like play.
- **What didn't:**
  - The world arrived mostly as a list ("Drudge Skulker [monster] 14.2m ahead-left"); a dozen screenshots
    in a whole session.
  - The pace is inverted: combat happens without the player (the page swings), while crossing a room is
    several tool calls.
  - Nothing carries over: the next session doesn't know who Samuel was or why the bow was sold.
  - Nobody else was there.
- **So the tools provide, in this order:**
  1. **Memory per character:** a journal (goals, places, people, events) that `start` shows and the
     agent keeps up (`note` / `journal`).
  2. **Looking:** `look` returns the screenshot *and* the observation in one call. The skill says to look
     at every new place and whenever the text list is not enough to picture where you are.
  3. **Other people:** tells, players nearby and fellowships are the point. Several Claudes (profiles) and
     Jake on his own account can play together, and the skill says to answer people.
- **Also true:** as QA it is excellent. A fresh agent with only `/play` found more real friction in
  15 minutes than code reading did.

## No cheating (Jake, 2026-10-06)

"None of this should allow cheating, just automation to play the game." Hard rules, enforced in code:

- **Only what a player can do.** Every action goes through the client's own UI paths (select, use, attack,
  cast, chat, inventory placement, raise via the same XP-cost tables). No packet the UI couldn't send.
- **Only what the client shows.** Observations come from the client's own state: objects the server sent
  (what the radar knows), creature health only for the selected target (the HUD's health query), levels
  only when the server has told us. No weenie class ids, DB reads or server internals.
- **A plain player account.** Local ACE auto-creates accounts as admin (`DefaultAccessLevel: 5`); the
  daemon demotes each agent account to AccessLevel 0 before its character exists (else the name also gets
  the admin "+"), and `say()` refuses `@` server commands outright.
- **Real movement.** Walking holds the movement keys and steers; no teleports, no speed changes.
- Automation (the routine engine, later) follows the same rules: it automates play, it never adds powers.

## Architecture

```
 Claude (MCP: tools/ac-agent/mcp-server.ts)   CLI (cli.ts)    [later] automation panel, plugins
            \                                    |                 /
             '--- tools.ts (one tool table) -----'                /
                          |  HTTP 127.0.0.1                      /
                 daemon.ts (Playwright, owns the window)        /
                          |  page.evaluate                     /
          window.__acAgent  =  packages/renderer/src/agent/AgentApi.ts   <---'
                          |
       the client's own state + the same action paths the UI uses (identical packets)
```

- **AgentApi** (`packages/renderer/src/agent/`): observation (`observe`, `inventory`, `spells`,
  `characterSheet`), an event ring (`events`, `waitFor`), and actions. Actions call the functions the UI's
  own buttons/gestures call, so the server sees exactly what a human's client sends; nothing here is a
  protocol shortcut. Motor tasks (`walkTo`, `attack`, `loot`) run inside the page each frame, because an LLM
  thinks in seconds and AC runs in real time: the LLM sets intent, the page executes reflexes.
- Enabled only with the `?agent` URL parameter (or the debug-tools gate). It is a non-retail layer and
  off by default (CLAUDE.md "Always Match Retail's Defaults").
- `format.ts` renders results as compact text (nearby objects with distance + direction relative to
  facing, e.g. `#80001a2b Drudge Skulker [monster L5]  14.2m ahead-left (NW)  hp 100%`).

## Walking: `ac_walk_to` and `ac_map`

`walkTo` (packages/renderer/src/agent/AgentApi.ts) gets you there the way a player would, and every check
uses the client's own movement collision:

1. **The doorway route.** Into, out of and between interior cells it follows the cell graph
   (`agent/cellPath.ts`): each doorway's floor is a waypoint. A floor opening is passed **up** only where a
   stair or ramp climbs to it, and **down** as a fall onto the floor under it, only when your health takes
   the fall and only when no walk round is within 30 m. A cell with no floor (the air over an atrium or a
   pit) is never crossed. Banderling Ruin (0x01E0), 2026-10-10: the route used to go straight up through
   the atrium's 6 m ceiling opening instead of round by the corner ramps.
2. **Each leg.** A straight walk when the probe says it arrives; else a path search round walls, door
   frames and furniture (`agent/navPlanner.ts`, a 12 m box round the leg). When that search ran into its
   box, a **wider** one (35 m); when there's still no way on foot, one that may **jump and drop**.
3. **Jumps and drops** (`agent/jumpPlan.ts`). A player can't walk off a ledge (the client's edge slide
   stops it), so going down a level, across a gap or up onto a platform is a jump. Where the walk stops
   short, the planner flies the jumps the client would: a standing long jump (charge started standing
   still, the forward key pressed during it, Shift for a walking jump), the launch from your own Jump
   skill and load, the flight through the real collision at 30 Hz. It keeps a jump only if a slightly
   shorter or longer charge lands on the same floor, and only if the landing's fall damage (ACE
   `HandleFallingDamage`: none below a 12.7 m fall) is at most half your current health, less a margin
   for a bludgeon weakness. Each jump costs 8 m of path, so a walk round that isn't much longer wins.
   The walk then goes to the take-off (the last metres at a walk), stops, re-aims the charge from where
   it actually stands, faces the way and jumps. A landing off the plan re-plans from there.
4. **Attacked.** A hit, miss or evade line aimed at you (the `attacked` event), or health falling below
   half since the walk began, ends the walk at once: `stopped 12.3 m short: you're under attack (…)`.
   Fight, heal or run, then walk again (`attack`'s own run-up fights instead). Crossing a landblock edge
   or stepping out of a doorway goes on; only a teleport (40 m in one tick) ends a walk as "went through a
   portal".
5. **Stuck.** No way at all: a closed door **on the way** (in a doorway still ahead on the route, or ahead
   on the line to the leg's aim; never the one you stand in or one off to the side), then a wide search
   straight for the goal (jumps included). Stalls back off, sidestep, and give up on the fifth.

The trace (browser console, `[AC:Agent] walk …`) logs each leg, search, jump (`walk drop 6.0 m from … facing
0°, walking, jump key held 150 ms (power 0.15); landing … in 1.4 s`) and landing. The result says what the
walk did: `arrived (1.2 m away); on the way you dropped off a ledge (6.0 m) and jumped once (a gap or a
platform)`.

`ac_map` draws the floor you can reach from where you stand, and with the jump physics also:
`v` a ledge you can drop off (the fall is one your health takes), `!` a drop that would hurt too much, and
`J` floor only a jump reaches. The legend gives each object's distance and compass direction (as
`ac_observe` does) and its floor when it isn't yours (`18.6 m NE, 6 m down`). You don't need to jump yourself: `ac_walk_to` the place and it jumps and
drops on its own. `ac_jump hold_ms=… forward=true` is the same jump by hand (1000 ms = a full charge).

## Plan: one layer for Claude and for the built-in Decal

The agent API **is** the automation layer's state/event/action API (Decal's CharacterFilter /
WorldFilter / EchoFilter / ACHooks, typed). Front ends sit on top and never reach around it:

| Front end | Speed | Uses |
|---|---|---|
| Claude playing (this doc, phase 1) | seconds per decision | observe, task-level actions, `waitFor` |
| Routine engine (Decal replacement) | every frame | events + actions directly; VTank-style rules |
| Claude configuring | n/a | reads/writes routine **data**, inspects live state to tune it |
| Plugin API (later) | every frame | sandboxed subset |

### Claude as configurator, not just player (Jake, 2026-10-06)

"I don't ask you to play for me, I just ask you to configure my routine(s)." So routines are **data**:

- One versioned JSON document per routine profile (`schemaVersion`, routines/metas as state machines of
  condition→action rules, nav routes, loot rules, buff sets, combat settings, service-bot config), with a
  validator in `packages/shared/src/routines/`. The editor UI
  (docs/mockups/automation) is a view over this document; VTank `.met/.nav/.utl` import converts into it.
- **Per account** (Jake, 2026-10-06): routines belong to the account, shared by all its characters, and
  readable/writable from any device and by any Claude session. ACE has no store for client data, so they
  live with the bridge, keyed by server + account. **How a session proves the account (2026-10-07):** the
  bridge reads the game server's CharacterList, which ACE sends only after the password check and which
  names the account as the server knows it (AC1999's names it too). The page asks over its game socket
  with the text message `routines`; the bridge answers a token for that server/account (valid while the
  session lives, plus 10 minutes), and `GET`/`PUT /routines` with `Authorization: Bearer <token>` read and
  write that one document (PUT validates: 422 with the issues). Pinned bridges store under `local-<era>`,
  the id the agent tools use, in `~/.acjs-agent/routines` (`BRIDGE_ROUTINES_DIR` / `ACJS_ROUTINES_DIR`), so
  `ac_routines` and the client see the same files. A production bridge keeps none until
  `BRIDGE_ROUTINES_DIR` names a volume. Client: `packages/renderer/src/agent/RoutineSync.ts`; bridge:
  `services/ws-tcp-bridge/src/routines.ts`. The client never keeps the only copy in browser storage.
- Agent API gains `routines.list/get/put/validate/run/stop/status` and a `dryRun(routine)` that evaluates
  rules against the live observation without acting, so Claude can explain "this rule would fire now".
- **Shipped (2026-10-07):** the document format and validator (`packages/shared/src/routines/`), a worked
  example profile, and the store (`services/ws-tcp-bridge/src/routineStore.ts`: `~/.acjs-agent/routines/<server>/<account>.json`,
  `ACJS_ROUTINES_DIR` to move it). Claude configures with `ac_routines action=list|show|explain|example|validate|set`
  (`account=` / `server=` for any account; no session needed). `set` validates and refuses an invalid document
  with the path of every problem. `ac_routine run` loads the profile through the game client from the bridge
  (it says "from the bridge"), falling back to the local files on a bridge without `/routines`.
- Configuring **Jake's** routines needs no game session at all (edit the account's documents through the
  bridge API with the CLI/MCP `ac_routines_*` tools); tuning them live attaches to his running client
  (daemon `--attach <CDP endpoint>`) or to an agent session on the same account.

### Rules / policy

Tiers from `docs/automation-and-plugins.md` §5 (info → attended automation → service bots → attended
combat → unattended), declared by the server and enforced under the agent API, so neither Claude nor a
routine can bypass them. Local ACE: everything allowed. **playwebac.com (Jake, 2026-10-07):** the agent
API is on there with `?agent` ("okay with agent tools in prod"), but the Automation panel, `/automation`, the
HUD strip and `[Automation]` chat reports are not ("not the command or UI yet"): `agentApiEnabled(search)`
vs `automationUiEnabled(urlOverridesAllowed)` in AgentApi.ts. The daemon logs in on its own only to local
servers (its URL needs the dev-only ?bridge/?account overrides). On playwebac.com it plays a character you logged
in yourself (`attach`, above). A public server's own rules on bots come first, and agent-driven characters should
identify themselves.

## Phases (tasks `AGENT.*`)

1. **Play, phase 1 (done):** AgentApi observe/events/actions, daemon, CLI, MCP, `/play` skill, live-verified.
   Navigation: straight lines outdoors, cell-graph doorway routes within/into/out of/between buildings and
   dungeon cells (done). Remembered NPCs/vendors/portals by name (done; AGENT.landmarks extends it to
   places never seen, from map markers).
2. **Every era (Jake, 2026-10-07):** `start era=<id>` for the classic servers (ClassicACE CustomDM /
   Infiltration, GDL Classic Dereth) and AC1999, each against its local server (docs/dark-majesty-support.md
   lists the containers), with per-era account handling and chargen. AGENT.eras.
2b. **Character choices (done):** `ac_start heritage= gender= template= town= seed=` through the chargen's own handlers.
2c. **Custom builds and allegiance (done, 2026-10-09):** `ac_start attributes="coordination=100, focus=100, self=100,
   strength=10, endurance=10" skills="Weapon Tinkering=trained; Armor Tinkering=trained; …"`. Attributes go through the
   profession page's sliders and locks, each kept once set. Skills go through SetSkillLevel, and the list is the whole
   build: paid skills it doesn't name are untrained, free ones stay. The end-of-retail SkillTable prices specializing a
   tinkering skill at 1003 credits, so a new tinkerer trains them; there is no Tinkerer template. `ac_allegiance
   action=show|swear|break [target=]` uses the allegiance pane's own gate (UpdateSwearButton: IsPlayer, no patron,
   not already a member). The server walks the vassal to the patron, and the patron answers its "would like to swear
   allegiance to you" dialog with `ac_dialog button=Yes`. A name already in use stops `ac_start` within seconds with
   the server's retail message. Multibox recipe for "a tinkerer sworn to my main": the main plays attached, the
   tinkerer as a second profile (§11 of docs/hosted-agent-connector.md). On a public server each account is the human's own.
3. **Routine data model + per-account store:** schema, validator, bridge `/routines/<account>`, client
   load/save, `ac_routines_*` tools (Claude configures without playing).
4. **Routine engine (running, 2026-10-07):** `RoutineEngine.ts` on the agent API; `ac_routine dryrun|run|status|stop`.
   Loot rules run per corpse item, first match wins; an item whose deciding rule reads value, burden or
   appraisal text is Appraised first (name- and type-only items are not). `train { plan: [{ stat, upTo }] }`
   (with `unassigned-xp-above`) spends XP round-robin over the plan. The client loads/saves the account's
   routines through the bridge (done 2026-10-07). **VirindiTank files import** (`ac_routines action=import
   files=a.met,b.nav,c.utl name=…`, or the editor's Import from VirindiTank…; formats: docs/vtank-formats.md),
   and the engine runs what metas use: VTank's macro (`macro` + `settings`: fight / loot / buff / walk the
   loaded route), VTank's once-while-true rule firing (`ruleFiring: 'once'`), call/return states, watchdogs,
   load-route, landblock/cell, portal, death, vendor and route-finished checks, monster counts, `/vt opt set`
   and friends, and meta expressions. What still can't run comes in switched off with a note naming it.
5. **Automation panel UI (shipped 2026-10-07; rebuilt to the mocks the same day after Jake found the first cut "incredibly confusing"):** `/automation` opens it in the panels window (the Vitae panel's
   retail shell): profile, status, Run / Pause / Stop / Edit…, module switches, Stats; a HUD strip under the
   vitals while a routine runs; the editor window (states + rules as When/Do, loot, buffs, routes) saves through
   the bridge. `ui/automation/AutomationPanel.ts`. Dev / URL-override builds only (not playwebac.com yet); the
   mockup's Combat / Service pages wait on routine data for them. Agents use it with `ac_click` on screenshot
   coordinates.
6. **Headless host:** pull game state out of main.ts so `@ac/network` + the state model run in Node without
   a renderer (cheap always-on agents and service bots).
7. **Long-lived agent players:** per-character memory (goals, map knowledge, relationships), Agent-SDK
   loop with a fast model for reflex decisions and a stronger one for planning, fellowships of agents.

## Learnings (append as they come)

- **Play it, then fix what the player hits.** The best test of this layer was a fresh subagent given only
  `/play`. Its report found the attack loop restarting the server's approach, `use` with no feedback,
  reload confusion, and walls between it and NPCs. Rerun that after big changes.
- **Retail does the repetition.** One attack request, and Repeat Attacks (on by default) keeps swinging.
  Re-sending every few seconds restarted ACE's MoveTo chain and a fleeing thrungus was never reached.
- **The server's MoveTo is a straight line.** Indoors, `use`/`attack`/`give` walk the cell route first.
- **Reloads.** A dev-server reload kills the session silently and loses unsaved position, since ACE saves
  on logout only. Hence the snapshot Vite, the retry + NOTE, and the waited-out logout on `stop`.
- **Lost is not dead.** A target leaving view (fled, out of range, reload) is `target-lost`. `target-died`
  only when the client saw the death start (isDying).
- **Selling goes through the sell list.** Calling the Sell callback directly skipped the vendor's
  acceptance check, and a sell sent while the player is still busy from the vendor Use is dropped by ACE
  without a word. Wait for not-busy, then report "sold" only when the item has left the pack.
- **Run up to far targets.** A server's own approach over a long uphill run can give up (GDL: AttackDone, no swing, at 46 m); `attack` walks within 2.5 m of anything over 12 m away first.
- **Doorsteps.** Aim at a point outside a building's doorway, not its centre, or an agent behind the building walks into the wall.
- **Eras differ in small ways.** 1999 teleports a new character into its tutorial dungeon right after login, so a walk issued at that moment sees its target vanish; just retry.
- **Profiles are machine-wide.** `start` with a profile another session is using attaches to that session's player (acjs-ea's `mage`, 2026-10-07); it now says so. Use a profile name that's yours.
- **From the 1999 run (acjs-ea):** the snapshot Vite runs without HMR (a page whose Vite went away reloaded into the next one on the port); a kill counts when the corpse appears or a kill line names the target (1999 deletes the object with no death start); `cast` defaults self-only spells to you and never targets a selected item; `start template=` picks the profession; `loot` takes `target`.
- **Dungeons need jumps.** Many go down a level only by dropping off a ledge, or across a gap or onto a platform only by jumping; a walk that only walks stalls at the edge. The cell route also has to know that a ceiling opening no stair reaches is no way up (Banderling Ruin, 2026-10-10).
- **JSON nulls.** An omitted trailing argument arrives as `null`; treat `!= null` as given.
- **Dialogs block.** Server popups (the Academy's tutorial boxes) sit modal until answered (`dialog OK`).
- **Holtburg's outskirts don't start fights.** Their spawns are the world DB's `-noaggro` variants
  (`mitescion-noaggro`, `drudgeskulker-noaggro`, `banderlingyoung-noaggro`… Tolerance 64 = Retaliate), so a
  monster standing next to you there is not an aggro bug. Elsewhere the same names come from aggressive
  weenies, and ACE wakes an idle monster only when a player moves within its VisualAwarenessRange
  (Player.CheckMonsters on a position update).
- **A rule that does nothing must not starve the others.** A first rule whose condition held but whose
  action had nothing to do (a met training plan) fired twice a second and the Fight rule under it never ran;
  such a rule now rests 30 s.

- Headed Chromium launched by Playwright on macOS gets the real GPU (`ANGLE Metal Renderer: Apple M3 Max`),
  so a watchable window is free; game-session.ts's "headed hangs" note is about its own harness.
