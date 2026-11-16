/**
 * probe-ray-grid-check — live check for PERF.ray-grid (2026-11-15,
 * docs/perf-pass-2026-11-15.md). While the character runs (outdoors at
 * Holtburg, then in the Holtburg academy hall), every DungeonCollision render-
 * mesh cast (the camera boom each frame, the ray fallbacks) is answered both
 * ways: through StaticRayGrid and through the old linear rayCandidates pass,
 * and the two hit lists (distance, point, object, face, instance) are compared.
 * Prints casts / grid casts / mismatches per stop; any mismatch is a failure
 * (exit 1). Also times each path over the same casts. Needs the Vite dev server
 * (it imports /src/world/RaycastBroadPhase.ts).
 * Usage (env): AC_URL as tools/lib/game-session.ts; STOPS='@telepoi Holtburg|@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0'
 *   npx tsx tools/probe-ray-grid-check.ts
 */
import { adminCommand, enterWorld } from './lib/game-session.ts';

const STOPS = (process.env.STOPS ?? '@telepoi Holtburg|@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0').split('|');
const { browser, page } = await enterWorld({ gpu: true, timeoutMs: 420000 });
let failed = false;
for (const stop of STOPS) {
  await adminCommand(page, stop);
  await page.waitForTimeout(25000);
  await page.mouse.click(780, 250);
  await page.evaluate(`(async () => {
    const B = await import('/src/world/RaycastBroadPhase.ts');
    const key = (h) => [h.distance, h.point.x, h.point.y, h.point.z, h.object.uuid, h.faceIndex, h.instanceId].join('|');
    window.__rg = { casts: 0, grid: 0, mismatches: 0, samples: [], gridMs: 0, linearMs: 0, hits: 0 };
    for (const dc of [window.__ac.outdoorCollision, window.__ac.dungeonCollision]) {
      if (!dc || dc.__rgHooked) continue; dc.__rgHooked = true;
      const scratch = [];
      const linear = () => {
        const meshes = B.rayCandidates(dc.renderMeshes, dc.raycaster, scratch);
        const restore = [];
        for (const mesh of meshes) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m.side !== 2) { restore.push([m, m.side]); m.side = 2; }
        try { return dc.raycaster.intersectObjects(meshes, false); } finally { for (const [m, s] of restore) m.side = s; meshes.length = 0; }
      };
      const orig = dc.intersectRenderMeshes.bind(dc);
      dc.intersectRenderMeshes = () => {
        const st = window.__rg; const g0 = dc.rayGrid.gridCasts;
        const t0 = performance.now(); const a = orig(); const t1 = performance.now(); const b = linear(); const t2 = performance.now();
        st.casts++; if (dc.rayGrid.gridCasts > g0) st.grid++; st.gridMs += t1 - t0; st.linearMs += t2 - t1; st.hits += a.length;
        const ka = a.map(key).join(','), kb = b.map(key).join(',');
        if (ka !== kb) { st.mismatches++; if (st.samples.length < 5) st.samples.push({ grid: a.length, linear: b.length, far: dc.raycaster.far }); }
        return a;
      };
    }
  })()`);
  await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD');
  await page.waitForTimeout(8000);
  await page.keyboard.up('KeyD');
  for (const yaw of [0, 90, 180, 270]) { await page.evaluate(`window.acDebug.setPlayerYaw(${yaw * Math.PI / 180})`); await page.waitForTimeout(4000); }
  await page.keyboard.up('KeyW');
  const st = await page.evaluate('window.__rg') as { casts: number; grid: number; mismatches: number; samples: unknown[]; gridMs: number; linearMs: number; hits: number };
  console.log(`${stop}: casts ${st.casts}, through the grid ${st.grid}, hits ${st.hits}, mismatches ${st.mismatches} ${JSON.stringify(st.samples)}; grid ${(st.gridMs / Math.max(1, st.casts) * 1000).toFixed(0)} µs/cast vs linear ${(st.linearMs / Math.max(1, st.casts) * 1000).toFixed(0)} µs/cast (unthrottled)`);
  if (st.mismatches > 0 || st.casts === 0) failed = true;
}
await browser.close();
process.exit(failed ? 1 : 0);
