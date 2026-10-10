/**
 * probe-sky-drifters — VISUAL.night-sky-vs-retail.a live check.
 *
 * Retail draws the always-on sky drifters (Setup 0x2000714 → emitters
 * 0x32000455/56/57) at the viewer landblock's origin + 250 m, and stamps each
 * particle with the landblock it was emitted in (GameSky::UpdatePosition
 * @ 00506dd0, CPhysicsObj::AddPartToShadowCells @ 00510e00). This probe
 * has the drifters born at Yaraq (day group pinned, sky set re-created),
 * goes to the Holtburg A/B spot at a night phase and reports where every live
 * drifter particle is relative to the viewer (still at Yaraq), then
 * re-creates the sky set at Holtburg and reports again (born at the
 * landblock origin + 250 m). Screenshots go to verification/night-sky/.
 *
 *   npx tsx tools/probe-sky-drifters.ts [--phase 0.994] [--day Sunny]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, enterWorld, teleloc, telepoi } from './lib/game-session.js';
import { HOLTBURG_SPOT, VIEWPORT } from './retail-ab-scenes.js';

const argv = process.argv.slice(2);
const phaseIdx = argv.indexOf('--phase');
const phase = phaseIdx >= 0 ? Number(argv[phaseIdx + 1]) : 0.994;
const dayIdx = argv.indexOf('--day');
/** The retail A/B night frame's day group (VISUAL.night-sky-vs-retail: Sunny, day 43638). */
const dayGroup = dayIdx >= 0 ? argv[dayIdx + 1] : 'Sunny';
const out = join(REPO, 'verification', 'night-sky');
mkdirSync(out, { recursive: true });

const REPORT_JS = `(() => {
  const ac = window.__ac;
  const cam = ac.sceneManager.camera.position;
  const rows = [];
  for (const s of ac.physicsScriptPlayer.skyEmitters) {
    const ps = [];
    for (let i = 0; i < s.activeCount; i++) {
      const p = s.positionAt(i);
      ps.push({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1),
        dist: +p.distanceTo(cam).toFixed(0), alpha: +s.alphaAt(i).toFixed(3), scale: +s.scaleAt(i).toFixed(2) });
    }
    rows.push({ name: s.object3D.name, drawn: s.drawnCount, pass: s.skyPassState, particles: ps });
  }
  return { camera: { x: +cam.x.toFixed(1), y: +cam.y.toFixed(1), z: +cam.z.toFixed(1),
    landblock: [Math.floor(cam.x / 192), Math.floor(cam.z / 192)] }, emitters: rows };
})()`;

async function main(): Promise<void> {
  // The retail A/B frame size, so frames line up with verification/retail-ab.
  const { browser, page } = await enterWorld({ viewport: { ...VIEWPORT } });
  const rebuild = 'window.__ac.skybox.rebuildSkyObjects(window.__ac.modelRenderer)';
  try {
    // 1) The drifters are born at Yaraq: pin the day group there and re-create
    //    the sky set (what a day-group change does: GameSky::
    //    CreateDeletePhysicsObjects), so every particle is stamped with Yaraq.
    await telepoi(page, 'yaraq', 20_000);
    await page.evaluate(`window.acDebug.pinDayGroup(${JSON.stringify(dayGroup)})`);
    await page.evaluate(rebuild);
    await page.waitForTimeout(2000);
    const yaraq = await page.evaluate(REPORT_JS);
    console.log('YARAQ-BORN', JSON.stringify(yaraq, null, 1));

    // 2) Holtburg at night: the Yaraq-born drifters are ~17 km away (beyond
    //    the sky pass's zfar × 4) — retail's A/B frames show no wash.
    await teleloc(page, HOLTBURG_SPOT.replace(/^@teleloc /, ''), 15_000);
    await page.evaluate(`window.acDebug.freezeTimeOfDay(${phase})`);
    await page.waitForTimeout(3000);
    const stranded = await page.evaluate(REPORT_JS);
    console.log('HOLTBURG', JSON.stringify(stranded, null, 1));
    await page.screenshot({ path: join(out, 'drifters-after-holtburg.png') });

    // 3) Re-created at Holtburg: the drifters are born in this landblock,
    //    at its origin + 250 m (not on the camera).
    await page.evaluate(rebuild);
    await page.evaluate(`window.acDebug.freezeTimeOfDay(${phase})`);
    await page.waitForTimeout(3000);
    const reborn = await page.evaluate(REPORT_JS);
    console.log('HOLTBURG-REBORN', JSON.stringify(reborn, null, 1));
    await page.screenshot({ path: join(out, 'drifters-after-holtburg-reborn.png') });
  } finally {
    await page.evaluate('window.acDebug.pinDayGroup(null)').catch(() => {});
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
