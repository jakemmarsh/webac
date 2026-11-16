/**
 * probe-stream-geometry-leak — GPU resource counts across streaming in and out
 * (PERF.cell-surface-merge / PERF.override-material-share, 2026-11-16,
 * docs/perf-pass-2026-11-15.md). Teleports round a loop of places LOOPS times,
 * running the resource sweep at each stop, and prints renderer.info.memory
 * (geometries, textures), live programs and the scene's cell-geometry meshes.
 * The counts at the same stop must not climb from loop to loop.
 * Usage (env): AC_URL; STOPS (|-separated teleports; default academy hall | Holtburg | Holtburg interior);
 *   LOOPS=3; SETTLE_MS=20000.   npx tsx tools/probe-stream-geometry-leak.ts
 */
import { adminCommand, enterWorld } from './lib/game-session.ts';

const STOPS = (process.env.STOPS ?? '@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0|@telepoi Holtburg|@teleloc 0xA9B4016A [77.4 36.2 94.01] 1 0 0 0').split('|');
const LOOPS = Number(process.env.LOOPS ?? 3);
const SETTLE = Number(process.env.SETTLE_MS ?? 20000);
const { browser, page } = await enterWorld({ gpu: true, timeoutMs: 420000 });
for (let loop = 0; loop < LOOPS; loop++) {
  for (const stop of STOPS) {
    await adminCommand(page, stop);
    await page.waitForTimeout(SETTLE);
    const r = await page.evaluate(`(() => {
      const ac = window.__ac; const sweep = ac.sweepUnusedResources ? ac.sweepUnusedResources() : null;
      const info = ac.sceneManager.renderer.info;
      let cellMeshes = 0, cellGroups = 0; ac.sceneManager.scene.traverse((o) => { if (o.userData.cellGeometry) cellMeshes++; if (o.name && o.name.startsWith('envcell_')) cellGroups++; });
      return { geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs ? info.programs.length : null, cellGroups, cellMeshes, swept: sweep };
    })()`);
    console.log(`LOOP ${loop} ${stop.slice(0, 40)} ${JSON.stringify(r)}`);
  }
}
await browser.close();
