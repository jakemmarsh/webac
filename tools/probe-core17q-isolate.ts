/** CORE.17.q diagnostic — isolate what lights the patched floor: hide the sky ambient, toggle the viewer light, emissive tint. */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'fs';
const OUT = '/home/user/acjs/verification/core17q';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe11';
async function inWorld(page: Page) { return page.evaluate(() => { const cs = (window as any).acDebug?.collisionState?.(); return !!(cs && cs.x > 0); }); }
async function mean(page: Page, box: [number, number, number, number]) {
  const buf = await page.screenshot({ clip: { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] } });
  return page.evaluate(async (b64) => { const im = new Image(); await new Promise((r) => { im.onload = r; im.src = 'data:image/png;base64,' + b64; }); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const ctx = c.getContext('2d')!; ctx.drawImage(im, 0, 0); const d = ctx.getImageData(0, 0, c.width, c.height).data; let r = 0, g = 0, b = 0; const n = d.length / 4; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; } return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]; }, buf.toString('base64'));
}
async function main() {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'], ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000); page.on('dialog', (d) => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000; let lastReload = Date.now();
  while (Date.now() < deadline) { if (await inWorld(page)) break; if (Date.now() - lastReload > 60_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); } await page.waitForTimeout(3000); }
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(6000);
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0');
  await page.waitForTimeout(4000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.waitForTimeout(8000);
  const FEET: [number, number, number, number] = [640, 600, 930, 700];
  const LEFTFLOOR: [number, number, number, number] = [300, 600, 600, 700];
  const step = async (label: string, js: string) => { await page.evaluate(js); await page.waitForTimeout(8000); const m = { feet: await mean(page, FEET), leftFloor: await mean(page, LEFTFLOOR) }; console.log(label, JSON.stringify(m)); return m; };
  await step('asis', '0');
  await step('skyAmbientHidden_viewer2.25', '(() => { window.__ac.skybox.ambient.visible = false; })()');
  await step('skyAmbientHidden_viewer0', '(() => { window.__ac.viewerLight.intensity = 0; })()');
  await page.screenshot({ path: OUT + '/probe11-noambient-noviewer.png' });
  await step('skyAmbientHidden_viewer0_datLightsOff', '(() => { window.__ac.sceneManager.scene.traverse((o) => { if (o.isPointLight && o.userData.datLight) o.visible = false; }); window.__ac.datLightBudget.update = () => {}; })()');
  await page.screenshot({ path: OUT + '/probe11-nolights.png' });
  await step('emissiveRedOnFloorCell', '(() => { window.__ac.sceneManager.scene.traverse((o) => { if (o.isMesh && o.userData.cellGeometry && o.parent && o.parent.name === "envcell_86020115" && o.parent.parent && o.parent.parent.name === "dungeon_stream_8602") { o.material.emissive.setHex(0xff0000); } }); })()');
  await page.screenshot({ path: OUT + '/probe11-emissive.png' });
  await page.evaluate(() => { const ac = (window as any).__ac; ac.skybox.ambient.visible = true; ac.viewerLight.intensity = 2.25; (window as any).acDebug?.freezeTimeOfDay?.(null); });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
