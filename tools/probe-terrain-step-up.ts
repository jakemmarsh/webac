/**
 * probe-terrain-step-up — live check for RECON.transition-stepup-stepdown-port.c.a.
 *
 * Retail CTransition::step_up's step_down runs the land cell too
 * (CLandCell::find_env_collisions → OBJECTINFO::validate_walkable): outside
 * every EnvCell, a feet-sphere hit on a BSP with no walkable under the feet
 * lands on the terrain (lifting only a sphere embedded in it), then the
 * Placement insert decides. A riser with no walkable top is slid along. The
 * old code instead raised the body by StepUpHeight and stepped over anything
 * the raised body cleared.
 *
 * The probe arrives at a POI and scans bare-terrain spots (no BSP floor) for
 * 0.3 m moves in 16 directions through acDebug.probeMove from that spot. It
 * counts the moves a BSP hit stopped or slid, and the moves resolved by a
 * step up, split by where they land: a BSP floor, or the terrain (no BSP
 * floor at the destination; the old raised retest reported exactly
 * StepUpHeight there). Then it walks the player into the first few
 * terrain-landing spots holding W and records how far it got.
 *
 * Usage: npx tsx tools/probe-terrain-step-up.ts [poi=Holtburg] [--label after] [--replay before]
 *   --replay <label>: walk the spots that label's run walked (e.g. the old code's).
 *   (dev server + bridge + ACE). Writes verification/recon-terrain-step-up/<label>-<poi>.json + PNGs.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, telepoi, teleloc, adminCommand, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'recon-terrain-step-up');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const li = args.indexOf('--label');
const label = li > -1 ? args[li + 1] : 'after';
const ri = args.indexOf('--replay');
const replay = ri > -1 ? args[ri + 1] : null;
const poi = args.find((a, i) => !a.startsWith('--') && !['--label', '--replay'].includes(args[i - 1])) ?? 'Holtburg';
const tag = `${label}-${poi.replace(/\W+/g, '')}`;

type State = { x: number; z: number; feetY: number; lastFloor: number; outdoorStepUp: number };
type Hit = { x: number; z: number; ground: number; dx: number; dz: number; adjusted: [number, number]; stepUp: number; destFloor: number | null };
const STATE_JS = '(() => window.acDebug.collisionState())()';
const STEP = 0.3;

const { browser, page } = await enterWorld();
const report: Record<string, unknown> = { poi, label };
try {
  await telepoi(page, poi);
  await page.waitForTimeout(3000);
  const me = await page.evaluate(STATE_JS) as State;
  report.arrival = me;
  const scan = await page.evaluate(`(() => {
    const cx = ${me.x}, cz = ${me.z}, STEP = ${STEP};
    const dbg = window.acDebug;
    const hits = [];
    let tested = 0;
    for (let r = 2; r <= 80; r += 1.5) {
      for (let a = 0; a < 360; a += 6) {
        const x = cx + r * Math.cos(a * Math.PI / 180), z = cz + r * Math.sin(a * Math.PI / 180);
        const f = dbg.floorAt(x, z, ${me.lastFloor} + 3);
        if (f.terrain === null) continue;
        if (f.outdoor !== null && f.outdoor > f.terrain - 0.05) continue; // bare terrain only
        for (let d = 0; d < 16; d++) {
          const dx = Math.cos(d * Math.PI / 8) * STEP, dz = Math.sin(d * Math.PI / 8) * STEP;
          const m = dbg.probeMove(dx, dz, x, f.terrain, z);
          tested++;
          if (!m) continue;
          const moved = Math.hypot(m.adjusted[0] - dx, m.adjusted[1] - dz) > 1e-4;
          if (!moved && !(m.stepUp > 0)) continue;
          const dest = dbg.floorAt(x + m.adjusted[0], z + m.adjusted[1], f.terrain + 1.5);
          const destFloor = dest.outdoor !== null && dest.outdoor > (dest.terrain ?? -1e9) + 0.05 ? dest.outdoor : null;
          hits.push({ x, z, ground: f.terrain, dx, dz, adjusted: m.adjusted, stepUp: m.stepUp, destFloor });
        }
      }
    }
    return { tested, hits };
  })()`) as { tested: number; hits: Hit[] };
  const stepped = scan.hits.filter((h) => h.stepUp > 0);
  const onFloor = stepped.filter((h) => h.destFloor !== null);
  const onTerrain = stepped.filter((h) => h.destFloor === null);
  const stopped = scan.hits.filter((h) => !(h.stepUp > 0));
  const summary = {
    moves: scan.tested,
    collided: scan.hits.length,
    stoppedOrSlid: stopped.length,
    stepUpOntoBspFloor: onFloor.length,
    stepUpOntoTerrain: onTerrain.length,
    terrainStepUpsAtFullStepUpHeight: onTerrain.filter((h) => Math.abs(h.stepUp - 0.6) < 1e-3).length,
    terrainLiftMax: +Math.max(0, ...onTerrain.map((h) => h.stepUp)).toFixed(3),
  };
  report.summary = summary;
  report.terrainSteps = onTerrain.slice(0, 40);
  console.log(JSON.stringify(summary));

  // Walk into the first distinct terrain-landing spots (old code) / the same
  // spots on the new code, which the scan file of the other label names.
  const spots: Hit[] = [];
  const replayFile = replay ? join(OUT, `${replay}-${poi.replace(/\W+/g, '')}.json`) : null;
  if (replayFile && existsSync(replayFile)) {
    const prior = JSON.parse(readFileSync(replayFile, 'utf8')) as { beats?: { at: [number, number]; dir: [number, number]; scanStepUp: number }[] };
    for (const b of prior.beats ?? []) {
      const f = await page.evaluate(`window.acDebug.floorAt(${b.at[0]}, ${b.at[1]}, ${me.lastFloor} + 3)`) as { terrain: number | null };
      spots.push({ x: b.at[0], z: b.at[1], ground: f.terrain ?? me.lastFloor, dx: b.dir[0] * STEP, dz: b.dir[1] * STEP, adjusted: [0, 0], stepUp: b.scanStepUp, destFloor: null });
    }
  }
  const pool = spots.length ? [] : onTerrain.length ? onTerrain : stopped;
  for (const h of pool) {
    if (spots.length >= 4) break;
    if (spots.some((s) => Math.hypot(s.x - h.x, s.z - h.z) < 4)) continue;
    spots.push(h);
  }
  const loc = (x: number, z: number, y: number, dirX: number, dirZ: number): string => {
    const lbX = Math.floor(x / 192), lbY = Math.floor(z / 192);
    const lx = x - lbX * 192, ly = z - lbY * 192;
    const cell = ((lbX << 24) | (lbY << 16)) + Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1;
    const th = Math.atan2(-dirX, dirZ);
    return `0x${(cell >>> 0).toString(16).padStart(8, '0')} [${lx.toFixed(2)} ${ly.toFixed(2)} ${y.toFixed(2)}] ${Math.cos(th / 2).toFixed(4)} 0 0 ${Math.sin(th / 2).toFixed(4)}`;
  };
  const beats: Record<string, unknown>[] = [];
  for (const [i, h] of spots.entries()) {
    const ux = h.dx / STEP, uz = h.dz / STEP;
    // Start 1 m back from the scanned spot, facing along the scanned move.
    const sx = h.x - ux, sz = h.z - uz;
    await adminCommand(page, '@heal');
    await teleloc(page, loc(sx, sz, h.ground + 0.05, ux, uz), 2500);
    await page.waitForTimeout(1500);
    const a = await page.evaluate(STATE_JS) as State;
    let maxStepUp = 0;
    await page.keyboard.down('w');
    for (let k = 0; k < 10; k++) {
      await page.waitForTimeout(250);
      const s = await page.evaluate(STATE_JS) as State;
      maxStepUp = Math.max(maxStepUp, s.outdoorStepUp ?? 0);
    }
    await page.keyboard.up('w');
    await page.waitForTimeout(600);
    const b = await page.evaluate(STATE_JS) as State;
    const beat = {
      spot: i, at: [+h.x.toFixed(2), +h.z.toFixed(2)], dir: [+ux.toFixed(3), +uz.toFixed(3)],
      scanStepUp: +h.stepUp.toFixed(3),
      forward: +((b.x - a.x) * ux + (b.z - a.z) * uz).toFixed(2),
      sideways: +((b.x - a.x) * -uz + (b.z - a.z) * ux).toFixed(2),
      startFeetY: +a.feetY.toFixed(3), endFeetY: +b.feetY.toFixed(3), maxStepUp: +maxStepUp.toFixed(3),
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
