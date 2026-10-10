/**
 * probe-bsp-step-up — live check for RECON.transition-stepup-stepdown-port.c.
 *
 * Retail CTransition::step_up @ 0050b610: a feet-sphere hit on a building /
 * static BSP lifts the body onto the walkable polygon the sphere overlaps at
 * the destination (BSPTREE::step_sphere_down → find_walkable), by up to
 * 1.5 × StepUpHeight (CPolygon::adjust_sphere_to_plane), when the body fits
 * where it lands; otherwise it slides (step_up_slide).
 *
 * The probe arrives at a POI and scans for spots on the terrain facing a
 * raised outdoor BSP floor (a building foundation, porch or plinth) whose
 * top stands 0.15-0.95 m above the terrain at its edge. It takes the lowest
 * distinct spots (up to 8), walks at the edge holding W for 3 s, and records
 * the feet height and the step-up the collider reported each poll.
 *
 * Usage: npx tsx tools/probe-bsp-step-up.ts [poi=Holtburg] [--label after]
 *   (dev server + bridge + ACE). Writes verification/recon-bsp-step-up/<label>-<poi>.json + PNGs.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, telepoi, teleloc, adminCommand, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'recon-bsp-step-up');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const li = args.indexOf('--label');
const label = li > -1 ? args[li + 1] : 'after';
const poi = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--label') ?? 'Holtburg';
const tag = `${label}-${poi.replace(/\W+/g, '')}`;

type Spot = { x: number; z: number; ground: number; dx: number; dz: number; edgeAt: number; top: number; rise: number };
type State = { x: number; z: number; feetY: number; onGround: boolean; lastFloor: number; outdoorStepUp: number; dungeonStepUp: number };
const STATE_JS = '(() => window.acDebug.collisionState())()';

const { browser, page } = await enterWorld();
const report: Record<string, unknown> = { poi, label };
try {
  await telepoi(page, poi);
  const me = await page.evaluate(STATE_JS) as State;
  report.arrival = me;
  const spots = await page.evaluate(`(() => {
    const cx = ${me.x}, cz = ${me.z}, fy = ${me.lastFloor};
    const dbg = window.acDebug;
    const out = [];
    for (let r = 2; r <= 90; r += 1.5) {
      for (let a = 0; a < 360; a += 8) {
        const x = cx + r * Math.cos(a * Math.PI / 180), z = cz + r * Math.sin(a * Math.PI / 180);
        const f = dbg.floorAt(x, z, fy + 3);
        if (f.terrain === null) continue;
        if (f.outdoor !== null && f.outdoor > f.terrain - 0.05) continue; // stand on bare terrain
        const ground = f.terrain;
        for (let d = 0; d < 16; d++) {
          const dx = Math.cos(d * Math.PI / 8), dz = Math.sin(d * Math.PI / 8);
          let prevT = ground, hit = null;
          for (let s = 0.2; s <= 1.6; s += 0.1) {
            const g = dbg.floorAt(x + dx * s, z + dz * s, ground + 1.2);
            if (g.terrain === null) break;
            if (Math.abs(g.terrain - prevT) > 0.08) break; // terrain itself steps: not a BSP edge
            prevT = g.terrain;
            if (g.outdoor !== null && g.outdoor - g.terrain > 0.12) { hit = { s, top: g.outdoor, t: g.terrain }; break; }
          }
          if (!hit || hit.s < 0.9) continue;
          // The raised floor must run on past the edge (a slab, not a rail).
          const beyond = dbg.floorAt(x + dx * (hit.s + 1.2), z + dz * (hit.s + 1.2), hit.top + 0.3);
          if (beyond.outdoor === null || Math.abs(beyond.outdoor - hit.top) > 0.1) continue;
          const rise = hit.top - hit.t;
          if (rise < 0.15 || rise > 0.95) continue;
          out.push({ x, z, ground, dx, dz, edgeAt: hit.s, top: hit.top, rise });
        }
      }
    }
    return out;
  })()`) as Spot[];
  report.candidates = spots.length;
  // Every distinct spot (3 m apart), lowest rise first, at most 8: walls with
  // an interior floor behind them pass the scan too, so the beats themselves
  // say which spots are steps (run --label before on the old code to compare).
  const chosen: { name: string; spot: Spot }[] = [];
  for (const s of [...spots].sort((p, q) => p.rise - q.rise)) {
    if (chosen.length >= 8) break;
    if (chosen.some((c) => Math.hypot(c.spot.x - s.x, c.spot.z - s.z) < 3)) continue;
    chosen.push({ name: `s${chosen.length}-${s.rise.toFixed(2)}`, spot: s });
  }
  report.chosen = chosen;
  console.log(`candidates ${spots.length}; walking ${chosen.map((b) => b.name).join(' ')}`);

  const loc = (x: number, z: number, y: number, dirX: number, dirZ: number): string => {
    const lbX = Math.floor(x / 192), lbY = Math.floor(z / 192);
    const lx = x - lbX * 192, ly = z - lbY * 192;
    const cell = ((lbX << 24) | (lbY << 16)) + Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1;
    const th = Math.atan2(-dirX, dirZ);
    return `0x${(cell >>> 0).toString(16).padStart(8, '0')} [${lx.toFixed(2)} ${ly.toFixed(2)} ${y.toFixed(2)}] ${Math.cos(th / 2).toFixed(4)} 0 0 ${Math.sin(th / 2).toFixed(4)}`;
  };

  const beats: Record<string, unknown>[] = [];
  for (const { name, spot: c } of chosen) {
    await adminCommand(page, '@heal');
    await page.waitForTimeout(500);
    await teleloc(page, loc(c!.x, c!.z, c!.ground + 0.05, c!.dx, c!.dz), 2500);
    await page.waitForTimeout(1500);
    const a = await page.evaluate(STATE_JS) as State;
    let maxStepUp = 0;
    const trace: number[][] = [];
    await page.keyboard.down('w');
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      const s = await page.evaluate(STATE_JS) as State;
      maxStepUp = Math.max(maxStepUp, s.outdoorStepUp ?? 0, s.dungeonStepUp ?? 0);
      trace.push([+((s.x - a.x) * c!.dx + (s.z - a.z) * c!.dz).toFixed(2), +s.feetY.toFixed(3), +(s.outdoorStepUp ?? 0).toFixed(3)]);
      if (i === 5) await page.screenshot({ path: join(OUT, `${tag}-${name}-mid.png`) });
    }
    await page.keyboard.up('w');
    await page.waitForTimeout(600);
    const b = await page.evaluate(STATE_JS) as State;
    const forward = (b.x - a.x) * c!.dx + (b.z - a.z) * c!.dz;
    const climbed = Math.abs(b.feetY - c!.top) < 0.15 && forward > c!.edgeAt;
    const beat = {
      band: name, rise: +c!.rise.toFixed(3), edgeAt: +c!.edgeAt.toFixed(2), top: +c!.top.toFixed(3),
      startFeetY: +a.feetY.toFixed(3), endFeetY: +b.feetY.toFixed(3), forward: +forward.toFixed(2),
      climbed, maxStepUp: +maxStepUp.toFixed(3), trace, spot: c,
    };
    beats.push(beat);
    console.log(JSON.stringify({ ...beat, trace: undefined, spot: undefined }));
    await page.screenshot({ path: join(OUT, `${tag}-${name}-end.png`) });
  }
  report.beats = beats;
} finally {
  writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
