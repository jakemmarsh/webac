/**
 * probe-terrain-edge-slide — live check for RECON.transition-stepup-stepdown-port.
 *
 * Retail CTransition::edge_slide @ 0050b3d0 / cliff_slide @ 0050a6d0: an
 * EdgeSlide player on walkable terrain cannot walk down onto an unwalkable
 * terrain face (Normal.Z < FloorZ); the step is slid along the crossing line
 * instead. The probe scans the terrain round a hilly POI for a walkable spot
 * whose forward direction drops onto such a face, teleports there facing it,
 * holds forward for 3 s, and records whether the feet went down the face.
 * Then it holds forward + strafe right to show the slide along the edge.
 *
 * Usage: npx tsx tools/probe-terrain-edge-slide.ts [poi=Linvak Tukal]   (dev server + bridge + ACE)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, telepoi, teleloc, collisionState, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'recon-terrain-edge-slide');
mkdirSync(OUT, { recursive: true });
const poi = process.argv[2] ?? 'Linvak Tukal';
const FLOOR_Z = 0.66417414618662751;

type Candidate = { x: number; z: number; h: number; dx: number; dz: number; edgeAt: number; dropBeyond: number; faceNy: number };

const { browser, page } = await enterWorld();
const report: Record<string, unknown> = { poi };
try {
  await telepoi(page, poi);
  const me = await collisionState(page) as unknown as { x: number; z: number; physicsState: number };
  report.playerPhysicsState = '0x' + (me.physicsState >>> 0).toString(16);
  report.edgeSlide = ((me.physicsState >>> 0) & 0x00400000) !== 0;
  // Scan in-page: terrain heights from acDebug.floorAt(x, z).terrain.
  // (A string, not a function: tsx's __name helper does not exist in the page.)
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
        if (fl !== null && fl > h0 + 0.05) continue; // a building floor
        for (let d = 0; d < 8; d++) {
          const dx = Math.cos(d * Math.PI / 4), dz = Math.sin(d * Math.PI / 4);
          // The first unwalkable sample within 3 m, then a long steep descent beyond it.
          let edgeAt = -1;
          for (let s = 0.25; s <= 3; s += 0.25) {
            const n = ny(x + dx * s, z + dz * s);
            if (n === null) break;
            if (n < floorZ) { edgeAt = s; break; }
          }
          if (edgeAt < 1) continue;
          const hb = h(x + dx * (edgeAt + 4), z + dz * (edgeAt + 4));
          const nb = ny(x + dx * (edgeAt + 2), z + dz * (edgeAt + 2));
          if (hb === null || nb === null || nb >= floorZ - 0.05) continue;
          const he = h(x + dx * edgeAt, z + dz * edgeAt);
          if (he - hb < 3) continue; // descending face
          out.push({ x, z, h: h0, dx, dz, edgeAt, dropBeyond: he - hb, faceNy: nb });
        }
      }
    }
    return out.sort((p, q) => q.dropBeyond - p.dropBeyond);
  })()`) as Candidate[];
  report.candidates = found.length;
  const c = found[0];
  if (!c) throw new Error(`no walkable-to-cliff edge found near ${poi}`);
  report.spot = c;
  const lbX = Math.floor(c.x / 192), lbY = Math.floor(c.z / 192);
  const lx = c.x - lbX * 192, ly = c.z - lbY * 192;
  const cell = ((lbX << 24) | (lbY << 16)) + Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1;
  // Heading θ about Z with forward (−sinθ, cosθ) = (dx, dz) in AC (x, y).
  const th = Math.atan2(-c.dx, c.dz);
  const beats: Record<string, unknown>[] = [];
  for (const [label, keys] of [['forward', ['w']], ['forward+strafe', ['w', 'c']]] as const) {
    await teleloc(page, `0x${(cell >>> 0).toString(16).padStart(8, '0')} [${lx.toFixed(2)} ${ly.toFixed(2)} ${(c.h + 0.2).toFixed(2)}] ${Math.cos(th / 2).toFixed(4)} 0 0 ${Math.sin(th / 2).toFixed(4)}`, 9000);
    const a = await collisionState(page) as unknown as { x: number; z: number; feetY: number; onGround: boolean };
    const trace: { t: number; along: number; feetY: number; onGround: boolean }[] = [];
    for (const k of keys) await page.keyboard.down(k);
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      const s = await collisionState(page) as unknown as { x: number; z: number; feetY: number; onGround: boolean };
      trace.push({ t: (i + 1) * 0.25, along: (s.x - a.x) * c.dx + (s.z - a.z) * c.dz, feetY: s.feetY, onGround: s.onGround });
    }
    for (const k of keys) await page.keyboard.up(k);
    await page.waitForTimeout(500);
    const b = await collisionState(page) as unknown as { x: number; z: number; feetY: number };
    const beat = {
      beat: label, startFeetY: a.feetY, endFeetY: b.feetY, drop: a.feetY - b.feetY,
      along: (b.x - a.x) * c.dx + (b.z - a.z) * c.dz,
      across: -(b.x - a.x) * c.dz + (b.z - a.z) * c.dx,
      moved: Math.hypot(b.x - a.x, b.z - a.z), edgeAt: c.edgeAt, trace,
    };
    beats.push(beat);
    console.log(JSON.stringify({ ...beat, trace: undefined }));
    await page.screenshot({ path: join(OUT, `edge-${label.replace('+', '-')}.png`) });
  }
  report.beats = beats;
} finally {
  writeFileSync(join(OUT, 'probe.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
