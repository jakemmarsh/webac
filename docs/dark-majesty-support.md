# Dark Majesty (classic) server support

How the client plays the classic, Dark Majesty-era servers, how to run and verify them locally, and what is still open. The evidence and the reasoning behind the design are in [roadmap-era-variants.md](roadmap-era-variants.md) (tier 3a). The task is ERA.dm-support.

## The short version

Every classic server that is actually running uses the **end-of-retail client and protocol** with its own DAT set. Per server, only three things differ, and an **era profile** carries all of them (`packages/renderer/src/era/EraProfiles.ts`):

| Era id | Servers | LoginRequest | Its own DATs | Identified by |
|---|---|---|---|---|
| `eor` (default) | ACE, GDLE | `"1802"`, auth type 2 | none | — |
| `classicace-customdm` | Dekarutide (ClassicACE, CustomDM ruleset) | `"c118"`, auth type 2 | portal, cell, local (highres is end of retail's) | iterations 20044 / 20011 / 20011 |
| `classicace-infiltration` | Doctide (ClassicACE, Infiltration ruleset) | `"i104"`, auth type 2 | portal, cell, local (highres is end of retail's) | iterations 10006 / 10001 / 10002 |
| `classic-dereth` | GDL-Classic on its README's 1.1 set (our local server) | `"1802"`, auth type 1 (`account:password`) | portal, cell | Classic Dereth 1.1 (the hosted set). portal: SkillTable 0x0E000004 is 4928 bytes in Classic Dereth 1.0 or 5064 in 1.1 (end of retail 5876; all report iteration 2072); cell: iteration 4 (identical in 1.0 and 1.1) |
| `classic-dereth-1-0` | Seedsow, Snowreap (same host; GDL family) | as `classic-dereth` | portal, cell | Classic Dereth 1.0, served from the 1.1 set (`datsOf`) with the SkillTable minus Salvaging (`dropSkills: [40]`, `EraBoot.eraPortalOverlay`). 1.0 and 1.1 differ only in that one file, and 1.0's is byte for byte 1.1's without its last entry. |

- The version literal comes from ClassicACE's `DatManager.cs` (`CUSTOMDM_` / `INFILTRATION_CLIENT_VERSION_STRING`), bumped with every DAT release. The classic client exe is the retail one with only that literal patched.
- Seedsow only accepts auth type 1 and drops a LoginRequest that lacks the two trailing dwords. GDL-Classic accepts type 1 too and requires `"1802"`.
- Protocol values stay in `@ac/network` (`LoginProfile.ts`). The profile only selects them.
- **The world list says each world's era with its compat chip** (the bridge's `serverCompat.ts` note, shown in the world details): `Dark Majesty era` (`CLASSIC_ERA_NOTE`) for every classic world whatever its data set, `1999 launch era` (`AC1999_ERA_NOTE`) for AC1999 worlds, and no chip for end of retail. Player terms only: no patch names ("Infiltration") or internal set names. There is no second era-tag mechanism; `tests/verify-launcher-client.ts` holds the rows and chips. AC1999 worlds are listed by the bridge itself, never era-probed ([ac1999-support.md](ac1999-support.md), "In the world list").

## How the client picks the era

One era's DATs per page load (`era/EraBoot.ts`). Every DAT-derived table is built at boot, so a different era means a reload.

1. **Which era a world needs.**
   - **Listed ACE-family servers:** detected live by the bridge (below), sent as `era` in each `GET /servers` row.
   - **The compat overlay** (`services/ws-tcp-bridge/src/serverCompat.ts`) names an era by server id for servers that can't be detected (GDL-Classic: Seedsow, Snowreap) and as the fallback for known ClassicACE worlds (Dekarutide, Unfamiliar Shores) until detection answers. A detection result overrides it.
   - **A bridge pinned to one server:** it reports `BRIDGE_ERA` in `GET /healthz` and in its WebSocket `health` answer.
   - **A Custom… bridge:** the launcher asks over the WebSocket first, because the hosted page's CSP allows `wss:` to any bridge but not an arbitrary `https:` origin. It then falls back to `/healthz`. ENTER waits for the answer.
2. **Boot era**, first match wins: `?era=<id>`, then a pending era switch (sessionStorage, under 2 min old), then end of retail (streamed). The remembered launcher world only preselects its row; it never picks the DATs, so no page load blocks on a classic set (2026-10-06: a returning Doctide visitor had waited on a 1.1 GB download before the world list showed).
3. **ENTER on a world of another era.** The client checks that era's hosted DATs answer, stashes `{era, world, connectUrl, account, password}` in sessionStorage and reloads. The next boot loads that era and logs in without showing the launcher again. The password is in sessionStorage for under a second, only in that tab. If the hosted files don't answer, ENTER says so ("…game data can't be reached right now…") and the launcher stays.
   The reload is the second half of ENTER, not a new launch, so it does not put the connecting/patching splash (gmDataPatchUI, layout 0x21000000) back up (Jake, 2026-10-06: it looked like being bounced back to the start). `PatchScreen.patchBootPlan` decides: resuming a switch boots with no splash, no ranged splash read and no connect-gated meters. The screen stays black, the pre-world letterbox the connecting screen opens on, until that screen comes up. A download that is still running after `QUIET_PATCH_REVEAL_MS` (1 s) shows one line with the patch's own "<n>% of <total>K complete..." text (`QuietPatchProgress`). A cache-served or small set never shows it, and a whole-DAT era still shows its progress. A fatal boot error shows on the same line. Every other boot (no pending switch, a stale one, `?era=`) shows the splash exactly as before. Retail had no in-client era switch, so this is a browser-UX surface.
4. **Where a classic DAT comes from**, first match wins:
   - `config.json` `eraAssetBases[<era>]` + `/<file>`;
   - `<assetBase>/sets/<era>/<file>`.

   The two hosted locations are checked with a HEAD. A `text/html` answer (a dev server's fallback page) does not count. Files an era does not replace load from the end-of-retail URLs, exactly as before. Hosted classic files are cached under their own key namespace (`<era>__client_portal.dat`), because the Classic Dereth portal is byte-for-byte the end-of-retail size.
5. **Streaming** (`config.json` `datSet`) is the end-of-retail set's. A classic era always loads whole DATs.

If a classic era's hosted files don't answer at boot, the client boots end of retail; entering that world tries again.

## Detecting a server's era (2026-10-06)

The multi-server bridge finds each ACE-family server's era itself (`services/ws-tcp-bridge/src/loginProbe.ts`, `eraDetect.ts`), so a new ClassicACE server needs no table entry, only an era profile the client knows.

- **The probe** is one LoginRequest with a random account and an **empty password**. ClassicACE (`AuthenticationHandler.cs` DoLogin) auto-creates accounts only for a non-empty password, and checks the version before "account doesn't exist". So a wrong literal gets the boot " because you are not running the correct executable file version for this server", and the right one gets CharacterError AccountDoesntExist (0x0A). Stock ACE checks `"1802"` before even sending ConnectRequest, with its own wording ("…your client is not the correct version…"). No account is created either way. The verdict arrives in the first fragment after ConnectRequest, so the probe needs no handshake.
- **The order** is end of retail first, then each classic literal (`ERA_LOGIN_LITERALS`, held equal to `ERA_PROFILES` by `tests/verify-bridge-login-probe.ts`). It stops at the first accepted literal, so a stock ACE server costs one login. Results are cached 6 h. Probes run one at a time, 1.5 s apart, after each TreeStats refresh. Servers TreeStats reports offline are skipped, and so are per-IP-limited worlds while the bridge has players on them. `BRIDGE_ERA_PROBE=off` disables it.
- **A server that refuses every known literal** is listed as incompatible ("Unsupported client version"), so players are refused at ENTER instead of being booted.
- **GDL/GDLE servers are not probed.** They have no version check, and an empty password is not known to be safe there.
- **Sweep tool:** `npx tsx tools/probe-login-version.ts --all ws://localhost:<multi bridge>` prints every listed ACE server's answer to each literal. The first sweep (2026-10-06) found Doctide on `i104`. 28 servers run stock ACE on `1802`. Frostcull, ACPrime and Modclaim accept any literal. Nine didn't answer (Dekarutide's DNS is gone).

## Hosted classic sets (2026-10-06)

Players never supply files. Jake, 2026-10-06: "why can't we load the proper DATs just like we do already?" The classic sets are hosted beside end of retail's, and the data-file prompt (and its OPFS import store) is gone.

| Era | Set on R2 (`https://dats.playwebac.com/v1/raw/<set>/`) | Files |
|---|---|---|
| `classicace-infiltration` | `classicace-infiltration-1.9` | portal, cell, local |
| `classicace-customdm` | `classicace-customdm-1.60` | portal, cell, local |
| `classic-dereth` | `classic-dereth-1.1` (also serves `classic-dereth-1-0`: 1.1 only adds the Salvaging skill to 1.0's SkillTable, and that era drops it) | portal, cell |

- **Config:** the web service's `ACJS_ERA_ASSET_BASES` maps each era to its set's URL. The entrypoint accepts only the flat `{"era-id":"https://…"}` shape, writes it to `config.json` `eraAssetBases`, and adds the origins to the CSP `connect-src`. Change it with `bash tools/aws-env.sh set web ACJS_ERA_ASSET_BASES=…`, then `bash tools/deploy-aws.sh --force --only web` so the host re-reads it (docs/aws-hosting.md); a variable change alone restarts nothing.
- **Immutable:** objects carry `Cache-Control: public, max-age=31536000, immutable`, so a new data release gets a new set name (and, for ClassicACE, a new version literal: detection then names the new profile).
- **Uploading** (`tools/upload-era-set-r2.ts`): no standing R2 write key exists (release-plan security posture). `wrangler login` (OAuth), deploy a short-lived Worker bound to the bucket that does R2 multipart uploads (`wrangler r2 object put` stops at 315 MB; a portal is ~930 MB), upload, which checks each file's public size and three 1 MiB ranges byte for byte, then `wrangler delete` the Worker and `wrangler logout`. About 45 s per portal.
- **Cleanup:** the boot deletes any `era-import__<era>__<file>` entries the retired prompt left in the DAT cache (`forgetImportedEraFiles`), up to ~1.2 GB per era.
- **Streaming sets** (2026-10-06): acjs-21 staged each set with `tools/publish-dats-r2.ts --stage-only`; `tools/upload-stream-set-r2.ts --known <eol stage dir> <set dirs…>` uploaded them through the same short-lived Worker. Only 447 / 2,617 / 680 objects (Classic Dereth / CustomDM / Infiltration) are not shared with end of retail; the pointer `v1/sets/<set>.json` is written last, after every sent object and a random 300 shared ones check present. ~5 min for all three. Per-era `datSets` config is acjs-21's (ACJS_ERA_DAT_SETS).

## Shared fix found on the way

**CharacterCreate skill count.** Retail sizes the CharacterCreate skill array as one past the highest skill id in the DAT SkillTable (`CharGenState::CharGenState` @ 005c6a50, `totalNumSkills`). We hardcoded 55, which is the end-of-retail value. ClassicACE's PlayerFactory boots a create whose count does not match its ruleset ("you do not have the correct data files for this server"): CustomDM wants 58, Infiltration 41. `GameUI.chargenTotalNumSkills()` now reads the table. End of retail still sends 55.

## Running the classic servers locally

Both run in Docker beside the ACE stack and never touch its containers or ports.

| | ClassicACE (CustomDM) | GDL-Classic |
|---|---|---|
| Script | `bash tools/classicace/start-classicace.sh` (Infiltration: `CLASSICACE_RULESET=Infiltration …`, containers `classicace-infiltration-*`, UDP 9220-9221) | `bash tools/gdl-classic/start-gdl-classic.sh` |
| Source | github.com/bDekaru/ClassicACE @ 73ae37f (.NET 8) | github.com/bDekaru/ClassicDereth @ 0c05801 (C++, linux/amd64 under emulation) |
| Data | `dat-sets/classicace-customdm-1.60/` (Infiltration: `dat-sets/classicace-infiltration-1.9/`, linked as `dat/sets/classicace-infiltration`) | `dat-sets/classic-dereth-1.1/` (GDL-Classic's README set; Seedsow's 2018 README links 1.0, also kept) |
| World DB | ClassicACE `Database/Base/CustomDM` + the CustomDM world dump .7z (needs `reference/classic/ClassicACE`) | the server's own `Bin/sqldumps` + `Bin/Data` (in the image) |
| UDP | 9200-9201 | 9210-9211 |
| Bridge | `BRIDGE_ERA=classicace-customdm npx tsx services/ws-tcp-bridge/src/bridge.ts 9190 127.0.0.1 9200 9201` | `BRIDGE_ERA=classic-dereth npx tsx services/ws-tcp-bridge/src/bridge.ts 9191 127.0.0.1 9210 9211` |
| Accounts | auto-created; the first account is made Admin | auto-created (`auto_create_accounts=1`) |

**Where the files come from.**
- `dat-sets/` (gitignored) holds the DAT sets: ClassicACE "Data Files - CustomDM 1.60" and "Classic Dereth - Portal and Cell" 1.0 and 1.1. The download links are in the ClassicACE and ClassicDereth READMEs and `roadmap-era-variants.md` §11.
- `reference/classic/` (gitignored) holds the ClassicACE, ClassicDereth, Seedsow and Melt sources.
- For the dev server's hosted path, link the sets under `dat/sets/` (gitignored): `dat/sets/classicace-customdm -> ../../dat-sets/classicace-customdm-1.60` and `dat/sets/classic-dereth -> ../../dat-sets/classic-dereth-1.1` (the set production hosts), `dat/sets/classicace-infiltration -> ../../dat-sets/classicace-infiltration-1.9`.

**Gotchas.**
- ClassicACE reads its console prompt from stdin. Without a TTY the prompt loop spins and flooded the log with 64 MB of `ACE >>` in a minute, so the server container runs with `-dit`.
- MySQL's init phase runs a socket-only server. Wait for `ready for connections ... port: 3306` before starting ClassicACE, or it dies with "Unable to connect to any of the specified MySQL hosts".
- GDL servers drop a client after 30 s without a sequenced packet. Before the Worker connection and retail ~3 s flow keepalive (5255a4b8, `RELEASE.gdle-30s-idle-drop`), a headless client busy loading the world was dropped. It now holds.
- The local ClassicACE config raises `DefaultSessionTimeout` to 300 s. Under heavy machine load (load average 30-50 from parallel sessions), a headless SwiftShader client stalled for more than 60 s while building the world and was dropped for "Network Timeout". Live servers keep 60 s; moving networking off the main thread (the Worker connection) removes the stall.
- **ClassicACE crashes on a ranged first action (a server bug, reproduced twice).** Steps: enter the world, press no movement key, then attack or use something out of reach. The server walks the player there (its motion state becomes non-idle), our AutonomousPosition updates arrive, and ClassicACE's run/walk check (`Player_Tick.cs` ~617-690, which upstream ACE does not have) dereferences `CurrentMoveToState`. That stays null until the client's first MoveToState, so the server dies (`NullReferenceException` in `UpdatePlayerPosition`, process exit). Our client sends MoveToState only from movement input, as retail's CommandInterpreter does, so a retail client doing the same thing would hit it too. The client is left retail-faithful. The fix belongs to ClassicACE: guard the `CurrentMoveToState` uses with a null check. Locally, move before attacking.
  - **Automation primes it (2026-10-11).** The macro's first wield and switch to magic mode after login killed the local CustomDM server the same way (twice, live), and a player starting the macro on a public ClassicACE server would have done the same. Now automation's actions (use, use-with, attack, cast, pick up, drop, give, wield, combat mode) send one standing MoveToState first when the session has sent none (`agentPrimeMoveState` in main.ts, `MovementSync.moveToStatesSent`): the one a teleport arrival sends anyway. A player's own input still goes as retail's does. Verified: the same fresh login and `/vt start` left the server up and the macro killed and looted.

**Era ids are slugs: `[a-z0-9-]`, no dots.** The launcher's directory parser (`worldDirectory.eraIdFrom`), config.json keys and `BRIDGE_ERA` all reject anything else; the first id for this era, `classic-dereth-1.0`, was silently dropped, so Snowreap booted end of retail with all 13 heritages until it became `classic-dereth-1-0` (tests/verify-era-profiles.ts checks every profile id).

**Classic Dereth 1.0 vs 1.1 (2026-10-11).** A GDL server on 1.0 data has no Salvaging (skill 40). Chargen on the 1.1 set trains it for free, so the server's `CClient::CreateCharacter` refuses every create as Corrupt ("The server cannot create your new character at this time"), with no popup. Both sets report the same DDD iterations, so login can't tell them apart: the bridge's compat overlay names the era per server (`serverCompat.ts`). Snowreap is 1.0 (Jake's Sho refused twice; reproduced on local GDL-Classic started with `GDL_CLASSIC_DAT_DIR=dat-sets/classic-dereth-1.0`, and fixed with `?era=classic-dereth-1-0`). **Seedsow is 1.0 too (2026-10-12).** On launch day every webAC create on Seedsow got CharGenVerificationResponse 5. That is `CG_VERIFICATION_RESPONSE_CORRUPT` (the enum starts at `UNDEF = 0`, so OK = 1 … CORRUPT = 5, DATABASE_DOWN = 6; `PhatSDK/GameEnums.h`), not DATABASE_DOWN, so the DB insert never ran: the skill check refused it. `tools/probe-gdl-chargen.ts` (our real `buildCharacterCreate` and chargen defaults, no browser, through wss://bridge.playwebac.com, one throwaway account) sent two creates minutes apart: the 1.1 array (41 skills, Salvaging trained) got 5, the same create on the 1.0 table (40 skills) got 1 (Ok). Snowreap answered the same pair the same way. The bridge now maps Seedsow to `classic-dereth-1-0`. The 2026-10-06 "Seedsow accepted a 1.1 create" note was wrong: that run imported the 1.0 files the server's 2018 README linked (the hosted 1.1 set came later). The server's banner ("GDLE - Classic Dereth 1.34") names its code, not its data. A new GDL world needs a test create to tell which set it runs: `npx tsx tools/probe-gdl-chargen.ts --server <id> --account <throwaway> --password <pw>` (variants `full` = 1.1, `no40` = 1.0; at most one character is made). Test: `tests/verify-gdl-chargen-data-set.ts` replays both live payloads.

## Verifying

- **Unit:** `tests/verify-era-profiles.ts` covers profiles, identification against the real DAT sets, boot era, the stashed switch, hosted DAT sources, the cleanup of old imports, the bridge era, and the skill count. `tests/verify-era-login-profile.ts` decodes the LoginRequest bytes as each server's source does. `tests/verify-launcher-client.ts` and `tests/verify-launcher-server-directory.ts` cover worlds and their eras. `tests/verify-dat-cache.ts` covers the namespaced keys.
- **Live, URL login:** `GDLE_BASE=http://localhost:3010/ GDLE_BRIDGE=ws://localhost:9190 PROBE_QUERY=era=classicace-customdm CONSOLE_LOG=/tmp/c.log npx tsx tools/gdle/probe-flow.ts <acct> <pw> <outdir> login create:<Name> enter world`.
- **Live, launcher:** `npx tsx tools/probe-era-switch.ts --base http://localhost:3010/ --bridge ws://localhost:9190 --account <a> --password <p> --out <dir> [--world <server id>] [--revisit] [--then-custom ws://localhost:9090]`. It fails if ENTER shows a data-files prompt, and `--revisit` checks the reload boots end of retail with the world preselected.
- **Production, no server contact:** `npx tsx tools/probe-era-prod-smoke.ts [--era classic-dereth]` checks the world is listed and that `?era=<id>` boots that era from the hosted sets. It uses a persistent Chromium profile: an incognito context keeps OPFS in memory and threw QuotaExceededError at ~2.2 GB, below the reported quota.

## Status (2026-10-06)

Verified live:
- ClassicACE CustomDM: login (`c118`), DDD, character creation (58 skills), entering the world at Holtburg, movement, chat, inventory, and the character panel showing CustomDM's own skills (Armor, Shield, Axe and Mace). Melee combat works: "You graze Cow for 1 point of bludgeoning damage!", the kill, and CustomDM's "You've earned 23 experience! T: 100% A: 100% R: 100%".
- CustomDM content read from the DATs follows the era with no code: CharGen lists 3 heritages (CustomDM blanks the other ten's names), and the town map is CustomDM's own art with its island labelled "Other". The summary's "Starting Town" uses the exe's own `pcTown` literals, as the CustomDM exe does. CustomDM's KeyMaps/ActionMap are byte-identical to end of retail's (as are Classic Dereth's), and its attack/defense skill sets equal ours.
- GDL-Classic: login with auth type 1, the byte-exact DDD compare, character creation, entering the world. With the Worker connection and retail ~3 s keepalive (5255a4b8), a full session holds: move, chat, inventory, the character panel, 60 s idle, logout and re-login. 97 Classic Dereth objects were around Holtburg (Drudge Skulkers, Mite Scions, Young Banderlings).
- The launcher era switch both ways and a Custom… classic bridge whose era is read over the WebSocket.
- GDL-Classic on its own 1.1 set.
- Hosted sets, no prompt (2026-10-06): against a local Infiltration ClassicACE, ENTER reloaded into Infiltration with no data-files prompt, and a revisit booted end of retail with the world preselected (`probe-era-switch --revisit`).
- End of retail unchanged: ACE login, character creation with 55 skills, entering the world.
- ClassicACE Infiltration (local `CLASSICACE_RULESET=Infiltration` server, 2026-10-06): a multi bridge with no era configured detected `i104` itself; the launcher reloaded into the Infiltration DATs, logged in, created a character (41 skills), entered Holtburg, moved, chatted, opened inventory and the character panel (XP for next level 1,000 from Infiltration's XpTable).
- Live detection against every listed ACE server (see "Detecting a server's era").
- **Live Seedsow through playwebac.com (2026-10-06):** imported the files (1.0, see "Seedsow is 1.0 too" above), reloaded into Classic Dereth, logged in to the real server (auth type 1), created a character, entered Holtburg, and the server moved it (95 objects around: Drudge Skulkers, Mite Scions, Young Banderlings). Test account `acjswebprobe`, character `Acjsprobe`. Seedsow's login banner reads "GDLE - Classic Dereth 1.34, Jan 2 2026", i.e. current GDL-Classic, whose README calls for the **1.1** files; both 1.0 and 1.1 logged in, because DDD compares only iteration records. **Host 1.1.** Probe: `tools/probe-era-switch.ts --base 'https://playwebac.com/?debug&' --bridge wss://bridge.playwebac.com --world <Servers.xml id> --import <dat dir> --create <Name>` (as run then; since 2026-10-11 the deployed page ignores `?debug`, so `--create` needs a local `VITE_ACJS_URL_OVERRIDES=1` preview build as `--base`).
- **Production, playwebac.com (2026-10-06):** the bridge lists Seedsow and Snowreap and Doctide (beta) with the chip "Dark Majesty era" (one label for every classic data set since 2026-10-06; "Infiltration" was a Feb 2005 patch name players don't know). The classic sets are hosted, so ENTER loads them with no prompt; `npx tsx tools/probe-era-prod-smoke.ts` checks a classic boot from the hosted sets without contacting the server.

Open:
- **Live Dekarutide / Doctide.** Seedsow is played (above). Snowreap's create failure was found by Jake playing it (2026-10-11) and fixed with the `classic-dereth-1-0` era; on 2026-10-12 both Seedsow and Snowreap accepted a live 1.0 create from `tools/probe-gdl-chargen.ts` (throwaway accounts, which Jake OK'd for third-party servers on 2026-10-11). Still unverified live: Doctide (41 skills, Infiltration 1.9), Unfamiliar Shores (offline; which CustomDM release), Dekarutide (offline). Mark a server `ok` instead of `beta` in `serverCompat.ts` only after someone plays it end to end.
- The weenie JSON side-files (combat style, attack type and weapon speed per weenie class id, plus wielded-item meshes) come from the end-of-retail world DB. Original-content class ids are the same on classic servers, a miss falls back to defaults (animation only, never stats), and per-server exports would need each operator's world DB.
