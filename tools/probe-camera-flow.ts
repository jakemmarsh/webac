/**
 * probe-camera-flow — scorecard flow-camera live walk: at the
 * retail-holtburg.png spot/heading (1600x900), press each candidate camera
 * key and record the camera state it leaves (boom, pitch, first person),
 * plus a middle-button mouse-look drag and a zoomed-out boom in a dungeon
 * corridor (camera collision). Screens: verification/camera-flow/.
 *
 *   npx tsx tools/probe-camera-flow.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, adminCommand, REPO } from './lib/game-session.js';

const OUT = `${REPO}/verification/camera-flow`;
const KEYS = ['PageUp', 'PageDown', 'Insert', 'Delete', 'Home', 'End', 'NumpadAdd', 'NumpadSubtract', 'Numpad8', 'Numpad2', 'Numpad4', 'Numpad6', 'Numpad5', 'Numpad0', 'NumpadDecimal', 'NumpadDivide', 'F2'];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'camera-flow', viewport: { width: 1600, height: 900 } } as never);
  const { page } = s;
  await adminCommand(page, '@teleloc 0xA9B40019 [84.3 5.0 94] 0.9969 0 0 -0.0785');
  await page.waitForTimeout(20000);
  const cam = (): Promise<Record<string, number | boolean>> => page.evaluate(`(() => {
    const cc = window.__ac.cameraController, cam = window.__ac.sceneManager.camera, cs = window.acDebug.collisionState();
    const r = (v) => +(+v).toFixed(2);
    return { boom: r(cc.cameraDistance), pitchDeg: r(cc.viewPitch * 180 / Math.PI), orbitDeg: r(cc.cameraYawOffset * 180 / Math.PI), lookPitchDeg: r(cc.pitch * 180 / Math.PI),
      inHead: !!cc.inHead, camUp: r(cam.position.y - cs.feetY), camBack: r(Math.hypot(cam.position.x - cs.x, cam.position.z - cs.z)) };
  })()`) as Promise<Record<string, number | boolean>>;
  const out: Record<string, unknown> = {};
  await page.mouse.click(800, 350);
  out.default = await cam();
  await page.screenshot({ path: `${OUT}/default.png` });
  for (const k of KEYS) {
    await page.keyboard.down(k); await page.waitForTimeout(500); await page.keyboard.up(k);
    await page.waitForTimeout(400);
    out[k] = await cam();
    if (k === 'PageUp' || k === 'F2') await page.screenshot({ path: `${OUT}/after-${k}.png` });
    await page.evaluate('window.__ac.cameraController.resetZoom()');
    await page.waitForTimeout(600);
  }
  // Middle-button drag = retail's hold-to-mouse-look.
  await page.mouse.move(800, 400); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(950, 380, { steps: 10 }); await page.waitForTimeout(300);
  out.middleDrag = await cam();
  await page.screenshot({ path: `${OUT}/middle-drag.png` });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(500);
  out.afterMiddleUp = await cam();
  // Collision: in a dungeon corridor the zoomed-out boom must stay inside the walls.
  await adminCommand(page, '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0');
  await page.waitForTimeout(20000);
  await page.mouse.click(800, 350);
  out.dungeonDefault = await cam();
  await page.screenshot({ path: `${OUT}/dungeon-default.png` });
  await page.keyboard.down('NumpadAdd'); await page.waitForTimeout(1500); await page.keyboard.up('NumpadAdd');
  await page.waitForTimeout(800);
  out.dungeonZoomOut = await cam();
  await page.screenshot({ path: `${OUT}/dungeon-zoomed-out.png` });
  await page.evaluate('window.__ac.cameraController.resetZoom()');
  writeFileSync(`${OUT}/state.json`, JSON.stringify(out, null, 1));
  for (const [k, v] of Object.entries(out)) console.log(k.padEnd(15), JSON.stringify(v));
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
