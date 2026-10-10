/**
 * probe-first-hour — a brand-new player's first hour, end to end
 * (HARNESS.fresh-character-playthrough; scorecard flow-first-hour).
 *
 * Follows docs/first-hour-academy.md with a fresh non-admin character:
 *   account  a new auto-created account, lowered to accessLevel 0 before the
 *            character exists (an admin account's character is "+Name")
 *   spawn    Holtburg Training Academy 0x8602, Calling Stone in the pack
 *   0 give   Calling Stone → Society Greeter
 *   2 kill   Sparring Golem → Academy Token → Training Master (1,000 XP, L2)
 *   3 portal Central Courtyard
 *   4 kill   Carpenter Wasps until a Wing (30%) → Academy Foreman (2,000 XP, L3)
 *   5 kill   Thieving Thrungus until Bellows (30%) → Academy Blacksmith (3,000 XP, L4)
 *   6 portal Outer Courtyard (upstairs)
 *   7 kill   Adolescent Olthoi → Protection Orb → Sentry (5,000 XP, L5)
 *   8 portal Exit to Holtburg
 *   9 death  /die: death notice, respawn at Sanctuary, vitae
 * Movement is the server's: Use on an NPC / door / portal walks the player
 * there (MoveToObject), as a click does in retail. Use, give, pick-up and attack
 * go through acDebug's real GameAction senders; the world-drag gestures for
 * give are covered separately (probe-world-drag-paperdoll).
 *
 * Every step records pass/fail + chat evidence and a screenshot under
 * verification/first-hour/<run>/; the run stops at the first blocking failure
 * (later steps depend on earlier ones) and writes results.json.
 *
 * Usage: npx tsx tools/probe-first-hour.ts   (run under tools/with-gpu-lock.sh)
 *   AC_FIRST_HOUR_ACCOUNT  reuse this account instead of a new one
 *   AC_FIRST_HOUR_ONLY=death  skip the academy and run only the first-death check
 *   AC_FIRST_HOUR_ONLY=stairs with an admin AC_FIRST_HOUR_ACCOUNT: @teleloc to the
 *            Academy Blacksmith, @ci the Academy Library Key his turn-in gives, and run
 *            only the walks up to the Outer Courtyard portal and on to the exit portal
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.ts';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.ts';
import { type CellGraph, type RoutePoint, type Vec3, findRoute, loadCellGraph, onLevel, yawToward } from './lib/cell-path.ts';
import { AT_CHAR_SELECT_JS, IN_CHARGEN_JS, REPO, adminCommand, enterWorld, gameUrl, openSession, shot, teleloc, waitFor } from './lib/game-session.ts';
import { chatLines, waitChat } from './lib/two-client.ts';

const RUN = (process.env.AC_PROBE_RUN ?? String(process.pid)).slice(-5);
/** Character names are letters only: map the run's digits onto letters. */
const LETTERS = RUN.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const ACCOUNT = process.env.AC_FIRST_HOUR_ACCOUNT ?? `fresh${RUN}`;
const CHAR = `Fresh ${LETTERS[0].toUpperCase()}${LETTERS.slice(1)}`;
const OUT = `verification/first-hour/${RUN}`;

interface Step { step: string; ok: boolean; detail: string; ms: number }
const steps: Step[] = [];
let page: Page;

class Blocked extends Error {}

async function step(name: string, fn: () => Promise<string>, blocking = true): Promise<void> {
  const t0 = Date.now();
  let ok = true, detail = '';
  try { await dismissPopups(); detail = await fn(); } catch (e) { ok = false; detail = e instanceof Error ? e.message : String(e); }
  steps.push({ step: name, ok, detail, ms: Date.now() - t0 });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${Math.round((Date.now() - t0) / 1000)} s): ${detail}`);
  await shot(page, `${OUT}/${String(steps.length).padStart(2, '0')}-${name}.png`).catch(() => {});
  if (!ok && blocking) throw new Blocked(name);
}

/** The ACE database: the Docker container on Jake's Mac, a local MariaDB in the cloud stack (provision-ace-stack.sh). */
function mysql(sql: string): string {
  const opts = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
  try {
    return execFileSync('docker', ['exec', 'ace-db', 'mysql', '-uroot', '-p1999asheron2017', '-N', '-e', sql], opts).trim();
  } catch {
    return execFileSync('mysql', ['-N', '-e', sql], opts).trim();
  }
}

// ── page reads ───────────────────────────────────────────────────────────
/** door: ObjectDescriptionFlag.Door (0x1000), whatever the door is called ("Academy Library"). */
interface Obj { guid: number; name: string; dist: number | null; door?: boolean }
/**
 * Every server object with its distance from the player. Distances use ACE
 * positions: the player's last sent frame vs each object's position, both
 * landblock-local (cell id + origin), shifted by 192 m per landblock step, so
 * indoor cells compare correctly. Objects with no position get dist null.
 */
async function objects(): Promise<Obj[]> {
  return page.evaluate(`(() => { const me = window.acDebug.collisionState().serverFrame; const out = [];
    const lb = (c) => [((c >>> 24) & 255) * 192, ((c >>> 16) & 255) * 192];
    for (const [guid, o] of window.__ac.serverObjectManager.getAllObjects()) {
      const p = o.position; let d = null;
      if (me && p && p.landblock !== undefined) {
        const [mx, my] = lb(me.cellId), [ox, oy] = lb(p.landblock >>> 0);
        d = Math.hypot(ox + p.x - (mx + me.x), oy + p.y - (my + me.y), p.z - me.z);
      }
      out.push({ guid, name: o.name, dist: Number.isFinite(d) ? d : null, door: ((o.objectDescFlags ?? 0) & 0x1000) !== 0 });
    }
    return out.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9)); })()`) as Promise<Obj[]>;
}
const exists = (guid: number): Promise<boolean> => page.evaluate(`!!window.__ac.serverObjectManager.getObject(${guid})`) as Promise<boolean>;
/** Guids of everything carried (pack + wielded), so world lookups skip them. */
const carriedGuids = (): Promise<number[]> => page.evaluate(`(() => { const ps = window.__ac.playerState;
  return [...ps.inventory.getAll().map((i) => i.id), ...ps.equipment.getAll().map((i) => i.id)]; })()`) as Promise<number[]>;
/** The nearest world object called `name` (objects with no known position sort last). */
async function nearest(name: string): Promise<Obj> {
  const mine = new Set(await carriedGuids());
  const o = (await objects()).find((x) => x.name === name && !mine.has(x.guid));
  if (!o) {
    const names = [...new Set((await objects()).filter((x) => !mine.has(x.guid)).map((x) => x.name))].slice(0, 40);
    throw new Error(`no "${name}" in view; nearby: ${JSON.stringify(names)}`);
  }
  return o;
}
/** Click OK / Yes on any popup the server raised, as a player would. */
async function dismissPopups(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const at = await page.evaluate(`(() => { const b = [...document.querySelectorAll('.ac-dialog-button')].find((e) => e.getBoundingClientRect().width > 0);
      if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number } | null;
    if (!at) return;
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(600);
  }
}

/** A carried item by name (the pack lives in playerState.inventory, not in the world object list). */
async function carried(name: string): Promise<Obj | undefined> {
  const hit = await page.evaluate(`(() => { const i = window.__ac.playerState.inventory.getAll().find((x) => x.name === ${JSON.stringify(name)});
    return i ? { guid: i.id, name: i.name, dist: null } : null; })()`) as Obj | null;
  return hit ?? undefined;
}
/** Poll for a carried item (the pack streams in after login, loot after a pick-up). */
async function waitCarried(name: string, ms = 15_000): Promise<Obj | undefined> {
  for (let t = 0; t <= ms; t += 500) {
    const o = await carried(name);
    if (o) return o;
    await page.waitForTimeout(500);
  }
  return undefined;
}
/** The player's current cell (0xXXYYCCCC): the last AutonomousPosition the client sent. */
const cell = (): Promise<number> => page.evaluate('window.acDebug.collisionState().cellId >>> 0') as Promise<number>;
/**
 * Chat since a mark. The chat log is capped, so a row count stops moving once
 * it is full; instead a mark tags every row present (data-probe-mark) and
 * chatSince returns the rows that came after, i.e. those without the tag.
 */
let markSeq = 0;
async function chatMark(): Promise<number> {
  const m = ++markSeq;
  await page.evaluate(`(() => { const c = document.getElementById('chat-messages');
    if (c) for (const e of c.children) if (!e.dataset.probeMark) e.dataset.probeMark = '${m}'; })()`);
  return m;
}
async function chatSince(mark: number): Promise<string[]> {
  return page.evaluate(`(() => { const c = document.getElementById('chat-messages'); if (!c) return [];
    return [...c.children].filter((e) => !e.dataset.probeMark || Number(e.dataset.probeMark) > ${mark})
      .map((e) => ((e.dataset && e.dataset.chatText) || e.textContent || '').trim()); })()`) as Promise<string[]>;
}
async function waitNewChat(mark: number, re: RegExp, ms: number): Promise<string | null> {
  for (let t = 0; t <= ms; t += 500) {
    const hit = (await chatSince(mark)).find((l) => re.test(l));
    if (hit) return hit;
    await page.waitForTimeout(500);
  }
  return null;
}

async function use(name: string, settleMs = 6000): Promise<Obj> {
  const o = await nearest(name);
  await page.evaluate(`window.acDebug.useObject(${o.guid})`);
  await page.waitForTimeout(settleMs);
  return o;
}

// ── walking: routes through the landblock's cells (HARNESS.first-hour-stairs) ──
const graphs = new Map<number, CellGraph>();
let dats: { cell: DatDatabase; portal: DatDatabase } | null = null;
function cellGraph(cellId: number): CellGraph {
  const lb = (cellId & 0xFFFF0000) >>> 0;
  let g = graphs.get(lb);
  if (!g) {
    dats ??= { cell: new DatDatabase(new FileDatBytes(`${REPO}/dat/client_cell_1.dat`)), portal: new DatDatabase(new FileDatBytes(`${REPO}/dat/client_portal.dat`)) };
    g = loadCellGraph(dats.cell, dats.portal, lb);
    graphs.set(lb, g);
  }
  return g;
}
interface Where { cell: number; x: number; y: number; z: number }
/** The player now, in the AC frame of its cell's landblock (collisionState is Three: X = AC x, Z = AC y, Y = height). */
async function me(): Promise<Where> {
  const c = await page.evaluate('(() => { const c = window.acDebug.collisionState(); return { cell: c.cellId >>> 0, x: c.x, z: c.z, y: c.feetY ?? c.y }; })()') as { cell: number; x: number; z: number; y: number };
  return { cell: c.cell, x: c.x - ((c.cell >>> 24) & 255) * 192, y: c.z - ((c.cell >>> 16) & 255) * 192, z: c.y };
}
/** A server object's cell and landblock-frame origin, or null when it has no position. */
async function whereIs(guid: number): Promise<Where | null> {
  return page.evaluate(`(() => { const o = window.__ac.serverObjectManager.getObject(${guid}); const p = o && o.position;
    return p && p.landblock ? { cell: p.landblock >>> 0, x: p.x, y: p.y, z: p.z } : null; })()`) as Promise<Where | null>;
}
/**
 * Run along `route` (landblock-frame points) as a player holding W does,
 * turning toward each point in turn. A leg with no progress for 4 s opens
 * the door in the way (or backs off a step) and retries; the fourth stall
 * fails the walk. It ends early on entering `stopInCell`, or when a portal
 * moves the player (a jump of more than 8 m between polls).
 */
/** A walk reached a doorway's plan position on the wrong floor: `drop` is the floor portal to route around. */
class WrongLevel extends Error { constructor(msg: string, readonly drop: Vec3) { super(msg); } }

async function walkRoute(route: RoutePoint[], tag: string, stopInCell = 0): Promise<boolean> {
  await page.keyboard.down('KeyW');
  try {
    for (const [i, wp] of route.entries()) {
      const last = i === route.length - 1;
      let bestD = Infinity, bestAt = Date.now(), stalls = 0;
      for (;;) {
        // A portal on the way took us (the Outer Courtyard one is walked into): the route is done.
        if (await teleporting()) return true;
        const p = await me();
        if (stopInCell && p.cell === stopInCell) return false;
        const d = Math.hypot(wp.x - p.x, wp.y - p.y);
        if (d < (last ? 0.6 : 1.0)) {
          if (!last && !onLevel(wp, p.z)) {
            // Over the doorway in plan but a floor above or below it: the last floor
            // portal we "crossed" was a stairwell opening (a drop), not a stair. That
            // may be this waypoint itself: walking onto an open floor portal falls
            // through it, as in retail (the academy's stair shafts).
            const msg = `${tag}: at waypoint ${i + 1}/${route.length} on the wrong level (z ${p.z.toFixed(1)} vs doorway ${wp.z.toFixed(1)}) in 0x${p.cell.toString(16)}`;
            const drop = route.slice(0, i + 1).reverse().find((q) => q.floor);
            if (drop) throw new WrongLevel(msg, drop);
            // No floor portal behind us: the stair cells join by wall doorways, so the client did not carry us up or down the ramp.
            throw new Error(`${msg} — the client did not follow the stair (BUG.academy-stairs-fall-through)`);
          }
          if (process.env.AC_FIRST_HOUR_DEBUG) console.log(`  ${tag}: waypoint ${i + 1}/${route.length} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) 0x${p.cell.toString(16)}`);
          break;
        }
        await page.evaluate(`window.acDebug.setPlayerYaw(${yawToward(p, wp)})`);
        if (d < bestD - 0.25) { bestD = d; bestAt = Date.now(); } else if (Date.now() - bestAt > 4000) {
          if (++stalls > 3) throw new Error(`${tag}: stuck ${d.toFixed(1)} m short of waypoint ${i + 1}/${route.length} (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}, ${wp.z.toFixed(1)}) in cell 0x${p.cell.toString(16)} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
          await page.keyboard.up('KeyW');
          // A closed door in the way: Use it, as a player clicks it open.
          // Not one we opened just now: a second Use closes it again.
          const door = (await objects()).find((o) => o.door && o.dist !== null && o.dist < 4 && Date.now() - (doorsOpened.get(o.guid) ?? 0) > 10_000);
          if (door) {
            // A locked one (the Academy Library) takes the key the Blacksmith gave: Use the key
            // on the door to unlock it (ACE Lock.cs UseUnlocker), then Use the door to open it.
            const key = await page.evaluate('(() => { const k = window.__ac.playerState.inventory.getAll().find((i) => / Key$/.test(i.name)); return k ? k.id : 0; })()') as number;
            console.log(`  ${tag}: opening ${door.name} 0x${door.guid.toString(16)} at ${door.dist!.toFixed(1)} m${key ? ` (key 0x${key.toString(16)} first)` : ''}`);
            if (key) { await page.evaluate(`window.acDebug.useWithTarget(${key}, ${door.guid})`); await page.waitForTimeout(2500); }
            await page.evaluate(`window.acDebug.useObject(${door.guid})`);
            doorsOpened.set(door.guid, Date.now());
            await page.waitForTimeout(3000);
          } else {
            if (process.env.AC_FIRST_HOUR_DEBUG) console.log(`  ${tag}: stalled at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) 0x${p.cell.toString(16)}; near: ${JSON.stringify((await objects()).slice(0, 8).map((o) => `${o.name} ${o.dist?.toFixed(1)}`))}`);
            // No door: a static object (the Academy's Life Stone beside the
            // 0x86020134 doorway, run 2026-10-05) stands on the cell route.
            // Back off, then sidestep round it, one side and then the other,
            // as a player would (Z / C, retail's Sidestep Left / Right).
            const dodge = stalls === 1 ? 'KeyS' : stalls === 2 ? 'KeyZ' : 'KeyC';
            await page.keyboard.down(dodge); await page.waitForTimeout(stalls === 3 ? 1800 : 900); await page.keyboard.up(dodge);
          }
          await page.keyboard.down('KeyW');
          bestD = Infinity; bestAt = Date.now();
        }
        await page.waitForTimeout(100);
      }
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
  return false;
}
const doorsOpened = new Map<number, number>();
/** The client's teleport-in-progress flag (portal space): set from TeleportInProgress until the destination is in. */
const teleporting = (): Promise<boolean> => page.evaluate('!!window.acDebug.cursorState().teleport') as Promise<boolean>;
/**
 * Walk through the cells into the cell of server object `guid`, when that is
 * another cell than ours; the Use or attack that follows closes the rest in
 * a straight line (its own body would stop a walk onto its origin). Returns the waypoint count.
 */
async function walkToObject(guid: number, tag: string): Promise<number> {
  const o = await whereIs(guid);
  return o ? (await walkTo(o, tag, true)).waypoints : 0;
}
/**
 * Where the world DB places weenie `wcid` in the player's landblock. The
 * server only sends objects in cells the player can see, so a target on
 * another floor (the Outer Courtyard portal) is placed from landblock_instance.
 */
async function instanceAt(wcid: number): Promise<Where> {
  const lb = (await cell()) >>> 16;
  const row = mysql(`SELECT obj_Cell_Id, origin_X, origin_Y, origin_Z FROM ace_world.landblock_instance WHERE weenie_Class_Id = ${wcid} AND (obj_Cell_Id >> 16) = ${lb} LIMIT 1`);
  if (!row) throw new Error(`no instance of wcid ${wcid} in landblock 0x${lb.toString(16)}`);
  const [c, x, y, z] = row.split('\t').map(Number);
  return { cell: c >>> 0, x, y, z };
}
/** After walking onto a portal: true once it has taken us (teleport flag seen, now or during the walk), then wait out portal space. */
async function portalled(walked: { teleported: boolean }): Promise<boolean> {
  let seen = walked.teleported;
  for (let t = 0; t <= 15_000 && !seen; t += 250) {
    seen = await teleporting();
    if (!seen) await page.waitForTimeout(250);
  }
  if (!seen) return false;
  for (let t = 0; t <= 60_000 && (await teleporting()); t += 500) await page.waitForTimeout(500);
  await page.waitForTimeout(5000); // the destination streams in
  return true;
}
/** Walk through the cells to `o` (cell + landblock-frame origin) when it is in another cell of our landblock; `intoCell` stops on entering its cell. */
async function walkTo(o: Where, tag: string, intoCell = false): Promise<{ waypoints: number; teleported: boolean }> {
  const p = await me();
  if (!p.cell || p.cell === o.cell || (p.cell & 0xFFFF) < 0x100 || (p.cell >>> 16) !== (o.cell >>> 16)) return { waypoints: 0, teleported: false };
  // Re-plan from where we stand whenever a floor portal turns out to be a drop.
  const avoid: Vec3[] = [];
  let walked = 0;
  for (;;) {
    const q = await me();
    const route = findRoute(cellGraph(q.cell), q.cell, q, o.cell, o, avoid);
    if (!route) throw new Error(`${tag}: no cell route from 0x${q.cell.toString(16)} to 0x${o.cell.toString(16)}${avoid.length ? ` avoiding ${avoid.length} drop(s)` : ''}`);
    console.log(`  ${tag}: ${route.length} waypoints 0x${q.cell.toString(16)} → 0x${o.cell.toString(16)}`);
    walked += route.length;
    try {
      const teleported = await walkRoute(route, tag, intoCell ? o.cell : 0);
      return { waypoints: walked, teleported };
    } catch (e) {
      if (!(e instanceof WrongLevel) || avoid.length >= 3) throw e;
      console.log(`  ${e.message}; re-planning around the floor portal at (${e.drop.x.toFixed(1)}, ${e.drop.y.toFixed(1)}, ${e.drop.z.toFixed(1)})`);
      avoid.push(e.drop);
    }
  }
}

async function give(itemName: string, npcName: string, expect: RegExp): Promise<string> {
  const item = await waitCarried(itemName, 5000);
  if (!item) throw new Error(`"${itemName}" not in the pack (carrying ${JSON.stringify(await page.evaluate('window.__ac.playerState.inventory.getAll().map((i) => i.name)'))})`);
  const npc = await nearest(npcName);
  const mark = await chatMark();
  await page.evaluate(`window.acDebug.useObject(${npc.guid})`); // walk over first
  await page.waitForTimeout(5000);
  // An NPC mid-emote refuses: "<npc> is too busy to accept gifts right now." A player waits and tries again.
  let hit: string | null = null;
  for (let tries = 0; tries < 6 && !hit; tries++) {
    const m = await chatMark();
    await page.evaluate(`window.acDebug.giveObjectRequest(${npc.guid}, ${item.guid}, 1)`);
    hit = await waitNewChat(mark, expect, 6000);
    if (!hit && (await chatSince(m)).some((l) => /too busy to accept/i.test(l))) await page.waitForTimeout(4000);
    else if (!hit) break;
  }
  if (!hit) hit = await waitNewChat(mark, expect, 10_000);
  if (!hit) throw new Error(`no ${expect} after giving ${itemName}; chat: ${JSON.stringify((await chatSince(mark)).slice(-5))}`);
  return hit;
}

/** Kill the nearest `creature`, open its corpse and take `loot` if it dropped. */
async function killAndLoot(creature: string, loot: string): Promise<boolean> {
  const corpseName = `Corpse of ${creature}`;
  const oldCorpses = new Set((await objects()).filter((x) => x.name === corpseName).map((x) => x.guid));
  // Nearest first; a candidate we cannot reach (another room, through a wall)
  // takes no swing in 20 s, so move on to the next one, as a player would.
  const candidates = (await objects()).filter((x) => x.name === creature).slice(0, 4);
  if (candidates.length === 0) throw new Error(`no "${creature}" in view`);
  let killed = false;
  for (const c of candidates) {
    const mark = await chatMark();
    const t0 = Date.now();
    console.log(`  attacking ${creature} 0x${c.guid.toString(16)} at ${c.dist === null ? '?' : c.dist.toFixed(1)} m`);
    // Straight-line MoveTo misses creatures behind a corner or upstairs: walk the cells first.
    await walkToObject(c.guid, creature).catch((e) => console.log(`  ${String(e)}`));
    let chased = Date.now();
    while (await exists(c.guid)) {
      const swung = (await chatSince(mark)).some((l) => l.includes(creature));
      if (!swung && Date.now() - t0 > 20_000) break;
      // A thief that keeps running (live 2026-10-04: a thrungus outlasted 90 s of swings): try the next one.
      if (Date.now() - t0 > 90_000) { console.log(`  ${creature} 0x${c.guid.toString(16)} still alive after 90 s; next`); break; }
      // Fled into another room: follow it through the cells, as a player would.
      if (Date.now() - chased > 15_000) { chased = Date.now(); await walkToObject(c.guid, creature).catch((e) => console.log(`  ${String(e)}`)); }
      await page.evaluate(`window.acDebug.attack(${c.guid})`);
      await page.waitForTimeout(2500);
    }
    if (!(await exists(c.guid))) { killed = true; break; }
  }
  if (!killed) throw new Error(`could not reach any of ${candidates.length} ${creature}s`);
  // The corpse arrives as a CreateObject shortly after the kill.
  let corpse: Obj | null = null;
  for (let t = 0; t <= 10_000 && !corpse; t += 500) {
    corpse = (await objects()).find((x) => x.name === corpseName && !oldCorpses.has(x.guid)) ?? null;
    if (!corpse) await page.waitForTimeout(500);
  }
  if (!corpse) throw new Error(`no corpse of ${creature}`);
  // Leave combat first, as a player does before looting: a Use while an
  // attack is still in flight is refused.
  await page.evaluate("window.acDebug.combatMode('peace')");
  await page.waitForTimeout(2500);
  // Open it once (a second Use on an open container closes it) and read the
  // contents from the client's own ViewContents report.
  const hex = corpse.guid.toString(16);
  const contents = new Promise<number[]>((resolve) => {
    const on = (m: { text(): string }) => {
      const t = m.text();
      const hit = new RegExp(`ViewContents: container=0x${hex} \\d+ items: \\[([^\\]]*)\\]`).exec(t);
      if (hit) { page.off('console', on); resolve(hit[1].split(',').map((g) => parseInt(g, 16)).filter((g) => g > 0)); }
    };
    page.on('console', on);
    setTimeout(() => { page.off('console', on); resolve([]); }, 12_000);
  });
  const dump: string[] = [];
  const all = (m: { text(): string }) => dump.push(m.text().slice(0, 200));
  if (process.env.AC_FIRST_HOUR_DEBUG) page.on('console', all);
  await page.evaluate(`window.acDebug.useObject(${corpse.guid})`);
  const guids = await contents;
  if (process.env.AC_FIRST_HOUR_DEBUG) { page.off('console', all); console.log(`  console around corpse 0x${hex} use:\n    ${dump.join('\n    ')}`); }
  if (guids.length === 0) { console.log(`  corpse 0x${hex} opened with nothing (or never opened)`); return false; }
  const me = await page.evaluate('window.__ac.charGuid') as number;
  for (const g of guids) {
    await page.evaluate(`window.acDebug.putInPack(${g}, ${me})`);
    await page.waitForTimeout(1500);
  }
  const got = !!(await waitCarried(loot, 8000));
  if (!got) {
    const inv = await page.evaluate('window.__ac.playerState.inventory.getAll().map((i) => i.name + " 0x" + (i.id >>> 0).toString(16))');
    console.log(`  picked up ${guids.map((g) => '0x' + g.toString(16)).join(',')} but no "${loot}" carried; pack: ${JSON.stringify(inv)}; chat: ${JSON.stringify((await chatLines(page)).slice(-4))}`);
  }
  return got;
}

async function farm(creature: string, loot: string, tries: number): Promise<string> {
  let waits = 0;
  for (let i = 1; i <= tries; i++) {
    try {
      if (await killAndLoot(creature, loot)) return `${loot} after ${i} kill(s)`;
    } catch (e) {
      // None in reach (earlier runs or players cleared them): wait for the generator to respawn.
      if (!/could not reach|no "/.test(String(e)) || ++waits > 4) throw e;
      i--;
      await page.waitForTimeout(20_000);
    }
  }
  throw new Error(`no ${loot} after ${tries} ${creature} kills`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  console.log(`run ${RUN}: account ${ACCOUNT}, character "${CHAR}"`);
  const url = (autoenter: boolean) => gameUrl({ autoenter, cb: `first-hour-${RUN}`, env: { ...process.env, AC_ACCOUNT: ACCOUNT, AC_PASSWORD: ACCOUNT } });

  // Account: first login auto-creates it (accessLevel 5); lower it before the character exists.
  if (!process.env.AC_FIRST_HOUR_ACCOUNT) {
    // A new account has no characters, so the client lands on character
    // creation, not select: either screen means the login (and the account) exists.
    const { browser, page: p } = await openSession();
    await p.goto(url(false), { waitUntil: 'domcontentloaded' });
    const ok = await waitFor(p, `(${AT_CHAR_SELECT_JS}) || (${IN_CHARGEN_JS})`, { timeoutMs: 120_000 } as never);
    await browser.close();
    if (!ok) throw new Error(`account ${ACCOUNT}: never reached character select or creation`);
    mysql(`UPDATE ace_auth.account SET accessLevel = 0 WHERE accountName = '${ACCOUNT}'`);
    const lvl = mysql(`SELECT accessLevel FROM ace_auth.account WHERE accountName = '${ACCOUNT}'`);
    if (lvl !== '0') throw new Error(`account ${ACCOUNT} accessLevel is ${JSON.stringify(lvl)}, not 0`);
  }
  const s = await enterWorld({ url: url(true), createCharacter: CHAR, settleMs: 8000, consoleFilter: /Use refused|Use suppressed|ViewContents|refus|PutItem|InventoryPut|Put \(|pickup|Pickup|WeenieError|inventory request/i } as never);
  page = s.page;
  try {
    if (process.env.AC_FIRST_HOUR_ONLY === 'death') throw new Blocked('skipped to the death check');
    const onlyStairs = process.env.AC_FIRST_HOUR_ONLY === 'stairs';
    if (onlyStairs) {
      await teleloc(page, '0x860201F6 [37.88 -89.22 0.005] 1 0 0 0', 15_000); // the Academy Blacksmith's forge
      if (!(await carried('Academy Library Key'))) await adminCommand(page, '@ci 30999'); // the key his turn-in gives
      await waitCarried('Academy Library Key', 8000);
    }
    if (!onlyStairs) {
      await step('spawn', async () => {
        const name = await page.evaluate('window.__ac.playerState.name') as string;
        const c = await cell();
        const stone = await waitCarried('Calling Stone');
        if (name.startsWith('+')) throw new Error(`character "${name}" is an admin`);
        if ((c >>> 16) !== 0x8602) throw new Error(`spawned in 0x${c.toString(16)}, not the Holtburg academy 0x8602`);
        if (!stone) throw new Error('no Calling Stone in the starting pack');
        return `"${name}" in 0x${c.toString(16)} with a Calling Stone`;
      });
      await step('greeter', () => give('Calling Stone', 'Society Greeter', /./));
      await step('training-area', async () => {
        await use('Door');
        await use('Training Area');
        return `cell 0x${(await cell()).toString(16)}`;
      });
      await step('golem-token', async () => {
        await use('Training Master', 8000); // walk to him: the golems spar in his room
        return farm('Sparring Golem', 'Academy Token', 2);
      });
      await step('training-master', async () => {
        const mark = await chatMark();
        await give('Academy Token', 'Training Master', /experience|level/i);
        const lvl = await waitNewChat(mark, /level 2|You are now level/i, 10_000);
        return lvl ?? `XP given; no level line (${JSON.stringify((await chatSince(mark)).slice(-4))})`;
      });
      await step('central-courtyard', async () => { await use('Central Courtyard', 12_000); return `cell 0x${(await cell()).toString(16)}`; });
      await step('foreman-wing', async () => {
        await use('Academy Foreman');
        await use('Door'); // "They are here through this door beside me."
        return farm('Carpenter Wasp', 'Carpenter Wasp Wing', 12);
      });
      await step('foreman-turn-in', () => give('Carpenter Wasp Wing', 'Academy Foreman', /experience|level/i));
      await step('thrungus-bellows', async () => {
        await use('Academy Blacksmith', 10_000); // the thieves raid the gardens beside his forge
        return farm('Thieving Thrungus', 'Bellows', 12);
      });
      await step('blacksmith-turn-in', () => give('Bellows', 'Academy Blacksmith', /experience|level|Key/i));
    }
    // Upstairs: ACE's MoveTo walks a straight line, so the Outer Courtyard
    // portal (z 12) is reached by walking the academy's cells up the stairs
    // and into the portal, as a player does. These steps don't block the death check below.
    await step('outer-courtyard', async () => {
      const portal = await instanceAt(29334); // Outer Courtyard, docs/first-hour-academy.md
      const walked = await walkTo(portal, 'outer-courtyard');
      const n = walked.waypoints;
      // The last waypoint is the portal's origin: walking onto it enters it.
      if (!(await portalled(walked))) {
        const p = await me();
        // Live 2026-10-04: the client sometimes drops the player through the top stair (BUG.academy-stairs-fall-through).
        const fell = p.z < portal.z - 4 ? ` — FELL through the floor (z ${p.z.toFixed(1)} under the portal's ${portal.z.toFixed(1)})` : '';
        throw new Error(`walked ${n} waypoints to the portal; not taken, at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) 0x${p.cell.toString(16)}${fell}`);
      }
      return `${n} waypoints up the stairs; portal → cell 0x${(await cell()).toString(16)}`;
    }, false);
    const upstairs = steps[steps.length - 1].ok && !onlyStairs;
    const approach = async (name: string): Promise<void> => { await walkToObject((await nearest(name)).guid, name); };
    if (upstairs) await step('olthoi-orb', async () => {
      await approach('Sentry');
      await use('Sentry');
      // "Infiltrate the hive and travel as deep into it as you can": the Adolescent Olthoi is two floors down.
      const n = (await walkTo(await instanceAt(29331), 'olthoi hive', true)).waypoints;
      return `${n} waypoints into the hive; ${await farm('Adolescent Olthoi', 'Protection Orb', 2)}`;
    }, false);
    if (upstairs) await step('sentry-turn-in', async () => {
      await walkTo(await instanceAt(30994), 'back to the Sentry', true); // Sentry (Holtburg wcid)
      return give('Protection Orb', 'Sentry', /experience|level/i);
    }, false);
    // The stairs-only check also walks to the exit portal (an admin without SentryTaskComplete may be refused it).
    if (upstairs || (onlyStairs && steps[steps.length - 1].ok)) await step('exit-portal', async () => {
      const portal = await instanceAt(29338); // Exit to Holtburg (Holtburg wcid)
      const walked = await walkTo(portal, 'exit portal');
      const n = walked.waypoints;
      if (!(await portalled(walked))) throw new Error(`walked ${n} waypoints to the exit portal; not taken (0x${(await cell()).toString(16)})`);
      const c = await cell();
      if ((c >>> 16) !== 0xa9b4) throw new Error(`after the exit portal in 0x${c.toString(16)}, not Holtburg 0xA9B4`);
      return `${n} waypoints; Holtburg 0x${c.toString(16)}`;
    }, false);
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
  }
  try {
    // The first death runs whatever happened above: it depends on nothing but being in the world.
    await step('first-death', async () => {
      const before = await cell();
      const mark = await chatMark();
      await page.evaluate('window.acDebug.suicide()');
      const died = await waitNewChat(mark, /died|You have been|killed|retained all your items/i, 30_000);
      await page.waitForTimeout(15_000);
      const after = await cell();
      const lines = await chatSince(mark);
      const retained = lines.find((l) => /retained all your items/i.test(l)) ?? null;
      if (!died) throw new Error(`no death line; chat: ${JSON.stringify(lines.slice(-6))}`);
      return `died ${JSON.stringify(died)}; ${JSON.stringify(retained)}; cell 0x${before.toString(16)} → 0x${after.toString(16)} (sanctuary = academy 0x860201ad until the exit portal)`;
    }, false);
  } finally {
    console.log('chat tail:', JSON.stringify((await chatLines(page).catch(() => [])).slice(-12)));
    writeFileSync(`${OUT}/results.json`, `${JSON.stringify({ run: RUN, account: ACCOUNT, character: CHAR, steps }, null, 1)}\n`);
    await s.browser.close();
  }
  const failed = steps.filter((x) => !x.ok);
  console.log(`${steps.length - failed.length}/${steps.length} steps passed (of 15 planned)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
