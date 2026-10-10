/**
 * probe-water-landscape — live check for BUG.watersurface-plane-shows-through-sea-level-land:
 * @telepoi Beach Fort, confirm no sea-level plane object exists in the scene
 * and capture the shore (retail: water is the landscape mesh, opaque DAT
 * water terrain textures, no plane — LandSurf::SelectTerrain @00503070).
 * Usage: npx tsx tools/probe-water-landscape.ts  (vite :3000 + bridge :9090 + ACE)
 */
import { join } from 'node:path';
import { REPO, openSession, gameUrl, sessionArgs, shot, telepoi, waitForWorld } from './lib/game-session.js';
const OUT = join(REPO, 'verification', 'water-landscape');
async function main(): Promise<void> {
  const { browser, page } = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await page.goto(gameUrl({ cb: 'water' }), { waitUntil: 'domcontentloaded' });
  // Proceeds after the timeout even when the world never came up (the probe's original behaviour).
  await waitForWorld(page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await page.waitForTimeout(6000);
  for (const [poi, file] of [['Beach Fort', 'beach-fort'], ['Holtburg', 'holtburg']] as const) {
    await telepoi(page, poi, 22_000);
    const r = await page.evaluate(`(() => { let planes = 0, translucentTerrain = 0; window.__ac.sceneManager.scene.traverse((o) => {
        if (/water/i.test(o.name || '')) planes++;
      }); const cs = window.acDebug.collisionState(); return { planes, pos: [Math.round(cs.x), Math.round(cs.feetY), Math.round(cs.z)], waterHere: window.__ac.waterMap.cellWaterTypeAt(cs.x, cs.z) }; })()`);
    console.log(`${poi}: ${JSON.stringify(r)}`);
    await shot(page, join(OUT, `${file}.png`));
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
