/**
 * probe-undrawn-obstacles — live audit for BUG.scenery-plant-barriers: an
 * "invisible barrier" is an outdoor collision obstacle (scenery / landblock
 * static CylSphere or Sphere) with nothing drawn at its position. At each spot,
 * lists every obstacle within 60 m of the player that has no visible drawn
 * instance/mesh origin within 1 m (x/z) of it.
 *
 * Usage: AC_BASE=http://localhost:3000/ AC_ACCOUNT=… AC_PASSWORD=… npx tsx tools/probe-undrawn-obstacles.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, enterWorld, sessionArgs, shot, teleloc, telepoi } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'scenery-plant-barriers');

const AUDIT = `(() => {
  const ac = window.__ac; const oc = ac.outdoorCollision; const cs = window.acDebug.collisionState();
  const M = ac.sceneManager.camera.matrixWorld.constructor; const V = ac.sceneManager.camera.position.constructor;
  const drawn = []; const m4 = new M(); const p = new V();
  ac.sceneManager.scene.traverse((o) => {
    if (!o.visible) return;
    let v = o; while (v) { if (!v.visible) return; v = v.parent; }
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m4); p.setFromMatrixPosition(m4); p.applyMatrix4(o.matrixWorld);
        if (Math.hypot(p.x - cs.x, p.z - cs.z) < 70) drawn.push([p.x, p.z, o.name]); }
    } else if (o.isMesh) { o.getWorldPosition(p); if (Math.hypot(p.x - cs.x, p.z - cs.z) < 70) drawn.push([p.x, p.z, o.name]); }
  });
  const undrawn = []; let total = 0;
  const check = (kind, k, x, z, r) => {
    if (Math.hypot(x - cs.x, z - cs.z) > 60) return; total++;
    const hit = drawn.find(d => Math.hypot(d[0] - x, d[1] - z) < 1.0);
    if (!hit) undrawn.push({ kind, key: String(k), x: +x.toFixed(2), z: +z.toFixed(2), r: +r.toFixed(2) });
  };
  for (const [k, c] of oc.cylinders) check('cyl', k, c.x, c.z, c.radius);
  for (const [k, s] of oc.spheres) check('sph', k, s.x, s.z, s.radius);
  return { at: [cs.x, cs.z], total, undrawn };
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const log: string[] = [];
  const say = (s: string) => { console.log(s); log.push(s); };
  const { browser, page } = await enterWorld({ ...sessionArgs(), cb: 'undrawn', viewport: { width: 1280, height: 800 }, timeoutMs: 300_000 });
  await page.waitForTimeout(6000);
  const spots: [string, () => Promise<void>][] = [
    ['holtburg-poi', () => telepoi(page, 'Holtburg', 20_000)],
    ['a8b4-fields', () => teleloc(page, '0xA8B40002 [9.67 32.2 34] 1 0 0 0', 20_000)],
    ['a9b3-slope', () => teleloc(page, '0xA9B3000C [34.9 70 95] 1 0 0 0', 20_000)],
    // Small tree 0x020002D3 at scale 0.34 (A9B3 placement #3) — its cylsphere
    // had no drawn instance within 1 m when audited from 56 m away.
    ['a9b3-small-tree', () => teleloc(page, '0xA9B30001 [9.42 15.3 93] 1 0 0 0', 20_000)],
    ['aab4-ferns', () => teleloc(page, '0xAAB4003F [162.8 156.7 30] 1 0 0 0', 20_000)],
  ];
  for (const [label, go] of spots) {
    await go();
    const r = await page.evaluate(AUDIT) as { at: number[]; total: number; undrawn: unknown[] };
    say(`${label}: at (${r.at.map(v => v.toFixed(1)).join(', ')}) obstacles ${r.total}, undrawn ${r.undrawn.length}`);
    for (const u of r.undrawn) say(`  ${JSON.stringify(u)}`);
    await shot(page, join(OUT, `undrawn-${label}.png`));
  }
  writeFileSync(join(OUT, 'undrawn.log'), log.join('\n') + '\n');
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
