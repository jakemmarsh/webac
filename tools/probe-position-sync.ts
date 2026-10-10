/**
 * probe-position-sync — BUG.local-position-desync-after-pushout.
 *
 * Measures, live, whether the server's idea of OUR position (ACE `@myloc`:
 * Player.Location — the last AutonomousPosition / MoveToState it accepted,
 * GameActionAutonomousPosition.cs → Player_Tick.UpdatePlayerPosition) matches
 * the client's local position after movement the player did not key in:
 *
 *   A. teleport onto a spot a creature occupies (collision push-out), idle
 *   B. run into a building wall (sliding along it), then idle
 *   C. stand still beside a creature that walks into us, idle
 *
 * For each: the local position (acDebug.collisionState), the server's
 * Location from @myloc, and their horizontal gap, sampled a few seconds after
 * the scenario settles. Retail's CommandInterpreter::ShouldSendPositionEvent
 * (@006b45e0) reports any position change within ~1 s even with no input, so
 * every gap should be ~0 (< 0.1 m) after 3 s.
 *
 * Usage: AC_BASE=http://localhost:3157/ AC_ACCOUNT=syncprobe AC_PASSWORD=syncprobe \
 *          TAG=after npx tsx tools/probe-position-sync.ts   (writes verification/position-sync/results-<TAG>.json)
 * The account must be admin (docs in the task: accessLevel=5 in ace_auth.account).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterWorld, adminCommand } from './lib/game-session.js';

const OUT = 'verification/position-sync';

interface Loc { cell: number; x: number; y: number; z: number; worldX: number; worldZ: number }

/** Parse the last "Location: 0xCELL [x y z] …" line in the chat. */
async function serverLoc(page: Page): Promise<Loc | null> {
  const before = await chatCount(page);
  await adminCommand(page, '@myloc');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    const lines = await chatLines(page);
    const hit = lines.slice(before).reverse().find((l) => /Location: 0x[0-9A-F]{8} \[/.test(l));
    if (hit) {
      const m = /Location: 0x([0-9A-F]{8}) \[([-\d.]+) ([-\d.]+) ([-\d.]+)\]/.exec(hit)!;
      const cell = parseInt(m[1], 16) >>> 0;
      const x = +m[2], y = +m[3], z = +m[4];
      return { cell, x, y, z, worldX: ((cell >>> 24) & 0xff) * 192 + x, worldZ: ((cell >>> 16) & 0xff) * 192 + y };
    }
  }
  return null;
}
const chatLines = (page: Page): Promise<string[]> => page.evaluate(`(() => { const c = document.getElementById('chat-messages');
  return c ? [...c.children].map((e) => ((e.dataset && e.dataset.chatText) || e.textContent || '').trim()) : []; })()`) as Promise<string[]>;
const chatCount = async (page: Page): Promise<number> => (await chatLines(page)).length;

interface Local { x: number; z: number; feetY: number; onGround: boolean; inDungeon: boolean }
const local = (page: Page): Promise<Local> => page.evaluate('window.acDebug.collisionState()') as Promise<Local>;

/** Sent AutonomousPosition count (the MovementSync debug counter). */
const sentCount = (page: Page): Promise<number> =>
  page.evaluate('(window.__ac && window.__ac.movementSync && window.__ac.movementSync.autonomousPositionsSent) || 0') as Promise<number>;

async function measure(page: Page, label: string, results: Record<string, unknown>[]): Promise<void> {
  const me = await local(page);
  const srv = await serverLoc(page);
  const gap = srv ? Math.hypot(srv.worldX - me.x, srv.worldZ - me.z) : NaN;
  const row = {
    label, local: [+me.x.toFixed(3), +me.z.toFixed(3), +(me.feetY ?? 0).toFixed(3)],
    server: srv ? [+srv.worldX.toFixed(3), +srv.worldZ.toFixed(3), +srv.z.toFixed(3), `0x${srv.cell.toString(16)}`] : null,
    gapMeters: +gap.toFixed(3), apSent: await sentCount(page),
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

function telelocFor(worldX: number, worldZ: number, z: number): string {
  const lbX = Math.floor(worldX / 192), lbY = Math.floor(worldZ / 192);
  const lx = worldX - lbX * 192, ly = worldZ - lbY * 192;
  const cell = Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1;
  const id = ((lbX << 24) | (lbY << 16) | cell) >>> 0;
  return `@teleloc 0x${id.toString(16).toUpperCase().padStart(8, '0')} [${lx.toFixed(3)} ${ly.toFixed(3)} ${z.toFixed(3)}] 1 0 0 0`;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'position-sync', createCharacter: 'Syncprobe' } as never);
  const page = s.page;
  const results: Record<string, unknown>[] = [];
  await page.waitForTimeout(4000);
  await adminCommand(page, '@god');
  // Holtburg, open ground west of the town square.
  await adminCommand(page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
  await page.waitForTimeout(9000);
  await measure(page, 'baseline idle after teleloc', results);

  // ── A. teleport onto a creature ─────────────────────────────────────
  await adminCommand(page, '@create 7'); // Drudge Skulker, spawned in front of us
  await page.waitForTimeout(5000);
  // The drudge we just spawned: the nearest one (Holtburg has others roaming).
  const foe = await page.evaluate(`(() => { const cs = window.acDebug.collisionState();
    const o = [...window.__ac.serverObjectManager.objects.values()]
    .filter((o) => /drudge/i.test(o.name || '') && o.collisionRadius > 0)
    .sort((a, b) => Math.hypot(a.worldX - cs.x, a.worldZ - cs.z) - Math.hypot(b.worldX - cs.x, b.worldZ - cs.z))[0];
    return o ? { x: o.worldX, z: o.worldZ, y: o.mesh ? o.mesh.position.y : 0, r: o.collisionRadius } : null; })()`) as { x: number; z: number; y: number; r: number } | null;
  console.log('drudge', JSON.stringify(foe));
  if (foe) {
    // Spawned drudges stand still until they notice us; freeze its spot and
    // teleport exactly onto it.
    await adminCommand(page, telelocFor(foe.x, foe.z, foe.y));
    await page.waitForTimeout(700);
    const arrived = await local(page);
    const push = Math.hypot(arrived.x - foe.x, arrived.z - foe.z);
    console.log(`A: local ${push.toFixed(3)} m from the teleport target (drudge r=${foe.r.toFixed(2)})`);
    results.push({ label: 'A: push-out from the teleport target', meters: +push.toFixed(3) });
    await page.waitForTimeout(1800);
    await measure(page, 'A: 2.5 s after teleport onto drudge', results);
    await page.waitForTimeout(3500);
    await measure(page, 'A: 6 s after teleport onto drudge', results);
    await page.waitForTimeout(4000);
    await measure(page, 'D: 10 s beside the (fighting) drudge, idle', results);
  }

  // ── B. run into a wall ─────────────────────────────────────────────
  // probe-flow-movement's wall leg: from the Holtburg POI, run 8 s — the
  // run ends against a building face (sliding along it).
  await adminCommand(page, '@telepoi holtburg');
  await page.waitForTimeout(12000);
  await page.click('#game-canvas', { position: { x: 700, y: 400 } }).catch(() => {});
  const b0 = await local(page);
  await page.keyboard.down('w');
  const trail: string[] = [];
  for (let i = 0; i < 16; i++) { await page.waitForTimeout(500); const p = await local(page); trail.push(`${p.x.toFixed(1)},${p.z.toFixed(1)}`); }
  await page.keyboard.up('w');
  console.log(`B: ran from ${b0.x.toFixed(1)},${b0.z.toFixed(1)}: ${trail.join(' ')}`);
  await page.waitForTimeout(2500);
  await measure(page, 'B: 2.5 s idle after running into a wall', results);

  // ── C. a slope ────────────────────────────────────────────────────
  // The steepest walkable terrain within 150 m: run 2.5 s across it, idle.
  const slope = await page.evaluate(`(() => { const tc = window.__ac.terrainCollision, cs = window.acDebug.collisionState();
    let best = null; for (let dx = -150; dx <= 150; dx += 6) for (let dz = -150; dz <= 150; dz += 6) {
      const x = cs.x + dx, z = cs.z + dz, a = tc.getSlopeAngle(x, z), h = tc.getHeightAt(x, z);
      if (a === null || h === null || !tc.isWalkable(x, z)) continue; if (!best || a > best.a) best = { x, z, h, a }; }
    return best; })()`) as { x: number; z: number; h: number; a: number } | null;
  console.log('slope', JSON.stringify(slope));
  if (slope) {
    await adminCommand(page, telelocFor(slope.x, slope.z, slope.h + 0.05));
    await page.waitForTimeout(8000);
    await page.click('#game-canvas', { position: { x: 700, y: 400 } }).catch(() => {});
    await page.keyboard.down('w');
    await page.waitForTimeout(2500);
    await page.keyboard.up('w');
    await page.waitForTimeout(2500);
    await measure(page, `C: 2.5 s idle after running on a ${(slope.a * 180 / Math.PI).toFixed(0)}° slope`, results);
  }

  writeFileSync(`${OUT}/results-${process.env.TAG ?? "latest"}.json`, JSON.stringify(results, null, 1));
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
