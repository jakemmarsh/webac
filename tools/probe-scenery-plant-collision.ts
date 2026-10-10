/**
 * probe-scenery-plant-collision — live check for BUG.scenery-plant-barriers
 * ("bushes/plants seem like they have invisible barriers" near Holtburg).
 *
 * For each target scenery placement (block-local AC coords from the DAT
 * scenery generator), @teleloc the player 5 m south of it facing north, hold
 * W for a few seconds and record where the body stops: the closest approach
 * to the plant's centre, and every outdoor-collision obstacle (cylinder /
 * sphere / BSP cell) within 4 m of the stop point. Screenshots per target.
 *
 * Usage: AC_BASE=http://localhost:3000/ AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 \
 *        npx tsx tools/probe-scenery-plant-collision.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, collisionState, enterWorld, sessionArgs, shot, teleloc } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'scenery-plant-barriers');

interface Target { label: string; block: number; x: number; y: number; z: number }
/** Placements from the DAT scenery generator (block-local AC metres). */
const TARGETS: Target[] = [
  // DAT: Sphere r 0.961 at z 0.961 around six fern parts — solid in retail.
  { label: 'ferns-0x02001064-sphere', block: 0xaab4, x: 162.79, y: 161.68, z: 28.87 },
  // DAT: no physics BSP, cylsphere or sphere — walk-through in retail.
  { label: 'bush-0x020002f2-none', block: 0xa8b4, x: 26.57, y: 153.36, z: 29.43 },
  { label: 'bush-0x020007a2-none', block: 0xa8b5, x: 183.78, y: 53.64, z: 28.0 },
  { label: 'plant-0x020002f5-none', block: 0xa9b5, x: 5.19, y: 46.14, z: 28.43 },
  { label: 'tree-0x02000240-none', block: 0xa8b5, x: 163.57, y: 80.76, z: 28.0 },
  { label: 'ferns-0x02001063-none', block: 0xa9b3, x: 43.26, y: 14.22, z: 94.0 },
  // DAT: CylSphere — solid in retail.
  { label: 'tree-0x02000246-cylsphere', block: 0xa8b4, x: 9.67, y: 37.20, z: 32.81 },
  // Landblock statics (LandblockInfo.objects) around Holtburg: standing stones, a fence post.
  { label: 'stone-0x02000374-cylsphere', block: 0xa9b3, x: 11.48, y: 148.26, z: 94.01 },
  { label: 'stone-0x02000375-cylsphere', block: 0xa9b3, x: 11.61, y: 153.51, z: 94.01 },
  { label: 'fencepost-0x010007c4-bsp', block: 0xa9b4, x: 105.9, y: 155.59, z: 66.5 },
];

const cellOf = (t: Target, x: number, y: number): string =>
  '0x' + (((t.block << 16) | (Math.floor(x / 24) * 8 + Math.floor(y / 24) + 1)) >>> 0).toString(16).toUpperCase().padStart(8, '0');

const NEAR = (x: number, z: number) => `(() => {
  const oc = window.__ac.outdoorCollision;
  const out = [];
  for (const [k, c] of oc.cylinders) { const d = Math.hypot(c.x - ${x}, c.z - ${z}); if (d < 4) out.push({ kind: 'cyl', key: String(k), r: +c.radius.toFixed(2), bottom: +c.bottomY.toFixed(2), top: +c.topY.toFixed(2), d: +d.toFixed(2) }); }
  for (const [k, s] of oc.spheres) { const d = Math.hypot(s.x - ${x}, s.z - ${z}); if (d < 4) out.push({ kind: 'sph', key: String(k), r: +s.radius.toFixed(2), y: +s.y.toFixed(2), d: +d.toFixed(2) }); }
  return out;
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const log: string[] = [];
  const say = (s: string) => { console.log(s); log.push(s); };
  const { browser, page } = await enterWorld({ ...sessionArgs(), cb: 'plantbar', createCharacter: process.env.AC_CREATE_CHAR, viewport: { width: 1280, height: 800 }, timeoutMs: 300_000 });
  await page.waitForTimeout(6000);
  for (const t of TARGETS) {
    const sx = t.x, sy = t.y - 5;
    await teleloc(page, `${cellOf(t, sx, sy)} [${sx.toFixed(2)} ${sy.toFixed(2)} ${(t.z + 1).toFixed(2)}] 1 0 0 0`, 15_000);
    const wx = (t.block >> 8) * 192 + t.x, wz = (t.block & 0xff) * 192 + t.y;
    const start = await collisionState(page);
    say(`${t.label}: start (${start.x.toFixed(2)}, ${start.z.toFixed(2)}) → plant (${wx.toFixed(2)}, ${wz.toFixed(2)})`);
    // Face the plant (yaw from the arrival heading: aim the run at it).
    await page.evaluate(`(() => { const cc = window.__ac.cameraController; const cs = window.acDebug.collisionState();
      const dx = ${wx} - cs.x, dz = ${wz} - cs.z; cc.playerYaw = Math.atan2(-dx, -dz); })()`);
    await page.waitForTimeout(500);
    await page.evaluate(`window.__ac.cameraController.simulateKeyDown('KeyW')`);
    let best = Infinity; let stop = start;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      const p = await collisionState(page);
      best = Math.min(best, Math.hypot(p.x - wx, p.z - wz));
      stop = p;
      if (Math.hypot(p.x - wx, p.z - wz) > best + 1.5) break; // ran through and past
    }
    await page.evaluate(`window.__ac.cameraController.simulateKeyUp('KeyW')`);
    await shot(page, join(OUT, `${t.label}-after.png`));
    say(`  closest approach to centre ${best.toFixed(2)} m; stopped at (${stop.x.toFixed(2)}, ${stop.z.toFixed(2)})`);
    say(`  obstacles near plant: ${JSON.stringify(await page.evaluate(NEAR(wx, wz)))}`);
  }
  writeFileSync(join(OUT, 'probe.log'), log.join('\n') + '\n');
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
