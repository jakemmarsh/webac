/**
 * probe-world-brightness — "the game randomly got way less bright (not night,
 * just dim)". Samples, every few seconds while idle and around UI events that
 * touch lighting (examine window with a 3D model, character panel paperdoll):
 * the mean luminance of a world patch of the canvas, the skybox time of day,
 * every scene light's type/intensity/visibility, renderer exposure / tone
 * mapping / output colour space, and the viewer light.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-world-brightness.ts
 */
import { enterWorld, adminCommand, shot } from './lib/game-session.js';
const OUT = 'verification/world-brightness';

const SAMPLE = `(() => { const ac = window.__ac; const sm = ac.sceneManager; const r = sm.renderer;
  const lights = []; sm.scene.traverse((o) => { if (o.isLight && o.visible && o.intensity > 0) lights.push(o.type[0] + ':' + o.intensity.toFixed(2)); });
  const counts = {}; for (const l of lights) counts[l] = (counts[l] || 0) + 1;
  return { tod: +(ac.skybox.currentTimeOfDay ?? -1).toFixed(3), exposure: r.toneMappingExposure, tone: r.toneMapping, cs: r.outputColorSpace,
    lights: Object.entries(counts).map(([k, v]) => k + 'x' + v).join(' '), viewer: ac.viewerLight.visible }; })()`;

async function luminance(page: import('playwright').Page): Promise<number> {
  const buf = await page.screenshot({ clip: { x: 200, y: 150, width: 400, height: 200 } });
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(buf);
  let sum = 0;
  for (let i = 0; i < png.data.length; i += 4) sum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
  return +(sum / (png.data.length / 4)).toFixed(1);
}

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'brightness' } as never);
  await s.page.waitForTimeout(5000);
  await adminCommand(s.page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
  await s.page.waitForTimeout(8000);
  const log = async (label: string) => console.log(label.padEnd(24), 'L=' + await luminance(s.page), JSON.stringify(await s.page.evaluate(SAMPLE)));
  for (let i = 0; i < 4; i++) { await log(`idle ${i * 5}s`); await s.page.waitForTimeout(5000); }
  await shot(s.page, `${OUT}/1-idle.png`);
  // Examine a creature (3D model preview) — select the nearest NPC, press E.
  await s.page.evaluate(`(() => { const ac = window.__ac; const cs = window.acDebug.collisionState(); let best = null;
    for (const o of ac.serverObjectManager.objects.values()) { if (!(o.itemType & 0x10) || !o.mesh || !o.mesh.visible || (o.objectDescFlags & 0x8) || o.guid === ac.charGuid) continue;
      const d = Math.hypot(o.worldX - cs.x, o.worldZ - cs.z); if (!best || d < best.d) best = { guid: o.guid, d }; }
    if (best) window.acDebug.select(best.guid); })()`);
  await s.page.keyboard.press('e');
  await s.page.waitForTimeout(3000);
  await log('examine NPC open');
  await s.page.evaluate('window.__ac.gameUI.hideExaminePanel()');
  await s.page.waitForTimeout(1500);
  await log('examine closed');
  // The character panel (paperdoll viewport).
  await s.page.click('#tb-inv').catch(() => {});
  await s.page.waitForTimeout(2500);
  await log('inventory open');
  await s.page.click('#tb-inv').catch(() => {});
  await s.page.waitForTimeout(1500);
  await log('inventory closed');
  for (let i = 0; i < 3; i++) { await s.page.waitForTimeout(5000); await log(`after ${(i + 1) * 5}s`); }
  await shot(s.page, `${OUT}/2-after.png`);
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
