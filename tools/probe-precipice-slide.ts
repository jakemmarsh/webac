/**
 * probe-precipice-slide — live check for RECON.transition-stepup-stepdown-port.b.
 *
 * Retail: an EdgeSlide player (every player) standing on a walkable BSP
 * polygon cannot walk off its edge where the drop is beyond StepDownHeight:
 * CTransition::edge_slide @ 0050b3d0 → SPHEREPATH::precipice_slide @ 0050cc80
 * slides the step along the crossed edge. A jump still goes over.
 *
 * The probe arrives at a POI, scans for a spot on a BSP floor (the outdoor
 * floor stands above the terrain) with a > 2 m drop within 3 m in some
 * direction, then:
 *   walk-at-edge   — holds forward straight at the edge for 3 s;
 *   walk-along     — holds forward 35° off the edge normal (slides along it);
 *   jump-off       — a running jump over the edge.
 *
 * Usage: npx tsx tools/probe-precipice-slide.ts [poi=Xarabydun]   (dev server + bridge + ACE)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, telepoi, teleloc, adminCommand, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'recon-precipice-slide');
mkdirSync(OUT, { recursive: true });
const poi = process.argv[2] ?? 'Xarabydun';

type Spot = { x: number; z: number; floor: number; dx: number; dz: number; edgeAt: number; drop: number };
type State = { x: number; z: number; feetY: number; onGround: boolean; animAirborne: boolean; lastFloor: number };

const STATE_JS = '(() => window.acDebug.collisionState())()';
const { browser, page } = await enterWorld();
const report: Record<string, unknown> = { poi };
const corrections: string[] = [];
page.on('console', (m) => { const t = m.text(); if (/Position correction/i.test(t)) corrections.push(t.slice(0, 300)); });
report.corrections = corrections;
try {
  await telepoi(page, poi);
  const me = await page.evaluate(STATE_JS) as State;
  report.arrival = me;
  const spots = await page.evaluate(`(() => {
    const cx = ${me.x}, cz = ${me.z}, fy = ${me.lastFloor};
    const dbg = window.acDebug;
    // The outdoor ground main.ts follows: a BSP floor at or above the terrain, else the terrain.
    const ground = (x, z, from) => {
      const f = dbg.floorAt(x, z, from);
      if (f.outdoor !== null && f.terrain !== null && f.outdoor >= f.terrain - 0.5) return Math.max(f.outdoor, f.terrain);
      return f.terrain;
    };
    const out = [];
    for (let r = 0; r <= 40 && out.length < 60; r += 1) {
      for (let a = 0; a < 360; a += r === 0 ? 360 : 10) {
        const x = cx + r * Math.cos(a * Math.PI / 180), z = cz + r * Math.sin(a * Math.PI / 180);
        const f = dbg.floorAt(x, z, fy + 0.5);
        if (f.outdoor === null || f.terrain === null || f.outdoor < f.terrain + 1) continue; // on a raised BSP floor
        const floor = f.outdoor;
        for (let d = 0; d < 16; d++) {
          const dx = Math.cos(d * Math.PI / 8), dz = Math.sin(d * Math.PI / 8);
          let edgeAt = -1, drop = 0;
          for (let s = 0.25; s <= 3; s += 0.25) {
            const g = ground(x + dx * s, z + dz * s, floor + 0.05);
            if (g === null) break;
            if (floor - g > 2) { edgeAt = s; drop = floor - g; break; }
            if (Math.abs(g - floor) > 0.3) break; // a step or a wall, not a flat run to the edge
          }
          if (edgeAt < 1.5) continue;
          out.push({ x, z, floor, dx, dz, edgeAt, drop });
        }
      }
    }
    return out.sort((p, q) => q.drop - p.drop);
  })()`) as Spot[];
  report.candidates = spots.length;
  const c = spots[0];
  if (!c) throw new Error(`no raised BSP floor with a drop found near ${poi}`);
  report.spot = c;
  console.log(JSON.stringify(c));

  const loc = (x: number, z: number, y: number, dirX: number, dirZ: number): string => {
    const lbX = Math.floor(x / 192), lbY = Math.floor(z / 192);
    const lx = x - lbX * 192, ly = z - lbY * 192;
    const cell = ((lbX << 24) | (lbY << 16)) + Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1;
    const th = Math.atan2(-dirX, dirZ); // forward (−sinθ, cosθ) = (dirX, dirZ)
    return `0x${(cell >>> 0).toString(16).padStart(8, '0')} [${lx.toFixed(2)} ${ly.toFixed(2)} ${y.toFixed(2)}] ${Math.cos(th / 2).toFixed(4)} 0 0 ${Math.sin(th / 2).toFixed(4)}`;
  };

  const beats: Record<string, unknown>[] = [];
  const run = async (label: string, dirX: number, dirZ: number, act: () => Promise<void>) => {
    await adminCommand(page, '@heal');
    await page.waitForTimeout(600);
    await teleloc(page, loc(c.x, c.z, c.floor + 0.05, dirX, dirZ), 2500);
    const a = await page.evaluate(STATE_JS) as State;
    const trace: Record<string, unknown>[] = [];
    const sample = async (t: number) => {
      const s = await page.evaluate(STATE_JS) as State;
      trace.push({
        t, towardEdge: +((s.x - a.x) * c.dx + (s.z - a.z) * c.dz).toFixed(3),
        along: +((s.x - a.x) * -c.dz + (s.z - a.z) * c.dx).toFixed(3),
        feetY: +s.feetY.toFixed(3), onGround: s.onGround, animAirborne: s.animAirborne,
      });
    };
    await act();
    for (let i = 0; i < 14; i++) {
      await page.waitForTimeout(250);
      await sample((i + 1) * 0.25);
      if (i === 5) await page.screenshot({ path: join(OUT, `${label}-mid.png`) });
    }
    for (const k of ['w', 'Space']) await page.keyboard.up(k);
    await page.waitForTimeout(800);
    const b = await page.evaluate(STATE_JS) as State;
    const beat = {
      beat: label, startFeetY: a.feetY, endFeetY: b.feetY,
      towardEdge: (b.x - a.x) * c.dx + (b.z - a.z) * c.dz,
      along: (b.x - a.x) * -c.dz + (b.z - a.z) * c.dx,
      everAirborne: trace.some((t) => t.onGround === false), endOnGround: b.onGround,
      teleportedAway: Math.hypot(b.x - a.x, b.z - a.z) > 100, trace,
    };
    beats.push(beat);
    console.log(JSON.stringify({ ...beat, trace: undefined }));
    await page.screenshot({ path: join(OUT, `${label}-end.png`) });
  };
  // Back off 1 m from the spot so the walk builds up to run speed before the edge.
  const along = 35 * Math.PI / 180;
  const ax = c.dx * Math.cos(along) - c.dz * Math.sin(along);
  const az = c.dx * Math.sin(along) + c.dz * Math.cos(along);
  await run('walk-at-edge', c.dx, c.dz, async () => { await page.keyboard.down('w'); });
  await run('walk-along', ax, az, async () => { await page.keyboard.down('w'); });
  await run('jump-off', c.dx, c.dz, async () => {
    await page.keyboard.down('w');
    await page.keyboard.down('Space');
    await page.waitForTimeout(300);
    await page.keyboard.up('Space');
  });
  report.beats = beats;
} finally {
  writeFileSync(join(OUT, 'probe.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
