/**
 * probe-obstacle-step-up — live check for RECON.transition-stepup-stepdown-port.c.b.
 *
 * Retail CCylSphere::step_sphere_up @ 0053b310 / CSphere::step_sphere_up
 * @ 00537900 run CTransition::step_up: the feet sphere lands on the
 * cylinder's flat top (deltaz = Height + r − disp.Z), on a walkable spot of
 * the sphere (contact normal Z above FloorZ), on a BSP walkable or on the
 * terrain, and the Placement insert must pass. The old code raised the body
 * by the full StepUpHeight and retested, so every obstacle step up reported
 * exactly 0.6 and a low boulder met at its side was stepped over.
 *
 * The probe arrives at a POI, takes every scenery CylSphere / Sphere
 * obstacle within 90 m, and from 8 directions starts the body just clear of
 * it on the terrain and asks acDebug.probeMove for a 0.3 m move at its axis.
 * It counts the moves resolved by a step up (and at what lift) and the moves
 * stopped or slid, then walks the player (holding W) into the first few
 * stepped-up obstacles and records how far it got.
 *
 * Usage: npx tsx tools/probe-obstacle-step-up.ts [poi=Holtburg] [--label after] [--scan-only]
 *   (dev server + bridge + ACE). Writes verification/recon-obstacle-step-up/<label>-<poi>.json + PNGs.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, telepoi, teleloc, adminCommand, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'recon-obstacle-step-up');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const li = args.indexOf('--label');
const label = li > -1 ? args[li + 1] : 'after';
const poi = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--label') ?? 'Holtburg';
const scanOnly = args.includes('--scan-only');
const tag = `${label}-${poi.replace(/\W+/g, '')}`;

type State = { x: number; z: number; feetY: number; lastFloor: number; outdoorStepUp: number };
type Probe = { kind: 'cyl' | 'sph'; ox: number; oz: number; radius: number; top: number; x: number; z: number; ground: number; dx: number; dz: number; adjusted: [number, number]; stepUp: number };
const STATE_JS = '(() => window.acDebug.collisionState())()';
const STEP = 0.3;

const { browser, page } = await enterWorld();
const report: Record<string, unknown> = { poi, label };
try {
  await telepoi(page, poi);
  await page.waitForTimeout(4000);
  const me = await page.evaluate(STATE_JS) as State;
  report.arrival = me;
  const scan = await page.evaluate(`(() => {
    const dbg = window.acDebug, STEP = ${STEP}, R = 0.48;
    const obs = [];
    for (const c of dbg.nearestCylinders(5000)) {
      if (c.distance > 90 || c.top === 'inf' || c.bottom === 'inf') continue;
      obs.push({ kind: 'cyl', x: c.x, z: c.z, radius: c.radius, top: c.top });
    }
    for (const s of dbg.nearestSpheres(5000)) {
      if (s.distance > 90) continue;
      obs.push({ kind: 'sph', x: s.x, z: s.z, radius: s.radius, top: s.y + s.radius });
    }
    const probes = [];
    for (const o of obs) {
      for (let d = 0; d < 8; d++) {
        const ux = Math.cos(d * Math.PI / 4), uz = Math.sin(d * Math.PI / 4);
        const back = o.radius + R + 0.15;
        const x = o.x - ux * back, z = o.z - uz * back;
        const f = dbg.floorAt(x, z, ${me.lastFloor} + 3);
        if (f.terrain === null) continue;
        if (f.outdoor !== null && f.outdoor > f.terrain - 0.05) continue; // bare terrain only
        const m = dbg.probeMove(ux * STEP, uz * STEP, x, f.terrain, z);
        if (!m) continue;
        probes.push({ kind: o.kind, ox: o.x, oz: o.z, radius: o.radius, top: o.top, x, z, ground: f.terrain, dx: ux * STEP, dz: uz * STEP, adjusted: m.adjusted, stepUp: m.stepUp });
      }
    }
    return { obstacles: obs.length, probes };
  })()`) as { obstacles: number; probes: Probe[] };
  const collided = scan.probes.filter((p) => p.stepUp > 0 || Math.hypot(p.adjusted[0] - p.dx, p.adjusted[1] - p.dz) > 1e-4);
  const stepped = collided.filter((p) => p.stepUp > 0);
  const summary = {
    obstacles: scan.obstacles,
    moves: scan.probes.length,
    collided: collided.length,
    stoppedOrSlid: collided.length - stepped.length,
    steppedUp: stepped.length,
    steppedUpCyl: stepped.filter((p) => p.kind === 'cyl').length,
    steppedUpSph: stepped.filter((p) => p.kind === 'sph').length,
    stepUpsAtFullStepUpHeight: stepped.filter((p) => Math.abs(p.stepUp - 0.6) < 1e-3).length,
    liftMin: +Math.min(...stepped.map((p) => p.stepUp), 9).toFixed(3),
    liftMax: +Math.max(0, ...stepped.map((p) => p.stepUp)).toFixed(3),
    sphereSideStops: collided.filter((p) => p.kind === 'sph' && !(p.stepUp > 0)).length,
  };
  report.summary = summary;
  report.steps = stepped.slice(0, 60);
  console.log(JSON.stringify(summary));

  const loc = (x: number, z: number, y: number, dirX: number, dirZ: number): string => {
    const lbX = Math.floor(x / 192), lbY = Math.floor(z / 192);
    const lx = x - lbX * 192, ly = z - lbY * 192;
    const cell = ((lbX << 24) | (lbY << 16)) + Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1;
    const th = Math.atan2(-dirX, dirZ);
    return `0x${(cell >>> 0).toString(16).padStart(8, '0')} [${lx.toFixed(2)} ${ly.toFixed(2)} ${y.toFixed(2)}] ${Math.cos(th / 2).toFixed(4)} 0 0 ${Math.sin(th / 2).toFixed(4)}`;
  };
  const spots: Probe[] = [];
  for (const p of stepped) {
    if (scanOnly || spots.length >= 4) break;
    // A town portal's dais cylinder (radius ~2.6) is stepped onto too, and
    // the server then portals the body away: not a walk beat.
    if (p.radius > 2) continue;
    if (spots.some((s) => Math.hypot(s.ox - p.ox, s.oz - p.oz) < 3)) continue;
    spots.push(p);
  }
  const beats: Record<string, unknown>[] = [];
  for (const [i, p] of spots.entries()) {
    const ux = p.dx / STEP, uz = p.dz / STEP;
    // Start 2 m back from the obstacle's near side, facing its axis.
    const sx = p.x - ux * 2, sz = p.z - uz * 2;
    await adminCommand(page, '@heal');
    await teleloc(page, loc(sx, sz, p.ground + 0.05, ux, uz), 3000);
    // Wait out portal space: until the body stands within 3 m of the start.
    for (let w = 0; w < 40; w++) {
      const s = await page.evaluate(STATE_JS) as State;
      if (Math.hypot(s.x - sx, s.z - sz) < 3 && Math.abs(s.feetY - p.ground) < 2) break;
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(2500);
    const a = await page.evaluate(STATE_JS) as State;
    let maxStepUp = 0;
    let maxFeet = a.feetY;
    await page.keyboard.down('w');
    for (let k = 0; k < 12; k++) {
      await page.waitForTimeout(250);
      const s = await page.evaluate(STATE_JS) as State;
      maxStepUp = Math.max(maxStepUp, s.outdoorStepUp ?? 0);
      maxFeet = Math.max(maxFeet, s.feetY);
    }
    await page.keyboard.up('w');
    await page.waitForTimeout(600);
    const b = await page.evaluate(STATE_JS) as State;
    const beat = {
      spot: i, kind: p.kind, obstacle: [p.ox, p.oz], radius: p.radius, topAboveGround: +(p.top - p.ground).toFixed(3),
      dir: [+ux.toFixed(3), +uz.toFixed(3)], scanStepUp: +p.stepUp.toFixed(3),
      forward: +((b.x - a.x) * ux + (b.z - a.z) * uz).toFixed(2),
      sideways: +((b.x - a.x) * -uz + (b.z - a.z) * ux).toFixed(2),
      startFeetY: +a.feetY.toFixed(3), maxFeetY: +maxFeet.toFixed(3), endFeetY: +b.feetY.toFixed(3), maxStepUp: +maxStepUp.toFixed(3),
    };
    beats.push(beat);
    console.log(JSON.stringify(beat));
    await page.screenshot({ path: join(OUT, `${tag}-spot${i}.png`) });
  }
  report.beats = beats;
} finally {
  writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
