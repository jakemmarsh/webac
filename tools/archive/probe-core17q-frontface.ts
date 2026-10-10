/** CORE.17.q diagnostic — is gl_FrontFacing inverted (mirrored camera/root)? Floor lit with patch removed vs FrontSide. */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'fs';
const OUT = '/home/user/acjs/verification/core17q';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe9';
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
  const dets = await page.evaluate(`(() => { const ac = window.__ac; const cam = ac.sceneManager.camera; const s = ac.sceneManager.scene;
    let floor = null; s.traverse((o) => { if (!floor && o.isMesh && o.userData.cellGeometry && o.parent && o.parent.name === 'envcell_86020115' && o.parent.parent && o.parent.parent.name === 'dungeon_stream_8602') floor = o; });
    window.__floorGroup = floor ? floor.parent : null;
    return { camWorldDet: cam.matrixWorld.determinant(), camProjDet: cam.projectionMatrix.determinant(), camScale: cam.scale.toArray(), camParent: cam.parent ? cam.parent.type : null, sceneScale: s.scale.toArray(), floorGroupDet: floor ? floor.parent.matrixWorld.determinant() : null, floorMeshDet: floor ? floor.matrixWorld.determinant() : null, camProj: Array.from(cam.projectionMatrix.elements).map((v) => +v.toFixed(3)) }; })()`);
  console.log('dets', JSON.stringify(dets));
  // strong white test light at the player's head so any working path saturates the floor
  await page.evaluate(() => { const vl = (window as any).__ac.viewerLight; vl.intensity = 30; });
  await page.waitForTimeout(7000);
  const patched = await mean(page, FEET);
  // A: remove the patch on the cell group's materials (stock Lambert, still DoubleSide)
  await page.evaluate(`(() => { window.__floorGroup.traverse((o) => { if (o.isMesh && o.userData.cellGeometry) { o.material.onBeforeCompile = function () {}; o.material.customProgramCacheKey = () => 'stock'; o.material.needsUpdate = true; } }); })()`);
  await page.waitForTimeout(7000);
  const stockDouble = await mean(page, FEET);
  await page.screenshot({ path: OUT + '/probe9-stock-doubleside.png' });
  // B: stock Lambert, FrontSide
  await page.evaluate(`(() => { window.__floorGroup.traverse((o) => { if (o.isMesh && o.userData.cellGeometry) { o.material.side = 0; o.material.needsUpdate = true; } }); })()`);
  await page.waitForTimeout(7000);
  const stockFront = await mean(page, FEET);
  await page.screenshot({ path: OUT + '/probe9-stock-frontside.png' });
  // C: stock Lambert, BackSide
  await page.evaluate(`(() => { window.__floorGroup.traverse((o) => { if (o.isMesh && o.userData.cellGeometry) { o.material.side = 1; o.material.needsUpdate = true; } }); })()`);
  await page.waitForTimeout(7000);
  const stockBack = await mean(page, FEET);
  await page.screenshot({ path: OUT + '/probe9-stock-backside.png' });
  console.log(JSON.stringify({ patchedDouble_x30: patched, stockDouble_x30: stockDouble, stockFront_x30: stockFront, stockBack_x30: stockBack }));
  await page.evaluate(() => { (window as any).__ac.viewerLight.intensity = 2.25; (window as any).acDebug?.freezeTimeOfDay?.(null); });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
