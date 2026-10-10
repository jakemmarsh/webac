/**
 * CORE.17.q.c diagnostic — does the Holtburg Dungeon (0x01F6, the tan cobble
 * set of rawg_04 / rawg_09: wall 0x0800016f, beams 0x08000176, 157 lit stabs)
 * show a lighting delta where the Training Academy cave could not? Lands on
 * the portal's own drop point (world DB portalholtburgdungeon → 0x01F60289
 * (96.7, -10, 0)), pins noon, then samples region means as-is / at night /
 * with the DAT torches off / with the viewer light + sky ambient off.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const OUT = '/home/user/acjs/verification/core17qc';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=qc' + Date.now();
const TELEPORT = '@teleloc 0x01F60289 [96.7 -10 0] -0.719 0 0 -0.695';
async function inWorld(page: Page) { return page.evaluate(() => { const cs = (window as any).acDebug?.collisionState?.(); return !!(cs && cs.x > 0); }); }
async function mean(page: Page, box: [number, number, number, number]) {
  const buf = await page.screenshot({ clip: { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] } });
  return page.evaluate(async (b64) => { const im = new Image(); await new Promise((r) => { im.onload = r; im.src = 'data:image/png;base64,' + b64; }); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const ctx = c.getContext('2d')!; ctx.drawImage(im, 0, 0); const d = ctx.getImageData(0, 0, c.width, c.height).data; let r = 0, g = 0, b = 0; const n = d.length / 4; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; } return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]; }, buf.toString('base64'));
}
async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'], ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000); page.on('dialog', (d) => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (Date.now() < deadline) { if (await inWorld(page)) break; if (Date.now() - lastReload > 60_000) { try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch {} lastReload = Date.now(); } await page.waitForTimeout(3000); }
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(6000);
  const r = await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), TELEPORT);
  console.log('teleloc:', JSON.stringify(r));
  await page.waitForTimeout(5000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.waitForTimeout(12000);
  const where = await page.evaluate(() => { const d = (window as any).acDebug; return { cs: d?.collisionState?.(), cell: d?.currentCell?.() ?? d?.playerCell?.() }; });
  console.log('where:', JSON.stringify(where));
  const lights = await page.evaluate(() => { let n = 0, vis = 0; (window as any).__ac.sceneManager.scene.traverse((o: any) => { if (o.isPointLight && o.userData.datLight) { n++; if (o.visible) vis++; } }); return { datPointLights: n, visible: vis }; });
  console.log('lights:', JSON.stringify(lights));
  const BOXES: Record<string, [number, number, number, number]> = { feet: [640, 600, 930, 700], leftWall: [80, 200, 380, 420], rightWall: [1180, 200, 1480, 420], farCentre: [640, 250, 930, 420], floorLeft: [300, 600, 600, 700] };
  const results: Record<string, Record<string, number[]>> = {};
  const step = async (label: string, js: string, shot?: string) => { await page.evaluate(js); await page.waitForTimeout(8000); const m: Record<string, number[]> = {}; for (const [k, b] of Object.entries(BOXES)) m[k] = await mean(page, b); results[label] = m; console.log(label, JSON.stringify(m)); if (shot) await page.screenshot({ path: `${OUT}/${shot}.png` }); };
  for (const [name, yaw] of [['yaw0', 0], ['yaw1', 1.6], ['yaw2', 3.2], ['yaw3', 4.8]] as [string, number][]) { await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), yaw); await page.waitForTimeout(2500); await page.screenshot({ path: `${OUT}/probe-${name}.png` }); }
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await step('noon_asis', '0', 'probe-noon');
  await step('night', '(() => { window.acDebug.freezeTimeOfDay(0.0); })()', 'probe-night');
  await step('noon_skyAmbientHidden', '(() => { window.acDebug.freezeTimeOfDay(0.5); window.__ac.skybox.ambient.visible = false; })()');
  await step('noon_skyAmbientHidden_viewer0', '(() => { window.__ac.viewerLight.intensity = 0; })()', 'probe-noambient-noviewer');
  await step('noon_datLightsOff_only', '(() => { window.__ac.skybox.ambient.visible = true; window.__ac.viewerLight.intensity = 2.25; window.__ac.sceneManager.scene.traverse((o) => { if (o.isPointLight && o.userData.datLight) o.visible = false; }); window.__ac.datLightBudget.update = () => {}; })()', 'probe-nolights');
  writeFileSync(`${OUT}/probe-samples.json`, JSON.stringify({ teleport: TELEPORT, where, lights, boxes: BOXES, results }, null, 2));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
