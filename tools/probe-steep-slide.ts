/**
 * probe-steep-slide — live check for RECON.transition-stepup-stepdown-port.a.
 *
 * Retail: a player in contact with a terrain face it cannot stand on
 * (Normal.Z < FloorZ) is off a walkable, so the held keys move nothing
 * (CPhysicsObj::UpdatePositionInternal @ 00512c30) and gravity slides it down
 * the face until walkable ground (HitGround). The probe finds a long steep
 * descent near a hilly POI (the same scan as probe-terrain-edge-slide), then:
 *   idle      — teleports onto the face and records the slide;
 *   uphill    — teleports onto the face facing uphill and holds forward;
 *   jump-onto — jumps from the walkable edge out onto the face.
 *
 * Usage: npx tsx tools/probe-steep-slide.ts [poi=Linvak Tukal]   (dev server + bridge + ACE)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, telepoi, teleloc, adminCommand, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'recon-steep-slide');
mkdirSync(OUT, { recursive: true });
const poi = process.argv[2] ?? 'Linvak Tukal';
const FLOOR_Z = 0.66417414618662751;

type Candidate = { x: number; z: number; h: number; dx: number; dz: number; edgeAt: number; dropBeyond: number; faceNy: number };
type State = { x: number; z: number; feetY: number; onGround: boolean; sliding: boolean; animAirborne: boolean; slopeStuck: boolean };

const STATE_JS = '(() => window.acDebug.collisionState())()';
const { browser, page } = await enterWorld();
const report: Record<string, unknown> = { poi };
// Server position corrections (a snap mid-slide would show here).
const corrections: string[] = [];
page.on('console', (m) => { const t = m.text(); if (/Position correction|teleport/i.test(t)) corrections.push(t.slice(0, 300)); });
report.corrections = corrections;
try {
  await telepoi(page, poi);
  const me = await page.evaluate(STATE_JS) as State;
  const found = await page.evaluate(`(() => {
    const cx = ${me.x}, cz = ${me.z}, floorZ = ${FLOOR_Z};
    const dbg = window.acDebug;
    const h = (x, z) => dbg.floorAt(x, z).terrain;
    const ny = (x, z) => {
      const e = 0.05, a = h(x, z), b = h(x + e, z), c = h(x, z + e);
      if (a === null || b === null || c === null) return null;
      const gx = (b - a) / e, gz = (c - a) / e;
      return 1 / Math.sqrt(1 + gx * gx + gz * gz);
    };
    const out = [];
    for (let r = 8; r <= 160 && out.length < 40; r += 2) {
      for (let a = 0; a < 360; a += 4) {
        const x = cx + r * Math.cos(a * Math.PI / 180), z = cz + r * Math.sin(a * Math.PI / 180);
        const n0 = ny(x, z), h0 = h(x, z);
        if (n0 === null || h0 === null || n0 < 0.8) continue;
        const fl = dbg.floorAt(x, z, h0 + 1).outdoor;
        if (fl !== null && fl > h0 + 0.05) continue;
        for (let d = 0; d < 8; d++) {
          const dx = Math.cos(d * Math.PI / 4), dz = Math.sin(d * Math.PI / 4);
          let edgeAt = -1;
          for (let s = 0.25; s <= 3; s += 0.25) {
            const n = ny(x + dx * s, z + dz * s);
            if (n === null) break;
            if (n < floorZ) { edgeAt = s; break; }
          }
          if (edgeAt < 1) continue;
          // Steep all the way for 4 m past the edge.
          let steep = true;
          for (let s = edgeAt + 0.5; s <= edgeAt + 4; s += 0.5) {
            const n = ny(x + dx * s, z + dz * s);
            if (n === null || n >= floorZ - 0.03) { steep = false; break; }
          }
          if (!steep) continue;
          const he = h(x + dx * edgeAt, z + dz * edgeAt), hb = h(x + dx * (edgeAt + 4), z + dz * (edgeAt + 4));
          if (he - hb < 3) continue;
          out.push({ x, z, h: h0, dx, dz, edgeAt, dropBeyond: he - hb, faceNy: ny(x + dx * (edgeAt + 2), z + dz * (edgeAt + 2)) });
        }
      }
    }
    return out.sort((p, q) => q.dropBeyond - p.dropBeyond);
  })()`) as Candidate[];
  report.candidates = found.length;
  const c = found[0];
  if (!c) throw new Error(`no steep descent found near ${poi}`);
  report.spot = c;

  const loc = (x: number, z: number, y: number, dirX: number, dirZ: number): string => {
    const lbX = Math.floor(x / 192), lbY = Math.floor(z / 192);
    const lx = x - lbX * 192, ly = z - lbY * 192;
    const cell = ((lbX << 24) | (lbY << 16)) + Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1;
    const th = Math.atan2(-dirX, dirZ); // forward (−sinθ, cosθ) = (dirX, dirZ)
    return `0x${(cell >>> 0).toString(16).padStart(8, '0')} [${lx.toFixed(2)} ${ly.toFixed(2)} ${y.toFixed(2)}] ${Math.cos(th / 2).toFixed(4)} 0 0 ${Math.sin(th / 2).toFixed(4)}`;
  };
  const faceS = c.edgeAt + 1;
  const faceX = c.x + c.dx * faceS, faceZ = c.z + c.dz * faceS;
  const faceH = await page.evaluate(`window.acDebug.floorAt(${faceX}, ${faceZ}).terrain`) as number;
  report.face = { x: faceX, z: faceZ, h: faceH, loc: loc(faceX, faceZ, faceH + 0.1, c.dx, c.dz) };
  console.log(JSON.stringify(report.face));

  const beats: Record<string, unknown>[] = [];
  const run = async (label: string, where: string, act: () => Promise<void>, release: () => Promise<void>, settleMs = 1200) => {
    // A long slide ends in ACE's falling damage (handle_all_collisions reports
    // the environment collision on regaining a walkable; HandleFallingDamage
    // scales with the server's vertical velocity), so start each beat healed.
    await adminCommand(page, '@heal');
    await page.waitForTimeout(800);
    await teleloc(page, where, settleMs);
    const early: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      const s = await page.evaluate(STATE_JS) as State;
      early.push({ x: s.x, z: s.z, feetY: s.feetY, sliding: s.sliding, onGround: s.onGround });
      await page.waitForTimeout(60);
    }
    const a = await page.evaluate(STATE_JS) as State;
    const trace: Record<string, unknown>[] = [];
    await act();
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(250);
      const s = await page.evaluate(STATE_JS) as State;
      trace.push({
        t: (i + 1) * 0.25, downhill: (s.x - a.x) * c.dx + (s.z - a.z) * c.dz, feetY: s.feetY,
        onGround: s.onGround, sliding: s.sliding, animAirborne: s.animAirborne, stuck: s.slopeStuck,
      });
      if (i === 3) await page.screenshot({ path: join(OUT, `${label}-mid.png`) });
    }
    await release();
    const b = await page.evaluate(STATE_JS) as State;
    // A death (falling damage) sends the body to the lifestone: a jump of km.
    const teleportedAway = Math.hypot(b.x - a.x, b.z - a.z) > 100;
    const beat = {
      teleportedAway,
      beat: label, start: { feetY: a.feetY, sliding: a.sliding }, endFeetY: b.feetY, drop: a.feetY - b.feetY,
      downhill: (b.x - a.x) * c.dx + (b.z - a.z) * c.dz,
      endSliding: b.sliding, endAnimAirborne: b.animAirborne, early, trace,
    };
    beats.push(beat);
    console.log(JSON.stringify({ ...beat, trace: undefined }));
    await page.screenshot({ path: join(OUT, `${label}-end.png`) });
  };
  const noop = async () => {};
  await run('idle', loc(faceX, faceZ, faceH + 0.1, c.dx, c.dz), noop, noop);
  await run('uphill', loc(faceX, faceZ, faceH + 0.1, -c.dx, -c.dz),
    async () => { await page.keyboard.down('w'); }, async () => { await page.keyboard.up('w'); });
  // A running jump from 3 m behind the walkable spot, out over the edge.
  const backX = c.x - c.dx * 3, backZ = c.z - c.dz * 3;
  const backH = await page.evaluate(`window.acDebug.floorAt(${backX}, ${backZ}).terrain`) as number;
  await run('jump-onto', loc(backX, backZ, backH + 0.2, c.dx, c.dz), async () => {
    await page.keyboard.down('w');
    await page.waitForTimeout(300);
    await page.keyboard.down('Space');
    await page.waitForTimeout(500);
    await page.keyboard.up('Space');
    await page.waitForTimeout(600);
    await page.keyboard.up('w');
  }, noop, 4000);
  report.beats = beats;
} finally {
  writeFileSync(join(OUT, 'probe.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
