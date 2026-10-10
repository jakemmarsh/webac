/** CORE.17.q diagnostic — texel brightness under saturating light + viewer-light delta at the feet. */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'fs';
const OUT = '/home/user/acjs/verification/core17q';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe7';
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
  const WALL: [number, number, number, number] = [330, 330, 620, 520];
  const asis = { feet: await mean(page, FEET), wall: await mean(page, WALL) };
  // viewer light OFF
  await page.evaluate(() => { (window as any).__ac.viewerLight.intensity = 0; });
  await page.waitForTimeout(7000);
  const off = { feet: await mean(page, FEET), wall: await mean(page, WALL) };
  await page.screenshot({ path: OUT + '/probe7-viewerlight-off.png' });
  // viewer light ON again, x8
  await page.evaluate(() => { (window as any).__ac.viewerLight.intensity = 18; });
  await page.waitForTimeout(7000);
  const x8 = { feet: await mean(page, FEET), wall: await mean(page, WALL) };
  await page.evaluate(() => { (window as any).__ac.viewerLight.intensity = 2.25; });
  // saturating ambient: texel brightness
  const texel = await page.evaluate(`(() => { const ac = window.__ac; const a = ac.skybox.ambient; a.color.setRGB(1,1,1); a.intensity = 5;
    // floor material map mean
    let map = null; ac.sceneManager.scene.traverse((o) => { if (!map && o.isMesh && o.userData.cellGeometry && o.parent && o.parent.parent && o.parent.parent.name === 'dungeon_stream_8602' && o.parent.name === 'envcell_86020115' && o.material.map) map = o.material.map; });
    if (!map || !map.image) return { map: 'none' }; const im = map.image; const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const ctx = c.getContext('2d'); try { ctx.drawImage(im, 0, 0); } catch (e) { return { map: 'nodraw ' + e }; }
    const d = ctx.getImageData(0, 0, c.width, c.height).data; let r = 0, g = 0, b = 0; const n = d.length / 4; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return { map: [Math.round(r / n), Math.round(g / n), Math.round(b / n)], size: [im.width, im.height], colorSpace: map.colorSpace }; })()`);
  await page.waitForTimeout(7000);
  const full = { feet: await mean(page, FEET), wall: await mean(page, WALL) };
  await page.screenshot({ path: OUT + '/probe7-fulllight.png' });
  console.log(JSON.stringify({ asis, viewerOff: off, viewerX8: x8, fullLight: full, floorTexel: texel }, null, 1));
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
