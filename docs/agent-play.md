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
the player. A new daemon prunes old snapshots: it keeps the 3 newest plus any a live daemon serves (before 2026-10-12 none were ever removed: 57 trees, 2.9 GB). The snapshot links `node_modules` and `dat/` from the checkout you start from, or from the main checkout when that is a fresh `git worktree` without them (before 2026-10-11 such a snapshot had no `node_modules` and Vite failed with "Cannot find package 'vite'"; the daemon now repairs those trees). To verify *uncommitted* work, pass `base=http://localhost:<your vite>/`. Logs:
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
   - **Several accounts (multiboxing):** type the same code in each account's tab (each logged in on its own account) before pressing ALLOW. Claude then picks a tab with `account=` on every tool, and `ac_status` lists them.
4. `/automation unpair` in the game revokes it (in one tab: that account only); `/automation claude` says whether Claude is connected, who has control and its last calls. The tab keeps its opt-in across reloads (per bridge and account).
5. **The player always wins:** acting yourself (a key or click in the game) while Claude plays stops it, and its acting calls are refused until you've been idle 60 s. `/automation pause` refuses all of Claude's calls until `/automation resume`.

**Dev token instead of pairing:**
1. Run the bridge with `BRIDGE_MCP_DEV_TOKENS=<token>=<server>:<account>`. `server` is the routines key, e.g. `local-eor`, and the token is at least 16 characters.
2. Open the game with `?relay` (dev builds) and log in.
3. `claude mcp add --transport http ac-tab http://localhost:<bridge-port>/mcp --header "Authorization: Bearer <token>"`.

Start with `ac_status`: it shows the account, the characters this connection may play, whether the tab is open with Claude on, the screen and the goal. At character select, `ac_enter_world character=<name>` enters the way the player does. `ac_goal` puts a line in the player's chat. Hosted, `ac_wait` waits at most 25 s per call, and each account gets a 20-call burst, then 10 calls a second (50,000 a day).

The connector serves the CLI's tools. Only `ac_start` / `ac_stop` / `ac_sessions` (the player logs in; `ac_status` / `ac_enter_world` stand in) and `ac_click` stay local (`ac_click` also drags: `to_x` / `to_y` release point, e.g. `modifiers=ctrl` to move the VVS bar; and `text=` types into the box the click focused with the real keyboard, `\n` for Enter: `ac_press` sends synthetic key events to the page and can't fill a text box). How the others work through the tab:
- `ac_look` / `ac_screenshot`: the tab's own 3D view. Panels and chat aren't in it.
- `ac_journal` / `ac_note`: kept in the player's browser, per character.
- `ac_routines` / `ac_routine`: the game's own routine store. Pass `doc=` / `files_json=` text in place of file paths.

Claude also gets the full play guide as the connector's instructions (`tools/ac-agent/hostedGuide.ts`; keep it in step with the /play skill).

**Call timing:**
- Acting calls run one at a time; reads answer at once.
- Every call answers within about 22 s, under Claude's tool timeout. A longer walk or use keeps going in the game and answers "still in progress"; `ac_wait types=task-done` follows it.
- Big answers (screenshots) cross the bridge in slices under its 64 KB WebSocket cap.

**Covered or hidden windows:** Chrome stops a hidden, minimized or covered window's frames and throttles its timers. That froze Claude's walks whenever Claude Desktop was in front. The CLI's Playwright browser runs with that throttling switched off. Two fixes:
- A worker's beat keeps the frame step running without drawing (`scene/BackgroundTicker.ts`).
- With Claude on, the page's timers ride a worker's clock (`scene/workerTimers.ts`).

Measured in a real Chrome with the game tab hidden: a walk that never moved in 22 s now arrives in 10 s.



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
between them returns at once. `chat_match` alone waits only for a matching line (never your own "You say" / "You
tell" lines); `types=tell` waits for tells sent to you (not your own). Together they are OR: `types=…,tell
chat_match="] Name says"` wakes on any tell to you and on Name's /f and channel lines. (Until 2026-10-13 they were AND,
so that wait, the stream brief's own, slept through every /f line: "missed chat wakeups" in the second rehearsal.)
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
- a leash of about 15 m. The observation's `fellows:` line gives each fellow's health, distance and direction, or
  "out of sight". On 2026-10-10 Bulwark sat in 5-minute waits for buffs while Arcanist was 490 m away: brief
  players to keep waits short and to walk to a partner who is out of sight;
- buffs before each outing (observations list known buffs that aren't up);
- **buffing is one of the caster's important jobs (Jake, 2026-10-10: "buffs become pretty crucial, so the caster should be
  aiming to get as many as possible").** Without being told, agents skipped buffs and never learned more. The brief
  has the caster train Creature Enchantment and Life Magic with credits, buy and `use` every buff scroll a magic
  vendor sells at their level (attribute buffs, the tank's weapon and defense masteries, armor, regeneration and
  protections), and rebuff the whole fellowship before each outing, whenever a buff drops and after a death. The
  tank gets buffed whenever the caster can cast them, and if buffing stalls (the caster out of mana, fizzling or far
  away) pulls anyway with kits and potions and says so in /f (2026-10-14: "never pull unbuffed" held Bulwark at the
  Foundry entry for 4 minutes in the second stream rehearsal). It is not the caster's main job (Jake: "not MAIN job, just an important job! it
  should still help fight, heal, etc"): the caster still fights the called target and heals;
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

**Adventure first, but levelling is the game's goal (Jake, 2026-10-12).** Over about four hours of two sittings the
Opus pair went from level 12 to 14 with roughly 37 killing blows between them: most of the time went to lore
detours, a destination across a river they couldn't reach, shopping and buffing stops, and corpse runs, and after
two deaths to level-20–30 monsters they hunted level-8 drudges. Jake: "i do still want the emphasis to be on
open-ended adventure that makes them actually enjoy themselves, but leveling is ultimately the goal of the game".
The brief keeps the open-ended adventure and adds: pick adventures that also pay XP (XP quests, dungeons and
hunting grounds near their level), hunt when between ideas, keep detours quick, check `ac_character` (total XP and
XP to next level) at the start, and report XP before and after with roughly how much of the session was fighting.

## Streaming (2026-10-13)

`tools/stream/supervisor.ts` keeps Claude Arcanist (profile `mage`) and Claude Bulwark (`soldier`) playing for a
stream with no human or lead session launching each run (Jake, 2026-10-13).

```bash
npx tsx tools/stream/supervisor.ts                 # run (tools/stream/cast.json; --config <file> for another)
npx tsx tools/stream/supervisor.ts stop            # or touch $TMPDIR/acjs-agent/stream/STOP, or Ctrl-C it
npx tsx tools/stream/supervisor.ts status          # today's segments, minutes and cost per character
```

**What it does.** For each character in the cast it starts the play daemon if none is running (`cli.ts start
profile=… character=…`), then plays it as a headless Claude Code session in **segments**:
- `claude -p --input-format stream-json --output-format stream-json --verbose --model <model>`, the shared brief
  (`tools/stream/brief.md`, with `{{CHARACTER}}`, `{{PROFILE}}` and `{{PARTNER}}` filled in) plus the character's
  personality as `--append-system-prompt`, and an opening message with the journal (`formatJournal`), the partner,
  the segment's length, the report the character wrote at the end of its last segment, and a **readiness** block
  (see "Good players first" below).
- The session runs in its own small directory, `stream/player/<profile>/` (`tools/stream/player.ts`), not the repo, so
  none of the repo's coding context loads (see **Cost** below). It holds two wrappers, the only commands a player runs:
  `./ac <tool> …` (the agent CLI by absolute path through the repo's own `node_modules/.bin/tsx`, no npx; it refuses
  `start` / `stop` and appends `profile=<profile>`, which wins, so a call can't drive the partner) and
  `./world-query "SELECT …"`. `AC_AGENT_PROFILE=<profile>` is set too.
- After `segment.minutes` (75) the supervisor sends "[supervisor] Wrap up now", a numbered list: finish the fight
  (start no new one) and get somewhere safe (nothing on you, not mid-dungeon pack), check with `observe`, `note
  kind=goal` and `goal` for next time, a goodbye in /f, and only then the report, which ends the segment. (Rehearsal
  2026-10-13: characters left mid-fight woke up dead or under attack in the next session.) A player still going `wrapUpMinutes` + 1 min later is
  ended (SIGTERM). A player whose turn ends early (it wrote a report at minute 20, or gave up) is told to keep playing,
  `maxNudges` times, and then the segment ends.
- The next segment starts after `restartPauseSeconds`. A segment shorter than `quickExitMinutes` (a crash) backs off
  (30 s, doubling, up to `maxBackoffSeconds`), and `maxQuickExits` in a row halt that character.
- Characters stay in the world between segments. The players never run `start` or `stop` (their permissions refuse
  both). A daemon that dies mid-segment (a crash, the 15-minute idle logout) is started again and the player told.
- **Stopping** (the stop file, `stop`, SIGINT/SIGTERM) tells each player "the stream is ending" and gives it
  `stopGraceSeconds` to say goodbye and write a report. Then the session ends and every character is logged out:
  `cli.ts stop profile=…` for each. Jake: "you should always log out if you stop controlling them". A character
  halted by a cap is logged out the same way.

**Limits** (cast.json): `maxSegments` per run per character; `daily.maxSegments` / `maxMinutes` / `maxUsd` per local
day per character. These are counted from the segment log, so they survive a supervisor restart. `segment.budgetUsd`
becomes `claude --max-budget-usd` for each segment. Each segment's tokens, cost (when `claude -p` reports
`total_cost_usd`), turns, session id and end reason go to `stream/segments.jsonl`.

**Permissions** (no `--dangerously-skip-permissions`):
- `--tools Bash,Read` and `--permission-mode dontAsk --permission-prompts none`: anything not allowed is refused,
  never prompted.
- `--allowedTools` (matching the wrappers in the player's directory exactly):
  - `Bash(./ac:*)`
  - `Bash(./world-query:*)`: a read-only world-DB query (`tools/stream/world-query.ts`). It takes one SELECT / SHOW /
    DESCRIBE, runs it inside a READ ONLY transaction and clips the output. It replaces the brief's old
    `docker exec ace-db mysql`, which could write.
  - `Bash(date)`
  - `Read`
- `--disallowedTools` `./ac start` and `./ac stop` (and the wrapper refuses both itself).
- `--strict-mcp-config` (no MCP servers: the repo's `ac` server runs an older build), `--no-chrome` and
  `--disable-slash-commands` (no skills list).

The brief therefore asks for one CLI call per Bash command: no `cd`, pipes or other programs.

**Files** (all under `$TMPDIR/acjs-agent/stream/`; `ACJS_AGENT_STATE_DIR` moves `$TMPDIR/acjs-agent`):
- `feed.jsonl` (or `$ACJS_STREAM_FEED`): the overlay's event feed, one JSON object per line, `v: 1`, `t` epoch ms,
  `type`, `char` = profile. The shapes are in `tools/stream/feed-types.ts` (owned by the overlay, `tools/stream/overlay-server.ts`):
  - `chat`: every line of `<profile>.chat.log`, with a channel (say / tell-in / tell-out / fellowship / general …;
    combat / magic / system by wording, since the log keeps no chat type). A line between cast members is written
    once, from the speaker's log. A character's own spell words ("You say, "Zojak Quaguz"", which retail prints as
    speech) are `magic`, which the overlay's chat panel leaves out: an incantation-shaped say (two or three
    capitalised words) within 5 s of that character's "Casting …" line, or one already seen that way
    (`isIncantation`). Real /say speech stays `say`.
  - `narration`: the player's own text between tool calls, as one short line (`narrationLine`: at most 240
    characters, cut at a sentence; line breaks flattened). A block with markdown headings, lists or tables, or a long
    multi-paragraph one, is not narration: the end-of-segment report went to the ticker whole in the second rehearsal
    (2026-10-13). The report goes to `reports/` only.
  - `tool`: each CLI call, summarized, with object ids turned into the names observe printed
    ("casts Flame Bolt III at Drudge Servant (repeat)").
  - `segment-start` / `segment-end`, `session-start`.
  - `death` (the "Your corpse is located at" line, the killer from the line before it), `level-up`.
  - `status` every `statusEverySeconds`.
- `segments.jsonl`, `reports/<profile>-…-seg<N>.md` (each final report), `sessions/<profile>-<day>-seg<N>.jsonl`
  (the raw stream-json), `supervisor.log`.

**Cost (rehearsal 2026-10-13, Opus 5.5, 12-minute segments, two segments per character).** $2.11–6.18 per segment
per character ($14.49 for the four), 86–208 model calls each, 5.5–21.3 M cache-read tokens per segment. Each call
re-reads the whole context, and that re-read was most of the bill:
- The first call was already ~38–41k tokens: Claude Code's prompt and tools, the brief, and ~61 KB of instructions
  that had nothing to do with playing: the repo's CLAUDE.md (36 KB), `~/.claude/CLAUDE.md` (9 KB) and the project's
  auto-memory index (15 KB), plus the auto-memory instructions (~2 KB) and the worktree's git status. The account's
  own CLAUDE.md loads from any directory, so a new directory alone isn't enough.
- The context then grew ~5–10k tokens a minute, to 90–160k by the wrap-up. In Bulwark's 208-call segment: 144 bare
  `wait`s (77 KB of results: a bare wait wakes on every chat line, his partner's spell words included), 17 `observe`s
  (63 KB, 25 objects each), one `help` (14 KB, kept in context for every later call) and two `npm warn` lines (~170
  bytes) on every single result.

Trims (applied):
- The player directory plus `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`playerEnv`)
  and `--disable-slash-commands`: about 64 KB less on every call (system prompt + reminders went from ~80.5 KB to
  ~16.5 KB of text, about 16–18k tokens fewer; the brief itself grew 1.3 KB). The first call should drop from ~39k to
  ~21–23k tokens.
- `./ac` instead of `npx tsx tools/ac-agent/cli.ts … profile=…`: no npm warnings and ~40 characters less per call,
  and 0.4 s per call instead of npx's start-up.
- The brief: `./ac help <tool>` instead of the full 14 KB list (the tool names are in the brief), waits with `types=`
  and `chat_match="] <partner> says"` in a fight (with `tell` in types: any tell, or the partner's /f lines),
  `observe max=10`, one /f line instead of three.
- `segment.autoCompactTokens` (100000, the smallest Claude Code accepts; `CLAUDE_CODE_AUTO_COMPACT_WINDOW`): a
  segment's cost otherwise grows with the square of its length, and at 75 minutes the context would reach the
  model's default window.

Replayed over the rehearsal's own 510 calls, the first three trims alone remove ~12 M of its 45 M input tokens (27%);
fewer wake-ups and the compaction cap come on top and are measured at the next rehearsal (`segments.jsonl`). The model
(`model` in cast.json) and its effort (`effort`, null = the account's default, which is `high` here) are Jake's call.

**Status without stealing chat.** `observe` consumes the agent's "chat since your last look", so the overlay never
calls it. The daemon has a read-only `GET /vitals` (`AgentClient.vitals()`, `cli.ts vitals profile=…`). It is not
an agent call, so it doesn't hold off the idle logout. It returns the API's `vitals()`: health / stamina / mana,
level, XP total, to-next and the level's start (the client's XpTable 0x0E000018), coords or cell, task, goal and
dead. It reads only, and `READ_METHODS` lists it.

**The goal line.** The overlay's line under each name is the player's `./ac goal text=…` (the agent API's goal,
carried by `/vitals` into each `status`). Nobody set one in the rehearsal, so the brief now asks for it at the start
and whenever the plan changes, and the wrap-up asks for it again.

**Starting two daemons at once.** The rehearsal's two daemons raced: both `git worktree add`ed the same snapshot (one
died: "could not lock config file … config.worktree"), and both took bridge port 9151, so Bulwark's page ran on
Arcanist's bridge and fell to character select when Arcanist's daemon stopped, mid wrap-up (his "sent" goodbye came
from character select). The daemon now makes its snapshot and starts its bridge and Vite under a state-dir lock
(`tools/ac-agent/stateLock.ts`, `STATE_DIR/daemon-start.lock`, an exclusive mkdir with the owner's pid; a dead or
5-minute-old owner is taken over); a bridge that exits on its port is retried on the next, and a half-made snapshot
is removed and made again. A daemon's shutdown also lets a running agent call finish (up to 10 s) before it logs out,
and `/status` reports `busy` (calls running).

**Public servers (attach).** There the daemon does not log in itself: Jake logs each character in, and the
supervisor attaches. In cast.json a character gets
`"attach": { "endpoint": "http://127.0.0.1:9222", "logoutOnStop": true }` (`"chrome"` opens the agent Chrome).
- **Two characters in one Chrome:** open two tabs at `https://playwebac.com/?agent`, log each account in and enter
  with its character. The supervisor starts each daemon with `attach=<endpoint> character=<name>`
  (`--attach-character`). `pickGameTab` then takes only the tab whose `__acAgent.self()` is that character, so the
  two daemons never share a tab. Until the character is in the world, the daemon waits and the supervisor holds that
  character's segment. If another character enters in a tab, its daemon waits rather than drive the wrong one.
- Each character still needs its own profile.
- Chrome throttles hidden tabs. The page's worker clock keeps a hidden tab playing ("Covered or hidden windows",
  above), but for the stream each tab is best in its own visible window.
- A daemon's `stop` never logs an attached tab out. So when the stream stops (or a character halts) the supervisor
  first calls the game's own `logout` through the API and waits for character select. `logoutOnStop: false` leaves
  the tab logged in.
- On a public server its rules on bots come first.

**Settled by the rehearsal (2026-10-13):** a stream-json message sent mid-turn reaches the player (each wrap-up was
answered with a report within a minute); `total_cost_usd` is reported on this login.

**Not yet settled** (verify live):
- that `Bash(./ac:*)` / `Bash(./world-query:*)` allow every player command under `dontAsk` from the player directory;
- that the first call's size drops as estimated with `CLAUDE_CODE_DISABLE_CLAUDE_MDS` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
  (the session transcript under `~/.claude/projects/<player dir>/` shows the `instructions` attachment, or its absence);
- how play holds up across an auto-compaction at 100k (the summary keeps the plan? the next call's size?).

### Good players first (2026-10-14)

Jake, watching the stream: "the mage dies so much lol are they upgrading their gear". Claude Arcanist (level 19, ~83
HP) died three times that day (Banderling Striker, Mud Golem, one unattributed), Bulwark none. Read through `gear`:
hands EMPTY, legs clothing only, the cloak slot EMPTY with a Chevron Cloak in his pack, a Pathwarden Helm in the
pack, and no worn armor appraised. The brief's Gear paragraph and observe's `gear:` line were there, and in the whole
segment neither player called gear, appraise, equip or buy: they act on what's in front of them, chiefly the
segment's opening message. Then Jake: "gear, stats, buffs, and useables (heal kits, potions) are always paramount to
survival. adventuring in missing/low-level gear is a death wish", and "i want to optimize for good players over
entertainment; entertainment follows". The brief's stream pressure had been overriding what Claude already knows about
playing well: "Earlier sessions lost hours to … long shopping and buffing stops" and the dead-air framing pushed speed
over preparation. Last, the pair should talk like two friends playing AC, not role-players.

What changed:
- **The opening message's readiness block** (`readinessBrief` in `tools/stream/prompt.ts`): facts only, a few lines.
  Gear gaps from the daemon's `inventory` read (`gearView`: bare body parts, clothing-only parts, pack items that
  would fill an empty slot including the cloak, worn pieces never appraised), unassigned XP and skill credits from
  the `characterSheet` read, healing kits and health / mana potions in the pack (by name: ACE's Healer weenies are
  "… Healing Kit", "… Health Kit", "Renegade Herbal Kit", "… Healing Tissue"; its restoring potions "Potion of
  Healing", "Healing Tonic", "Mana Potion", "… Elixir", "… Draught"), and every character's deaths (with killers) and
  levels since session-start, tallied from the same chat-log events the feed writes. Both reads are agent-API reads
  (`READ_METHODS`) and don't take the player's chat. Example (Arcanist's 2026-10-14 gear):
  ```
  Your readiness right now (`./ac gear`, `./ac character`, `./ac inventory` for the whole picture):
  - gear: nothing worn: no helm or hat (head), no gloves (hands)
  - gear: clothing only, no armor over it: upper legs, lower legs
  - gear: in your pack, would fill an empty slot: Pathwarden Helm #80002002 (head); Chevron Cloak #80002001 (cloak)
  - gear: 4 worn pieces with unknown armor level (Studded Leather Coat, Shirt, Pants, Leather Boots): appraise to compare
  - unspent: 612,345 XP
  - skill credits: 2 now; next at level 23 (+1) and 26 (+1)
  - in your pack: 0 healing kits, 0 health potions, 2 mana potions
  - deaths and levels this session: Claude Arcanist: 3 deaths (Banderling Striker, Mud Golem, unknown); Claude Bulwark: 0 deaths
  ```
- **The brief, restructured around playing AC well:** the tool and permission facts; a firm **Readiness is survival**
  rule (no fixable EMPTY or clothing-only slots, XP and credits spent, buffs up, kits and potions carried, "adventuring
  in missing or low-level gear is a death wish"); **Play well together** (find each other, fellowship, stay together,
  buffs, tactics with leave rules, progression, move on when a place stops paying, dungeon jumps), where their own AC
  and RPG knowledge leads and the brief gives the facts that differ; Gear and Mana facts; using the tools well;
  keep playing / remember; and one short **On stream** section near the end (talk in /f like friends playing, the goal
  line, narration welcome, "preparing is good play, not dead air; dead air is standing idle with nothing being done").
  Gone: "On stream (this matters as much as the rules below)", "Variety is the show", the line blaming shopping and
  buffing stops, and the "still picture" dead-air framing.
- **Talk like players, not role-players:** the brief asks for game talk (targets, mana and health, loot, where next),
  shorthand (OOM, brb, gg), natural teasing and the odd real excitement, no theatrical in-character speech, emotes
  only when a real player would. `cast.json` personalities are temperaments now (Arcanist the curious one, a bit
  cocky about damage; Bulwark dry, deadpan, protective, with a grudge list), not characters to perform.
- The readiness rule is mirrored in `.claude/skills/play/SKILL.md` and `tools/ac-agent/hostedGuide.ts`.
- **Skill credits ahead and a standing goal** (Jake, 2026-10-14: "lets just get the credits ASAP no temple"). The
  readiness block's credit line names the next two levels that grant credits. They come from the era's own XpTable
  `characterLevelSkillCreditList` (portal 0x0E000018; ACE `Player_Xp` adds `list[newLevel]` on each level-up). The
  client already loads it for the raise costs (`setRaiseCallbacks` → `levelSkillCredits`), and the character sheet
  prints a `Next skill credits: level 23 (+1), level 26 (+1)` line that `readinessBrief` reads. End of retail grants
  one credit at levels 2–10, 12, 14, 16, 18, 20, 23, 26, 29, 32, 35, 40 … 275. AC1999's table differs and comes
  through the same path. A character's `goal` in `cast.json` is a standing plan in every segment's opening ("The
  plan for now: …"), where `startNotes` shows in the first segment only. Arcanist's: Item Enchantment (8 credits,
  EoL SkillTable) as soon as the credits arrive, so efficient XP to level 26, and no Temple of Forgetfulness.
  Bulwark's: help him level efficiently.
- **Mana for casters** (Jake: "the mage should rely on stamina to mana most of the time"): the brief's Mana facts make
  Stamina to Mana Self the routine source, cast between fights since stamina refills fast. Mana Conversion lowers
  costs, and potions are for emergencies mid-fight.

### Dead air (measured 2026-10-14)

Dead air is time a viewer watches a character doing nothing visible. Measure every rehearsal the same way:

```bash
npx tsx tools/stream/dead-air.ts $TMPDIR/acjs-agent/stream          # [--logs <dir>] [--top 8] [--min 10] [--json]
```

It classifies every second of each segment from three sources. The session stream-json gives each tool call's start,
end and result. `<profile>.chat.log` gives the character's own swings, casts, damage, speech and portal space, and the
partner's lines. The daemon log's walk trace shows searches that found nothing and stalls; it has timestamps from
2026-10-14 on (`pageLogLine`). Visible classes are fighting, talking and moving. Dead-air classes are stuck, waiting
(inside a `wait`), tools (any other call) and thinking (between calls). The report gives:
- each segment's split, up to the wrap-up and in full;
- the seconds both players were idle at once (what a viewer of both windows sees);
- the idle stretches of 10 s or more with their cause, the player's own words and calls;
- the model's gaps between calls and the time per tool;
- the waits that slept on after the partner spoke.

The tool has two known gaps. A walk that "arrived" counts as moving unless the timed trace shows its failed searches.
A follow beside a leader who stands still also counts as moving.

| | rehearsal 1 (4 × 12 min) | rehearsal 2 (2 × 12 min, after the cost trim) |
|---|---|---|
| visible, per character | 72% (fighting 38, moving 26, talking 9) | 48% (fighting 15, moving 28, talking 6) |
| waiting / thinking / tools / stuck | 11 / 10 / 4 / 3% | 37 / 6 / 4 / 5% |
| both players idle at once | 7% / 6% | 29% |
| waits that slept after the partner spoke | 9 waits, 0:57 | 11 waits, 3:52 |

The causes, in idle stretches of 10 s or more:
- **Waiting for the partner:** 5:09 in rehearsal 2, 2:51 in rehearsal 1. In rehearsal 2 most of it was the fight wait
  `types=…,tell chat_match="] <partner> says"`, which slept through every one of the partner's /f lines (the AND bug,
  fixed in 04639865 after that rehearsal). Bulwark also held the Foundry entry for 4 minutes while Arcanist was stuck
  topside.
- **Waiting for mana:** 3:12 and 1:00. Arcanist began at 25% mana and both stood in town ("let it regen", "meditate").
  On ACE, standing doesn't restore mana faster: `GetStanceMod` changes only health and stamina (sit ×2.5, crouch ×2,
  sleep ×3, combat stance or running ×0.5). AC has no meditation.
- **Stuck walk / portal hand-off:** 3:02 and 1:37. This was the Holtburg pedestal pit to the Mannikin Foundry portal,
  in every entry of both rehearsals: `use` on the portal timed out at 45 s 19 m away, then a walk took 55–105 s. The
  trace shows 6–12 doorway searches that found nothing ("no doorway route … 1 door(s) that would not open left out",
  "no way into the doorway … something stands in it") before "searching wide straight for the goal, jumps and drops
  included" found the way in 16 points.
- **Buffing:** 1:36 in rehearsal 1 (Bulwark standing while being buffed; the caster's casts are visible, so the pair
  was rarely idle).
- **The model's thinking:** a median of 1.6–2.2 s between calls, 6–10% of the time, spread out rather than in long
  gaps. Gaps between pulls were 2–4 s, so a ready-made hunt routine would win little. None was built.

Changes made after this measurement:
- **The brief (`brief.md`):** a "Dead air" paragraph (replaced the same day by "preparing is good play, not dead air":
  see "Good players first") and the mana facts above (regeneration is the same standing or
  walking; mana potions; Mana Boost Self, Stamina to Mana Self, Health to Mana Self, Mana Renewal Self, all in the
  end-of-retail SpellTable). The two "keep `wait` to 30–60 s" lines are gone; rule 4 now says go to the partner rather
  than wait.
- **A 30 s reply for a player's acting calls:** the `./ac` wrapper sets `AC_AGENT_REPLY_S=30` (`PLAYER_REPLY_S`), the
  client sends it as `replyMs`, and the daemon answers a walk, follow, use or cast repeat still running at that point
  with "still in progress" (`replyDeadlineMs`). Waits and reads keep the daemon's 240 s. Before this, a 120 s follow
  held Arcanist beside a leader who had stopped, and `claude -p` pushed it to the background. Another queued Bulwark's
  "/f Belay the Mosswart" for two minutes.
- **`follow`:** when the leader vanishes beside a portal, the reply names the portal, says where it is, and says to
  `ac_use` it. "Last seen" now comes from where the leader last stood in sight; it used to read "23954 m SW" from the
  leader's new dungeon cell.
- **The feed:** a war spell's damage and kill lines ("You burn … for 43 points with Flame Bolt III", "… is incinerated
  by your assault!") are combat, not system. 13 of them reached the overlay's chat in rehearsal 2.

**What the next rehearsal should show:**
- visible time back to at least rehearsal 1's ~70%;
- "both idle at once" under 10%;
- "slept on after the partner spoke" near 0;
- no "waiting for mana" stretches;
- calls blocking more than about 30 s gone from the tool times (except waits).

**The pedestal walk, fixed after the measurement (2026-10-14).** On the real A9B4 DATs, the cell route's first doorway
into the statue's tunnel has its sill (feet) at z 68, 2 m above the town's ground at z 66. A search toward it can never
reach its floor ("none after 1829 points" offline, 1827 live), while the wide search for the portal walks down the ramp
in 16 points (`tests/verify-agent-walk-ladder.ts`). The walk ran that doorway's whole ladder (the box, wider, with
jumps and drops), went to open the pedestal, and then ran the ladder again. Now a leg whose ladder found no way once
goes straight to the wide search when the walk comes back to it (`AgentApi.LEG_LADDER_RERUNS`, 0). The door detour
still runs once. In the fake-host repro this took 6 failed searches (25,661 points) down to 3 (14,175). At the
pedestal's ~4.5 ms a point, that is about 50 s less standing in the 105 s walk. Each "walk search" trace line now says
how long it stood and how far into the walk it was. The brief also no longer has Bulwark refuse to pull unbuffed.

**The root cause, fixed in the cell router.** The tunnel's real way in is cell 0x177's outside portal: 1.79 m tall,
with its sill on the ramp's top at z 66.21, over the town at z 66. The body walks through it
(`verify-bug-holtburg-statue-tunnel-wall`). `cellPath` took it for a window because it is under `OPENING_MIN_HEIGHT_M`
(1.83), so the only route left went in by 0x178's opening, whose sill is at z 68 over a floorless cell
(`grounded: false`). Now `routeViaOutside` tries a slightly low opening (`lowDoorway`: from `LOW_DOOR_MIN_M` 1.75 up to
1.83) whose sill is on the ground, after the doorways the ground reaches and before a doorway no walk reaches.
`groundExits` now also measures whether those low openings are on the ground. House windows (1.68 m) stay windows,
and the tavern's 1.80 m bar openings are interior, so their route is unchanged. On the real DATs every leg of the route
from the town to the portal is now found by the first search, with no failed searches (the DAT test in
`verify-agent-walk-ladder.ts`, which also keeps the old route's first-leg failure as the "before").

## What a player sees that the agent is told (2026-10-11)

The agent only knows what the tools say, so anything a player reads off the screen has to reach it as text. Information,
never a decision: what to fight, wear or sell stays the model's call (Jake: "I'd expect the LLM to use more common sense
here, not having to hardcode behavior").
- **Who is hitting you.** Each CombatEnemy line ("The Drudge Skulker hits your chest …", "You evaded …") of the last
  10 s is credited to the monster it names (the nearest of that name): observe marks it `ATTACKING YOU (N× in 10 s)` and,
  when it isn't your target, adds `under attack by: …`; `ac_attack` on another monster adds a note. (A Haiku Bulwark
  kept starting on new monsters while one chased him.)
- **Line of fire.** A war bolt flies straight and the server says nothing when it hits a wall ("You cast …" only means it
  left your hands). `ServerObjectManager.lineOfFire` sweeps the client's own missile collision (walls, terrain, closed
  doors; not creatures) along the bolt's real path (`boltLaunch`, ACE WorldObject_Magic): from your eye to the spawn
  point (ACE's `IsProjectileVisible`: 0.58 m ahead at 2/3 of your height when the target is within 0.6 m cylinder
  distance, else 1.16 m), then from there to the target's 2/3-height point: the target line shows
  `no line of fire: blocked D m along it`, and `ac_cast` refuses a projectile spell (MetaSpellType Projectile /
  LifeProjectile / EnchantmentProjectile) with no line. (Arcanist cast round a corner and hit nothing.) There is no
  minimum bolt distance in ACE or retail: ACE's own physics (the live server's ACE.Server.dll driven offline over the
  EoL DATs by `tools/ace-physics-harness/run.sh`, 2026-10-14) hits a still target at 0.6–3.5 m on open ground and at 1.4–2.4 m in every one of 2797 spots of
  dungeon 0x0145 where 3–4 m shots hit. The "point-blank misses" were a closed door between you: ACE monster melee
  checks distance only (`GetDistanceToTarget`: cylinder distance ≤ 0.75 m), so a skeleton pressed against Door
  #70145010 (the lever-timed door at the foot of 0x0145's stairs) clawed the mage through it while every bolt died on
  the door in silence. The old check swept the eye-to-target-middle line minus its first 0.58 m and last 0.71 m, which
  is where such a door stands; a bolt that still does nothing names what is in its way.
- **Repeat casting (2026-10-12).** `ac_cast repeat=true` keeps casting one spell at one target, each cast through the
  single cast's own path (busy wait, line-of-fire check, outcome wait), so no faster than the client allows, and answers
  one summary: each cast's result, damage dealt, resists and fizzles, your vitals, and why it stopped. It stops, saying
  so, when the target dies or goes, your mana is below the spell's cost (the spell table's BaseMana, or the least a cast
  took this run, since Mana Conversion only lowers it; else the server's "not enough Mana"), the server or client
  refuses a cast (no line of fire, out of range, "too busy" twice running, no reply twice), your health is below
  `until_health` (default 50%), a monster that wasn't hitting you when it started (attackersOfMe) and isn't the target
  starts to, or after `max_casts` (20) / `max_s` (120). It is a task like a walk: another action, `ac_stop_moving` or
  your death ends it with the summary so far, and a long one answers "still in progress" with the summary on
  task-done. A single cast replaces it. Why: Bulwark's `ac_attack` is one call and the server keeps swinging (a
  level-8 drudge in ~5 s), while each `ac_cast` was one bolt per tool call, and with 5–8 s of thinking between calls
  Arcanist got a bolt off every 10–15 s: over 7 minutes Bulwark landed 6 killing blows to Arcanist's 3 bolts, and the
  mage looked stuck to the human watching. A retail player keeps pressing the bolt key, VirindiTank and our routines
  cast repeatedly too: a tool gap, not a play decision. Nothing era-specific (the same cast path in all three eras).
- **A caster's attack casts (2026-10-13).** `ac_attack`, and a routine's `pull` and `attack-nearest` (all `AgentApi.attack`),
  with a wand, staff or orb wielded (or already in magic mode) fight with spells: magic mode, then the attack spell the
  VirindiTank macro would pick for its `<DEFAULT>` row (`combatPlan.casterAttackSpell` → `planCombat`: Auto element from
  the era's monster table, bolt / arc / streak finisher, Drain Auto with neither War nor Void trained), cast again and
  again through `ac_cast repeat`'s path until the target dies, closing in only when the spell's range or a wall is in
  the way. The spell, its family and your skill all come from the era's spell table and your known spells, so it is the
  same in all three eras. Before, the attack sent the attack key's swing, which magic mode has none of (no attack event
  in magic mode: retail ExecuteAttack, ACE Player_Melee), and nothing was ever cast: a mage's routine pull of a Sparring
  Golem said "no swing or shot landed in 25 s; not pulled" while the VTank macro profile fought the same golem fine.
  No castable attack spell: the attack says so at once.
- **Ranged attacks shoot from where you stand (2026-10-12).** `ac_attack` with a launcher or thrown weapon (missile
  mode, or peace mode with one wielded) no longer runs up to the target: Jake's archer Azreath (Shortbow, Range 65 yd)
  was run 48 m in to ~1 m of a Virindi Observer it could hit from 53.7 m. The server never walks you to a missile target
  (ACE Player_Missile turns and fires); it refuses with "Out of Range!" + AttackDone when TargetInRange fails (3D
  distance over min(MaximumVelocity² / 9.8, 85 yd)) or when no ballistic arc reaches the aim point
  (Creature_Missile.GetProjectileVelocity → Trajectory.solve_ballistic_arc, at MaximumVelocity × 1.2 with Use Fast
  Missiles; uphill the reach shrinks: a 24.9 m/s Shortbow reaches ~40 m across at +19 m). The agent applies the same
  two tests (`missileShot`, packages/shared/src/combat/MissileRange.ts) with the launcher's MaximumVelocity from its
  appraisal (WeaponProfile MaxVelocity; an unappraised launcher is examined quietly first, up to 2 s, and with no reply
  it says it assumes ACE's default 20 m/s), the body and target heights and the attack height: in reach (97%) with a
  clear line (`lineOfFire`; unknown, doorways between count as blocked) it shoots at once and says "shooting at X from
  here: 53.7 m away, within your Shortbow's ~59 m"; otherwise it walks only until both hold (90% of the reach), saying
  why ("out of your Shortbow's ~59 m", "no clear line of fire"). A server "Out of Range!" anyway (its view of you lags,
  the target moved) closes in under the distance it was said at, twice, then ends as `target-lost`. Melee keeps its
  run-up; magic mode is unchanged. All three eras: combat mode and the appraisal's MaxVelocity come the same way (the
  1999 codec maps its weapon profile onto the EoL one; a 1999 or Classic thrown weapon's velocity is the server's
  Strength-based figure). The 1999 server's own gate is a flat 80 m plus its trajectory; ClassicACE is ACE's.
- **Idle characters are logged out (2026-10-12).** Jake: "you should always log out if you stop controlling them
  otherwise they might die to stuff? unless ive taken over". Whoever stops driving a profile runs `stop` (briefs end
  with it), and the daemon itself logs an agent-started character out after 15 minutes (`--idle-logout-min`,
  `AC_IDLE_LOGOUT_MIN`; 0 = never) with no agent call, nothing Claude started still acting (`acting()`: a task or
  a running routine) and no trusted key/mouse/wheel input in its window (a human who took over). It never touches an
  attached tab (the human's own login), and players' own sessions never run the daemon at all.
- **Leaving a fight and planning trips (2026-10-12, Jake's archer Azreath on Coldeve, via acjs-1b).** He died after two
  Virindi Executors and an Observer joined a tusker fight; vitals-low woke him only at 14% health, and he had tried /ls
  to escape. The hosted guide and the play skill now say: decide your leave rules before a fight (a second attacker, any
  caster, 60% health) and check in every few seconds; leave early with `ac_walk_to flee=true`. /ls is no escape: ACE
  (Player_Location.HandleActionTeleToLifestone) plays the NonCombat LifestoneRecall motion, waits its length and cancels
  if you moved more than RecallMoveThreshold (8 m) by then; damage doesn't stop it; on the client a jump cuts the
  animation short (CMotionInterp::LeaveGround @ 00528b00 → RemoveLinkAnimations). Plan trips (destination, route,
  spawns, entry requirements: the Temple of Forgetfulness guardian wants an Archmage herb, and its portal drops you at
  Far Horizon Cottages 92.9N 2.4W, a run from 88.8N 0.0E). Archers shoot from range.
- **Monsters coming at you, and at your fellow (stream day 2026-10-14).** Jake: "as they run to destinations they make
  no effort to avoid mobs and dont stop until they're actually hit which might be once they're mobbed". At 19:44 UTC in
  Dryreach Arcanist's `walk_to` ran on while two Shadows and a Shadow Child closed from behind: the first word was a
  23-point crit, 85 → 28 HP in four seconds, dead eight seconds after the first hit. At 19:29 the pair came out of the
  Bone Lair into five Mud Golems; Bulwark read "none are attacking" and raised skills 2 m from the mage while they killed
  her ("I was counting skill points while the mud ate you"): nothing told him his partner was being hit. What the client
  knows: the server's MoveToObject / TurnToObject for a creature carries its target (ACE Creature_Navigation.MoveTo /
  TurnTo; Monster_Navigation chases its AttackTarget with a MoveToObject, after a TurnTo; the 1999 server's AttackEventData
  MoveToObject / TurnToObject likewise), our client runs it on the creature's MoveToManager, and a melee monster at its target is stuck to it
  (StickTo). The host passes it as `AgentHostObject.seeks` (main.ts), and `AgentApi.comingAt(who)` reads it: aimed at
  them (running at / turned to face / on them), its last aim at them while within 6 m (a swing's motion cancels the
  MoveTo on the client), or its own place closing on them by 4 m within 3 s inside 40 m (sampled every 250 ms); a monster
  walking home (MoveToPosition) or aimed at someone else is not. Information and capability, not decisions:
  - observe: `COMING AT YOU (running at you)` on a monster not yet hitting you; a fellow's line adds
    `MONSTERS AT THEM: Mud Golem L8 on them, Shadow L26 running at them 20 m off`.
  - `ac_wait` types `aggro` (a monster started coming at you, with its level, distance and how; its level is looked up
    quietly when unknown), `fellow-aggro` (one started coming at or fighting a fellow) and `fellow-low` (a fellow's
    health below 60%, `fellow_below=` per wait, or a quarter of it in one drop; the fellowship panel's vitals).
  - `ac_walk_to` and `ac_follow` answer when a monster starts coming at you: `stopped 31.0 m short: Shadow #8000b6e1
    (level 26) is coming at you, 24 m E (running at you). Fight it …, get away from it …, or walk on anyway
    (stop_on_aggro=false)`. One already coming when you set off doesn't stop it; flee never does. Routines' own walks
    (api.walkTo without the tool) are unchanged.
  - `ac_walk_to` keeps 10 m clear of monsters near the way outdoors (15 m of one more than 5 levels above you; not in a
    dungeon or building, whose corridors keep no one 10 m clear): each is a disk the
    planner routes round, as portals are (`portalAvoid.avoidDisks`). A leg blocked only by monsters gets one quick search
    round them (a 20 m margin, 2500 points); any search that finds no way while keeping clear plans again without them at
    once (wider searches and jumps are for walls). The result names what it went round, or "no way on kept clear of …:
    the walk went past them". Not the target, not a monster beside the destination, none once you're hit, off with flee
    and for a follow; `avoid_monsters=false` walks straight.
  - A walk or follow to a fellow with monsters on them (on them, or within 10 m of them) keeps going through hits and new
    aggro, as a portal's does: the hits are the price of getting there. What to do on arrival is the agent's call.
  - Heal earlier (Jake: "the mage's threshold for healing seems too low"): `vitals-low` defaults to 60% (was 50%) and
    `ac_cast repeat`'s `until_health` to 60%; the brief, the play skill and the hosted guide say to heal a fragile caster
    at about 70% and the tank at about 60%, between pulls, kits and potions for emergencies, and the stream's leave rule
    is "/f RUN" with the caster below about 50% (the tank below about 35%) or more than two monsters on you.
  All three eras: the MoveTo / TurnTo movement types, the fellowship vitals and the client's position updates are the
  same path in each (tests/verify-agent-aggro-avoid.ts).
- **Follow through the hits (2026-10-12).** `ac_follow flee=true` keeps following while you're hit, as `ac_walk_to
  flee=true` does; without it the first hit ends the follow (as before). Arcanist died four times in an hour in Holtburg
  Dungeon: separated from Bulwark, drudge spawners refilled next to the 67-HP mage, its follow ended at the first hit,
  and the next decision (10–20 s away) came after Bulwark had walked on or the mage was dead.
- **Inventory.** Pack items show their type, what they fit (ValidLocations) and value, so an upgrade or something to
  sell is visible without appraising everything. Top-level containers and RequiresBackpackSlot items (packs, foci)
  are listed under `pack slots`, as the retail pack column shows them; a focus counts only there (ACE `HasFoci`).
- **Gear slots (2026-10-14).** `ac_gear`, and the top of `ac_inventory`, is the paperdoll as text (agent/gear.ts):
  the nine body parts (head, chest, abdomen, upper/lower arms, hands, upper/lower legs, feet) and the neck, two wrists,
  two rings, shield, weapon and ammo slots (cloak, trinket and sigils only when used), each with what is worn there and
  its Armor Level, or **EMPTY** with any pack item that would fit. One item covers several parts (a robe, a coat), and a
  part with only clothing on it says no armor is over it. Each wearable pack item says the parts it covers, the EMPTY
  ones it fills, what it would replace (any worn item sharing an EquipMask bit: ACE TryEquipObject's eviction) and what
  that leaves bare, its AL against the replaced item's ("AL 60 vs your 20"), and its wield requirements with whether
  you meet them (ACE `CheckWieldRequirement`: level, buffed / base skill, training; attributes are named only). The
  numbers: EquipMask ValidLocations / CurrentWieldedLocation, CoverageMask ClothingPriority (ACE
  `GetArmorLayers` adds every covering item's AL), ArmorLevel 28 from the appraisals the client holds (with the
  item's armor enchantments, as ACE AppraiseInfo sends it); an unexamined item says "appraise it to see its armor
  level". Observe adds `gear: no helm or hat (head), no gloves (hands); in your pack that would cover one: …` while a
  body part is bare. Armor costs a caster nothing in AC (ACE `GetCastingPreCheckStatus`: skill against spell power;
  only burden), which the brief says. Why: Arcanist reached level 19 with no gloves; the inventory left empty slots
  out and showed no armor level, so nothing prompted an upgrade. The same data in all three eras (AC1999's
  ObjectCreate carries ValidLocations / Location / Priority and its appraisal ArmorLevel 28, pinned in
  verify-ac1999-objects / -inventory). An older tab without the numbers keeps the plain list, and `ac_gear` says to
  reload.
- **What a use did.** `ac_use` and `ac_use_on` wait for the result and report everything a player would see: chat
  replies, the centre-screen notices ("You're too busy!"), a refusal the server sends with no text (UseDone's
  WeenieError by name), and what changed: vitals, items used up or gained, a spell learned, a buff on you. A scroll
  you can't learn yet says by how much (ACE `CanReadScroll`: the school's skill ≥ the spell's power − 50).
  (Arcanist read scrolls above its skill; `ac_use_on` used to return "using X on Y" at once.) Routines and the
  macro still call the quick `useOn`.
- **Chat log.** The daemon writes every chat line and notice the player saw, theirs included, to
  `$TMPDIR/acjs-agent/<profile>.chat.log` with timestamps (the page logs `[AC:Chat]` lines). Before this the party's
  conversation lived only in each agent's transcript.
- **Loot takes what it says (2026-10-11).** `ac_loot` never Uses a container you already have open (that closes it:
  ACE Container.ActOnUse / Chest.CheckUseRequirements, and every later pick is "Source item not found!"), moves one
  item at a time and waits for each answer (the client allows one inventory request: IsPlayerReadyToMakeInventoryRequest),
  reopens a container that closed with items left, and reports only what reached your pack, with the server's reason
  for each refusal. (Arcanist took one item per pass, four passes, each claiming all four.)
- **Range and price.** `ac_spells` shows each spell's range for you and an "Out of Range!" cast says it: retail's
  DetermineSpellRange reads InqSkillLevel (ranks + init level, no attributes or buffs), as ACE's check does, so the
  spell examine's Range line now uses that too. A skill raise names the next one's price; "creature" picks Creature
  Enchantment over Assess Creature. A cheaper first raise is XP already in the skill (cost = table[rank+1] − spent).
- **Windows.** A panel gmPanelUI hands back when the one over it closes (a book over the Character panel, closed or
  dropped by its range check after a portal) is listed as `Character (back when the Book over it closed)`.
- **Waits, places, walks.** `types=chat,tell` wakes on every chat line (tell only narrows a wait without chat);
  observe's radius and filter apply to remembered places, and without a radius only this region's (1 km) are
  listed; `ac_walk_to "10m north"` / `"5m ahead"` walks an offset; `ac_use` gives up its walk after 45 s (inside the
  tool's time), stops it, and names an open dialog; a walk judges a door only after the server answered the Use,
  gives a door that ignored its Use (ACE ignores a Use while the door swings) a second try, and never blames a door
  that opened.
- **Doors a lever opens (2026-10-14).** A door whose ItemUseable is No (ACE `doordungeonactivated`, Usable 1; the server
  sends it in the CreateObject) opens only through what is linked to it: a Lever (`leverboxswitch`, a Switch) or a
  Pressure Plate whose `ActivationTarget` is the door (`landblock_instance_link` parent = the door). Retail's own
  `ItemHolder::UseObject` refuses a Use of it with "You can't open or close this Door that way" and sends nothing
  (`input/UseObject.ts`). The link toggles the door (ACE `Door.ActOnUse` closes an open door for any activator but a
  Switch or PressurePlate object, and a lever passes the player on), and it shuts itself after its ResetInterval (300 s
  for the skeleton dungeon's door 0x70145013). Observe marks such a door `opened by a lever or switch, not by hand` and
  every door `open` / `closed`; a walk never uses one: a shut one in the doorway ahead is routed round (and through
  again once it stands open), and the answer names it with the levers, switches and plates in view within 30 m of it
  (the client never learns which one is linked). `ac_use` on it answers the same at once; a door whose Use got that
  line is remembered for the session. `ac_use` on anything reports a door within 40 m that swung open or shut. Before:
  Bulwark's walks walked to and used door 0x70145013 about sixty times in an hour (skeleton dungeon, landblock 0x0145,
  2026-10-14), counted the silent refusals as a locked door and tried the Academy Library Key on it. Same in every era:
  the useability comes from the server's object data, and the 1999 client has the same line ("… that way.",
  reference/ac1999 modules.csv). A routine's OpenDoors (`routeNodes.openDoorOnTheWay`) skips such a door too, and
  `ac_loot` stops at a container's refusal (ACE Chest "The Chest is locked", Corpse "You do not yet have the right to
  loot …", "… is already in use by …") instead of a second Use and a 20 s wait.
- **Purse.** Above level 5 a death takes half your coins and trade notes aren't coins (ACE
  `Player_Death.GetNumCoinsDropped`; with ACE's default `corpse_destroy_pyreals` they are destroyed, not left on the
  corpse); observe says "half are lost if you die" beside a purse of 1,000 or more. 412 vendors sell trade notes. On
  ACE a vendor takes only pyreals for a sale (`Player_Commerce.SpendCurrency` spends coin stacks), so sell a trade note
  back when you need cash.

- **The evening's batch (2026-10-11, Arcanist + Bulwark).** A stack's value is the stack's own (ACE `Value =
  StackUnitValue × StackSize`; the inventory had squared it). Nanto's upstairs Journeyman Scriveners did open their
  shops: ACE sent ApproachVendor (its Open emote, "Isn't it wonderful…", rides with it), and our vendor bar's range
  check (gmVendorUI's ObjectsInRange, UseRadius 3) measured from the terrain under the building (z 94), not the
  floor the player stood on (z 99), so the bar closed itself at once; it now uses the character's true feet (the
  ranged-speech check had the same bug). `ac_use` on a vendor waits for that vendor's own window (another's still
  open is no answer) and says when none opened; a use far off keeps waiting while the server's walk closes in and
  reports "you are still N m from it" instead of "used". `ac_give amount=` takes from a stack that holds the
  amount, says when none does, and is a failure unless the item left the pack (the server's refusal is the reply).
  Your own name is "you" (`use_on target=<your name>`). A far walk whose 35 m stretch ends in a lake or a wall
  goes as far as the search reached, then tries stretches turned 45° and 90° aside, keeping to the side that
  worked; a walk from inside a building to one in another landblock routes out of ours first. Being hit stops a
  walk unless the way on leads away from every attacker (or `flee=true`): you can run. ("You're too busy!" for a
  healing kit is ACE's IsBusy, set by the kit's own heal or another action in flight: checked, server behaviour.)
  A drop or jump never lands where a drop of over a metre lies within 0.45 m (jumpPlan.stableLanding: the dam
  pylons at 42.3N 78.35W turned a planned 4.8 m drop into a 28 m fall), the arrival after one waits 1.2 s to see
  the body stays, and an unplanned fall is told. The CLI prints ac_look's text after the screenshot path.
  A walk names a fellow it left far behind, and `stay_with=<fellow>` keeps you together: the walk runs as always,
  and when the fellow is more than `stay_within` m behind (15 by default) it stops once and waits until they are
  within 4 m (or have come within half the leash and stopped there), then runs on together: one stop per gap, not
  a stop every second at the leash's edge (Bulwark, stream day 2026-10-14). There is no walking pace: a run eased
  to a walk (Shift) to let a slower fellow catch up was removed the same day, because on stream the pair walked
  most of the time (Arcanist walked ~25 s, ran ~2 s, walked again, as Bulwark's run is a little slower than his;
  Jake: "why do they keep shift walking!!"). Players run, and the one ahead stops a moment. Over 500 m behind a
  fellow at 3.5 m/s the walk went from 74 s walking / 66 s running to 125 s running and 6 stops of ~3 s. The
  distances are straight-line: a fellow off to the side counts as behind (only one more than half the leash
  nearer the goal is ahead, no reason to wait), and a wait ends the walk if they pass you on another way by a
  leash. Measured along the way alone, Arcanist 50 m abeam on her own parallel route read ~0 m behind: no stop
  (20:00 UTC). `ac_follow` and a routine's Follow leg run too: up to within `within` of the leader, stand, and
  run again once they are 3 m past it; only a jump's take-off still slows to a walk. Monster levels: CreateObject carries none and the retail selection asks only for health, but ACE's
  appraisal sends Level even on a failed Assess, so ac_observe / ac_look examine the nearest three monsters with
  no level, quietly, once each (routines' own looks don't). The daemon's shutdown has a 30 s deadline, a second
  SIGTERM ends it at once, and the bridge and Vite are killed as process groups (`tools/ac-agent/shutdown.ts`:
  browser.close hung and left the daemon up for 20 minutes, deaf to SIGTERM).

- **The river batch (2026-10-12, Arcanist + Bulwark around Holtburg).** Most of the session went into the river
  east of Holtburg: walks stalled at z 27.55, every search "none", and ac_map drew 24 m rectangles of `#`. The client
  stopped a player at every fully flooded *cell*; retail (`CLandCell::find_env_collisions` @ 00532f20,
  `get_block_water_type`; ACE `LandCell.cs`; the 1999 server's `LandCell.cpp`) stops one only where the whole
  *landblock* is water (open sea), and a flooded cell is waded 0.9 m deep. Fixed in `OutdoorMovement` / `WaterMap`
  for every era (tests/verify-agent-river-holtburg.ts walks the real DAT terrain). Walks now also answer promptly
  when there is no way: a search that walked every point it could reach says the ground is closed in (with its
  area), a walk back where it stood 30 s ago, no nearer, stops ("went round in circles"), a coordinate out in open
  sea is refused before a step, and a stuck walk names open sea or an unclimbable slope on the line to the goal
  (host `navTerrain`). An attack whose run-up finds no way ends as `target-lost` with the reason. `stay_with` waits
  only for a fellow *behind* you (two players both walking with it used to wait for each other), and says when they
  stand still (12 s) or head elsewhere instead of waiting 45 s. **`ac_follow`** follows a player (within N m,
  re-aiming, standing while they stand, for duration_s): retail has no follow command (none in the decomp), this is
  VirindiTank's Follow nav / `/ub follow`. `ac_buy` waits for each buy's answer and queues the next (ACE refuses a
  service while the vendor `IsBusy` casting the last one); `ac_vendor` marks services (ItemType TYPE_SERVICE
  0x100000: "service: casts it on you when you buy it; not a scroll"). `ac_loot` waits for peace mode to really take
  (a mode change asked mid-swing goes out later and cut the server's walk to the corpse short) and Uses once more if
  nothing opened. `ac_attack` on a monster that just died says so and where its corpse is. `ac_give` that the
  server cancels ("… can't be given - action cancelled": its walk to them was cut short; coins are not special)
  tries once more, then says what works. `ac_inventory` lists each side pack's contents under it and says when a
  pack is empty. The daemon answers any call within 240 s ("still in progress" for a long walk): Node's fetch gives
  up after 300 s with a bare "fetch failed". Checked, not bugs: chat lines and `seq` printed twice came from the
  agent's own `sed` ranges overlapping; a focus still burns Prismatic Tapers (ACE `SpellFormula.GetFociFormula`: the
  scarab plus tapers by power); an Orb wielded with too little Arcane Lore stays wielded with its spells off (ACE
  `TryActivateSpells` → `CheckUseRequirements`).

- **The night batch (2026-10-12, Arcanist + Bulwark in Dungeon Fern 0x01B3 and Holtburg Dungeon 0x01F6).** Fleeing
  didn't move: `walk_to "15m east" flee=true` aimed into the rock past a corridor wall and stood still through four
  escalating searches (box, wider, jumps, straight for the goal; ~250 points a second headless) while drudges killed the
  mage, and the result said "you kept going". Under attack a search now stands at most 1.5 s; no way to the point means
  the farthest open point it reached (an offset like "15m east" is a direction: walked as far as the way goes, attacked
  or not), else an answer at once with the open ways (`Open ways from here: N 20+ m, S 12 m…`, a straight probe each
  compass point). A stall under attack is 1.2 s, and hemmed in by monsters (they block a body; the probe leaves them
  out) says who and where it's open. "You kept going N m" only when the body got 3 m or more from the first hit; else
  "you did NOT get away". A cast stops the player with W still held (CommandInterpreter::MaybeStopCompletely: a held key
  moves nothing until pressed again), so a walk whose body hasn't moved for 0.5 s lets W go and presses it again.
  A dungeon is its own space (host `cellSealed`: an interior cell without SeenOutside): a walk from one to another
  landblock, or to landscape map coordinates, is refused with where the place is ("stopped 34360 m short" six times,
  for a sign outside by the portal). Map coordinates of the dungeon you are in DO walk (2026-10-13): Decal and
  VirindiTank give a dungeon position as coordinates of its landblock's own frame (origin + the EnvCell-frame position;
  a VTank dungeon .nav is a list of them, with Z = metres / 240), and so does `mapCoordsText(me.pos)`. `coordsCell`
  asks host `floorsAt` (cellPath `floorsAt`: the cells' walkable floors under the point) for the room, on the storey
  nearest the walk's `z` (a route point's VTank Z) or your feet, and the walk routes to that cell like any in-dungeon
  goal. The point is never placed by dividing by 192: dungeon frames run outside 0–192 (the Training Academy 0x7202
  spans local y −255..5; a hive route's point at 0x039D is local (51, −56), room 0x039D0156 at z −30, VTank Z −0.125).
  In a building the same lookup puts a coordinate inside it in its room (within 3 m of your storey). Attack lines are placed when they come, on the nearest of that name within reach (a swing
  8 m, a spell 60 m), never moved onto another of the name later; none in reach is `hit by, but not placed`. ac_wait:
  vitals-low at half health by default (`vitals_below=`, `mana_below=`, `stamina_below=` per wait; it was 35%, and woke
  an archer at 14%), any single hit over a quarter of max health, `attackers-up` and `cast-at-you` (a spell landing on,
  failing on or resisted by you, or a creature within 40 m speaking spell words: ACE Monster_Magic broadcasts them).
  `ac_pick_up` waits for the item in the pack or the server's refusal (a walk_to straight after cancelled ACE's walk to
  the note: "can't be picked up - action cancelled"); a note or book on the ground is read from the pack (ACE's torn
  notes are ItemUseable Contained; ac_use from the pack shows the pages). Shopkeeper Renald the Elder stands in a booth
  (0xA9B40141) reached only through counters: the route ends at the street outside his service window 0x14F
  (`cellPath.counterSpot`), not through the shop's 1 m counter sill. A buy you can't afford says the price and your
  purse (ACE BuyItems_ValidateTransaction refuses with no words); trade notes don't pay (SpendCurrency). A vendor id from
  an earlier listing is found again by its name (ACE re-ids the stock on every open), and a decimal id is read as one.
  A portal whose server walk never moved you is walked into; walk_to a portal stops beside it. A dying creature is
  `DYING`, never "hp 32%". The line of fire names what blocks it and counts only objects in the world (not held items or
  released ones); an offline sweep of Dungeon Fern's cells and statics from the DAT (30,000 pairs with a clear waist-high
  line) found no false eye-line blocks, so the liches' "blocked 1.5 m" came from an object: the blocker's name will say.
  Checked, not ours: Bulwark's corpse went in 15 s because it was empty (ACE `Corpse.RecalculateDecayTime`: no items,
  EmptyDecayTime 15 s, with corpse_destroy_pyreals on; a corpse with items lasts max(1 h, level × 5 min)); "Your Arcane
  Lore skill is too low to use that item's magic" is the retail client's own line (decomp :360421); a Risen Soldier
  hitting for 0–2 is its world-DB claws (body parts 2–3 damage, variance 0.75).

- **The late batch (2026-10-12: Arcanist in Dungeon Fern, Jake's Azreath and prod session).** `ac_follow` stood
  Arcanist under the ledge Bulwark had walked up a ramp onto, 6 m overhead: "beside the leader" was across the ground
  only. Indoors (a building or dungeon) a leader 2.5 m or more up or down is not beside you: the follow says so in an
  `[Agent]` line, takes the floor-aware planner's way up (or down), and a follow that finds none ends "X is 6 m above
  you on a ledge or upper floor; no way up to them was found from here". Out on the landscape a fellow up a slope is
  still beside you. A walk to an object right overhead now searches for the way to its floor instead of standing under
  it. Arrows: ACE spawns the missile 2 × (your radius + the arrow's 0.1 m) in front of you at Height × 0.8454, tilted
  by the aim motion (GetAimLevel: normalized z × 90 snapped to 15°), and flies it on the low `solve_ballistic_arc` to the
  target's Height / GetAimHeight (Player_Missile.LaunchMissile, Creature_Missile.GetProjectileSpawnOrigin /
  CalculateProjectileVelocity; `missileArc` in packages/shared/src/combat/MissileRange.ts). `ServerObjectManager
  .missileArcOfFire` sweeps that arc (and the server's IsProjectileVisible check, spawn point back to your eye) with
  lineOfFire's own sweeps; the archer's clear-shot test, observe's target line in missile mode ("your arrow's arc
  would hit that") and the macro's line check in missile mode use it. War bolts keep the straight line (ACE
  CalculateProjectileVelocity: gravity only for Arc spells). A long level shot lobs at AimHigh45 and its apex finds a
  dungeon ceiling the eye line clears. Two "Your missile attack hit the environment." in a row (ACE
  ProjectileCollisionHelper.OnCollideEnvironment) stop the shooting: the attack says so, walks off that spot (2.5 m at
  least) to where the arc is clear, and after two moves gives up as target-lost; such shots no longer count as the
  "server won't attack it" empties. `ac_sell amount=1` of a 38-note stack reported "not sold" while the sale went
  through: it stopped waiting at the client's own "Splitting the Trade Notes (250,000) before selling them" notice. It
  now waits for the coins, the item leaving, or a refusal (ACE Player_Commerce texts). `ac_use` of a portal keeps
  walking while hit and runs into it (`flee=true` does the same for a door, lifestone or NPC); a walk hemmed in by
  creatures while hit steps round them (the open direction nearest the way on that no creature stands in, up to three
  tries, said in an `[Agent]` line) before it says who blocks. The guides say to commit to an exit early: monsters
  body-block. All three eras share this code; nothing era-specific (the 1999 server's missile flight is its own, but
  the "hit the environment" words are the same, targetTracker.HIT_ENVIRONMENT).

- **What a kind of creature was seen doing (2026-10-12).** Jake's archer judged Tusker Worshippers (level-V bolts) from a
  world-DB read, and the pair met Dungeon Fern's liches (Frost Bolt II for 40) as if they were drudges. observe now
  adds `seen: casts Frost Bolt II (40), Drain Health Other II; hits up to 6` to every monster of a name, and its target
  line, built only from the server's lines this session (a spell's damage line, "X cast S on you", "… due to X casting
  S on you", "X fails to affect you with S", spell words heard, a blow's damage). Per kind, kept for the session
  (`AgentApi.seenText`). Fellows' fights don't reach your chat (retail shows only your own combat lines), so only what
  hit you counts. Same in all three eras.

- **The Holtburg Dungeon batch (2026-10-13, Arcanist + Bulwark, Dungeon Fern and Holtburg Dungeon 0x01F6).** About a
  third of the session was "where are you?". `ac_follow` stood still (12 s, three times) beside a fellow `walk_to` reached
  at once: a walk took any point within the goal's reach as reached, doorways included, and a follow's reach is 4 m, so
  the doorway 0x01F60224 → 0x0233 two metres off counted as passed and no way round was searched, while a row of
  bookshelves (statics 0x02000183) stands in that doorway; W pushed into the shelves. A doorway (or a door to open) is
  now reached on it (`legWithin`), and a doorway no search gets into is routed round through the others first (it joins
  the walk's `closed` list), before wider searches (tests: the real 0x01F6 cells and statics). Fellows read "out of sight
  (was 0 m away)" crossing 0x01F60289 / 0x027A → 0x0269: the agent hid a creature whose cell isn't in your cell's
  VisibleCells, but those lists aren't even symmetric (ACE PlayerCommands /objsend's note) and ACE keeps sending a
  mover's positions to every player that knows it. A creature the server placed in the last 5 s (`heardAt`, set with
  `ServerObject.serverPlaceAt`) is in view whatever the PVS says; `stay_with` walks on through a fellow beside you
  dropping from view for up to 10 s; `map` and `fellows:` read the same list. The fellows line says `up/down N m`.
  Names: a corpse "Corpse of X" ranks under anything else unless "corpse" is asked for (a cast at "Claude Bulwark" took
  his corpse; with only the corpse here the answer says he isn't in view), remembered places in your landblock come before
  ones elsewhere ("Surface" took Dungeon Fern's exit), and a creature or place whose name the query has words beyond is
  no match ("Holtburg Dungeon Directions", a sign, took the "Holtburg Dungeon" portal; an item named with its material
  still matches). The cast's no-line-of-fire refusal and the archer's clear-line test name the blocker. A cast's reply
  leads with its outcome (fizzle, resist, damage) on the line after the head, before the incantation (a fizzle printed
  last was cut off by `| head`); a bolt with no damage line, no resist and no kill says `no hit seen` and the distance, and
  `repeat` stops after two such bolts running. Point-blank bolts at a Spikey Armoredillo (7 at under 2 m, no damage line,
  00:19:46–00:20:48Z) and at Skeleton Warriors (2026-10-14, 1.5–1.6 m, twice at Door #70145010): not a distance
  limit (see Line of fire: ACE's own physics hits at point blank) but an obstacle between the bodies, a closed door
  above all, which the old line-of-fire sweep could not see that close. It now sweeps the bolt's real path, and a bolt
  that still does nothing names what is in its way ("Door 1.4 m from you is in the bolt's way"). `until_health` takes a fraction or a percent (0.4 was 0.4%). `ac_pick_up` waits on
  while the server's walk to the item keeps moving you (up to 45 s), and a no-answer says how far it is. The blank
  Parchment was blank: weenie 365 has no page data (max 1 page; vendors sell it), so "(it has no writing)" is right. The
  attack's first answer says how far the target is, on which floor, and which fellow you'd be left far from. An attack
  whose swings report nothing at all three heights (a ghost, #80004cf6) ends with `target-lost` instead of cycling
  heights for 120 s (each change had reset the 20 s give-up), and every attack end now raises an event its suggested
  wait hears. `/tell Name text` without a comma is retail's "Use comma after the name for targeted chat." (DoTell
  @ 00577e40); `ac_say` now says how to write it. `*blush*` is not in the end-of-retail ChatPoseTable (0x0E000007), so it
  prints as typed: retail. A `use_on` cut short by your death says so. Checked: 2–3 fizzles of 5 Level III buffs at skill
  110–120 is ACE's (and retail's) sigmoid, SkillCheck.GetMagicSkillChance (factor 0.07, difficulty = Power 100):
  67–80% success before Vitae, about 48% with 10% Vitae on the skill. All three eras share this code (the walk, names,
  casts and attack messages); nothing era-specific.

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
   A doorway into such a floorless cell, when the route's next step is the fall through it, is not a
   waypoint: the walk goes from the doorway before it straight to the fall, and its search finds the edge
   (or the rail) to drop or jump from. The AC1999 tutorial's balcony fence stands in its doorway over the
   training pit, and the walk to that doorway's point never arrived (§0.12 of docs/vtank-parity-gaps.md,
   2026-10-11).
   A fall no drop or jump reaches (a rail higher than your Jump clears: that fence is 2 m, too high below
   Jump 65) is routed round by stairs, ramps and doors. A locked door on the way is unlocked with a key
   from your pack (use the key on the door, then open it); with no key, the walk says where one lies.
   From the landscape it goes in by a doorway the ground reaches (`CellDoor.grounded`): the terrain is at
   the door's feet, or the walkable surfaces outside it (the building's porch, a landblock static's ramp
   or steps, from LandblockInfo) join a step (StepUpHeight) at a time down to the terrain. A door on a
   porch no stair reaches is used only from up on that porch, or when no grounded door gives a route.
   Nanto's scriveners' hall (0xE63D), 2026-10-11: four doors 5 m up, and the way in is 0x0161 at the top
   of the ramp static 0x020002F8. The graph counts the EnvCells LandblockInfo says the landblock has, so
   a streamed cell still in flight leaves it incomplete (rebuilt next time) instead of silently cut short.
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
4. **Attacked, or about to be.** A monster starting to come at you ends an ac_walk_to / ac_follow first (stop_on_aggro;
   see "Monsters coming at you" above), and ac_walk_to keeps clear of monsters near the way (avoid_monsters).
   A hit, miss or evade line aimed at you (the `attacked` event), or health falling below
   half since the walk began, ends the walk at once: `stopped 12.3 m short: you're under attack (…)`.
   Fight, heal or run, then walk again (`attack`'s own run-up fights instead). Crossing a landblock edge
   or stepping out of a doorway goes on; only a teleport (40 m in one tick) ends a walk as "went through a
   portal".
5. **Stuck.** A door the walk opened that stayed shut (locked, or opened only with a key or a quest item,
   like the Holtburg drudge statue's Pedestal Weak Spot) is a wall: the route is planned again round its
   doorway (`RouteOptions.closed`), and it is never tried twice. No way at all: a closed door **on the way** (in a doorway still ahead on the route, or ahead
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
  (`account=` / `server=` for any account; no session needed); `action=export kind=met|nav|utl` hands a profile back
  as a VirindiTank file's text (`out=` also writes it locally; docs/vtank-formats.md §5). `set` validates and refuses an invalid document
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
- **A corpse line can name a corpse that is already gone (2026-10-14).** ACE sends "Your corpse is located at (…)"
  whenever the death dropped anything, but its default `corpse_destroy_pyreals` destroys dropped coins, so a level
  6–10 death that drops only pyreals leaves an empty corpse that rots in about 10 s (Corpse.EmptyDecayTime). The
  agent forgets the line's spot once it has stood within 60 m of it for 5 s with no "Corpse of <you>" there
  (`AgentApi.CORPSE_SIGHT_M` / `CORPSE_ABSENT_GRACE_MS`), so `my-corpse-within` stops sending you back to nothing.
  The same shape for remembered places: one the server deletes while it is in view (a summoned Gateway rotting)
  is forgotten; one released out of range, or dropped by a teleport, is kept.

- Headed Chromium launched by Playwright on macOS gets the real GPU (`ANGLE Metal Renderer: Apple M3 Max`),
  so a watchable window is free; game-session.ts's "headed hangs" note is about its own harness.
