/** CORE.17.q diagnostic — every ambient/hemisphere/directional light in the scene + the live ambientLightColor uniform. */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'fs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe10';
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
  const info = await page.evaluate(`(() => { const ac = window.__ac; const s = ac.sceneManager.scene; const r = ac.sceneManager.renderer; const lights = [];
    s.traverse((o) => { if (o.isLight && !o.isPointLight) { const chain = []; let p = o; while (p) { chain.push(p.name || p.type); p = p.parent; } lights.push({ type: o.type, name: o.name, vis: o.visible, i: +o.intensity.toFixed(3), color: o.color.getHexString(), chain: chain.join(' < ') }); } });
    let floorMat = null; s.traverse((o) => { if (!floorMat && o.isMesh && o.userData.cellGeometry && o.parent && o.parent.name === 'envcell_86020115' && o.parent.parent && o.parent.parent.name === 'dungeon_stream_8602') floorMat = o.material; });
    const u = floorMat ? r.properties.get(floorMat).uniforms : null;
    const av = u && u.ambientLightColor ? u.ambientLightColor.value : null; const amb = av ? (Array.isArray(av) ? av.map((v) => +v.toFixed(3)) : (av.toArray ? av.toArray().map((v) => +v.toFixed(3)) : String(av))) : null;
    const scale = u && u.acAmbientScale ? u.acAmbientScale.value : null;
    const pls = u && u.pointLights && Array.isArray(u.pointLights.value) ? u.pointLights.value.map((p) => ({ color: p.color && p.color.toArray ? p.color.toArray().map((v) => +v.toFixed(2)) : String(p.color), distance: p.distance, decay: p.decay })) : null;
    return { lights, ambientLightColorUniform: amb, acAmbientScale: scale, pointLightUniforms: pls, useLegacyLights: r.useLegacyLights, outputColorSpace: r.outputColorSpace, toneMapping: r.toneMapping }; })()`);
  console.log(JSON.stringify(info, null, 1));
  const asis = await mean(page, FEET);
  await page.evaluate(() => { (window as any).__ac.viewerLight.intensity = 0; });
  await page.waitForTimeout(9000);
  const off = await mean(page, FEET);
  await page.evaluate(() => { (window as any).__ac.viewerLight.intensity = 2.25; });
  console.log(JSON.stringify({ asis, viewerOff: off }));
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
