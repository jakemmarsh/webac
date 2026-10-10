/**
 * probe-stairs — walk a player up and down real staircases with W held, as a
 * player does, and record the feet height along the way.
 *
 * Each case teleports onto a floor, then steers through explicit waypoints
 * up or down a staircase (the stair GfxObj's walkable ramp polygon, from the
 * DAT) as a player holding W does. A case passes when the player reaches the
 * last waypoint standing on the expected floor height; it fails on a stall
 * (no progress for 4 s) or ending on the wrong level.
 *
 *   house-up / house-down  Holtburg house 0xA9B40104 (floor 66.0) ↔ 0x101
 *                          (floor 69.5) by the ramp of stair GfxObj 0x01000C1F:
 *                          (80.7, 128.8) at 66.0 → (77.1, 128.8) at 69.5
 *   hall-ramp-up           Holtburg building 0xA9B4013F (floor 94.0): the ramp
 *                          (Setup 0x020001B4 part 1, GfxObj 0x0100082D physics
 *                          poly 8, normal z 0.695) along y 7.9 leaves the floor
 *                          at x ≈ 130.45 and climbs 1.0345 m per metre of -x
 *                          (94.47 at x 130, 96.26 at x 128.27); the case ends
 *                          on that plane, wherever along it the player stops
 *
 * Usage: bash tools/with-gpu-lock.sh -- npx tsx tools/probe-stairs.ts [case…]
 *   AC_STAIRS_ACCOUNT  admin account to use (default stairprobe1)
 * Writes verification/stairs/<run>/results.json + a screenshot per case.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { yawToward } from './lib/cell-path.ts';
import { enterWorld, gameUrl, shot, teleloc } from './lib/game-session.ts';

const ACCOUNT = process.env.AC_STAIRS_ACCOUNT ?? 'stairprobe1';
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = `verification/stairs/${RUN}`;

interface Case { name: string; cell: number; from: { x: number; y: number; z: number }; via: { x: number; y: number }[]; endZ: number | ((p: { x: number; y: number }) => number) }
const LB = 0xA9B40000;
const CASES: Case[] = [
  { name: 'house-up', cell: LB | 0x104, from: { x: 82.5, y: 128.8, z: 66.0 }, via: [{ x: 81.5, y: 128.8 }, { x: 75.5, y: 129.3 }], endZ: 69.5 },
  { name: 'house-down', cell: LB | 0x101, from: { x: 75.0, y: 129.3, z: 69.5 }, via: [{ x: 76.5, y: 128.8 }, { x: 82.3, y: 128.8 }], endZ: 66.0 },
  { name: 'hall-ramp-up', cell: LB | 0x13F, from: { x: 132.5, y: 7.9, z: 94.0 }, via: [{ x: 128.0, y: 7.9 }], endZ: (p) => 94.472 + (130 - p.x) * 1.0345 },
];

let page: Page;
interface Where { cell: number; x: number; y: number; z: number }
async function me(): Promise<Where> {
  const c = await page.evaluate('(() => { const c = window.acDebug.collisionState(); return { cell: c.cellId >>> 0, x: c.x, z: c.z, y: c.feetY ?? c.y }; })()') as { cell: number; x: number; z: number; y: number };
  return { cell: c.cell, x: c.x - ((c.cell >>> 24) & 255) * 192, y: c.z - ((c.cell >>> 16) & 255) * 192, z: c.y };
}

/** Hold W along the route; returns the feet trace and a failure reason (or null). */
async function walk(route: { x: number; y: number }[], tag: string): Promise<{ trace: Where[]; fail: string | null }> {
  const trace: Where[] = [];
  await page.keyboard.down('KeyW');
  try {
    let from = await me();
    for (const [i, wp] of route.entries()) {
      const last = i === route.length - 1;
      // Reached = within the radius, or already past the waypoint along this leg.
      // Headless SwiftShader can run ~2 fps indoors, and one 0.5 s frame at run
      // speed moves ~4 m, so a radius alone overshoots and oscillates
      // (BUG.post-teleport-stair-snap: the "snap" was one long frame).
      const leg = { x: wp.x - from.x, y: wp.y - from.y };
      const legLen = Math.hypot(leg.x, leg.y) || 1;
      let bestD = Infinity, bestAt = Date.now();
      for (;;) {
        const p = await me();
        trace.push(p);
        const d = Math.hypot(wp.x - p.x, wp.y - p.y);
        const ahead = ((wp.x - p.x) * leg.x + (wp.y - p.y) * leg.y) / legLen;
        const lateral = Math.abs(((wp.x - p.x) * leg.y - (wp.y - p.y) * leg.x) / legLen);
        if (d < (last ? 0.6 : 0.8) || (ahead <= 0 && lateral < 0.8)) { from = p; break; }
        await page.evaluate(`window.acDebug.setPlayerYaw(${yawToward(p, wp)})`);
        if (d < bestD - 0.1) { bestD = d; bestAt = Date.now(); } else if (Date.now() - bestAt > 4000) {
          return { trace, fail: `${tag}: stuck ${d.toFixed(2)} m short of waypoint ${i + 1}/${route.length} (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}) in 0x${p.cell.toString(16)} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})` };
        }
        await page.waitForTimeout(50);
      }
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
  return { trace, fail: null };
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const cases = only.length ? CASES.filter((c) => only.includes(c.name)) : CASES;
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ url: gameUrl({ cb: 'probe-stairs', env: { ...process.env, AC_ACCOUNT: ACCOUNT, AC_PASSWORD: ACCOUNT } }), createCharacter: 'Stair Probe', settleMs: 5000 });
  page = s.page;
  const results: unknown[] = [];
  try {
    for (const c of cases) {
      // Per-frame arrival trace (BUG.post-teleport-stair-snap): every rAF from the
      // teleloc through the first second of W, so a snap shows which frame moved.
      await page.evaluate(`(() => { const rec = window.__stairRec = { frames: [], on: true }; const t0 = performance.now();
        const tick = () => { if (!rec.on) return; const c = window.acDebug.collisionState();
          rec.frames.push({ t: Math.round(performance.now() - t0), x: c.x, z: c.z, feet: c.feetY, cell: c.cellId >>> 0, lc: c.loginComplete, g: c.onGround, up: c.dungeonStepUp, dg: c.inDungeon });
          requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
      await teleloc(page, `0x${(c.cell >>> 0).toString(16).toUpperCase()} [${c.from.x} ${c.from.y} ${c.from.z + 0.01}] 1 0 0 0`, 12_000);
      const start = await me();
      const route = c.via;
      const { trace, fail } = await walk(route, c.name);
      // Judge the level once landed: at headless frame rates a long frame can
      // carry the player off the ramp foot, still falling the last few cm.
      for (let i = 0; i < 40 && !(await page.evaluate('window.acDebug.collisionState().onGround')); i++) await page.waitForTimeout(50);
      const end = await me();
      const frames = await page.evaluate('(() => { const r = window.__stairRec; r.on = false; return r.frames; })()') as { t: number; x: number; z: number; feet: number }[];
      const snaps = frames.slice(1).map((f, i) => ({ f, d: Math.hypot(f.x - frames[i].x, f.z - frames[i].z) })).filter((s) => s.d > 1);
      const fps = frames.length > 1 ? (frames.length - 1) / ((frames[frames.length - 1].t - frames[0].t) / 1000) : 0;
      console.log(`  ${frames.length} frames, ${fps.toFixed(1)} fps over the case (a frame jump is one long frame's movement)`);
      for (const s of snaps) console.log(`  frame jump ${s.d.toFixed(2)} m at t=${s.f.t} ms → (${s.f.x.toFixed(2)}, ${s.f.z.toFixed(2)}, feet ${s.f.feet.toFixed(2)})`);
      const endZ = typeof c.endZ === 'number' ? c.endZ : c.endZ(end);
      const levelOk = Math.abs(end.z - endZ) < 0.3;
      const ok = !fail && levelOk;
      const detail = fail ?? (levelOk ? `arrived at z ${end.z.toFixed(2)}` : `ended on the wrong level: z ${end.z.toFixed(2)} vs ${endZ.toFixed(2)}`);
      const maxJump = trace.slice(1).reduce((m, p, i) => Math.max(m, Math.abs(p.z - trace[i].z)), 0);
      console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: ${detail}; start z ${start.z.toFixed(2)}, max per-poll dz ${maxJump.toFixed(2)}, ${trace.length} polls`);
      await shot(page, `${OUT}/${c.name}.png`);
      results.push({ case: c.name, ok, detail, start, end, route, trace, fps, frames });
    }
  } finally {
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
    await s.browser.close();
  }
  console.log(`results: ${OUT}/results.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
