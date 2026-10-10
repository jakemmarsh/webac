import { chromium, type Page } from 'playwright';
import { existsSync } from 'fs';
const OUT = '/home/user/acjs/verification/core17q';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe2';
async function inWorld(page: Page) { return page.evaluate(() => { const cs = (window as any).acDebug?.collisionState?.(); return !!(cs && cs.x > 0); }); }
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
  // 1. winding vs stored-normal agreement over the visible cell meshes
  const stats = await page.evaluate(`(() => {
    const scene = window.__ac.sceneManager.scene; let agree = 0, disagree = 0, meshes = 0;
    const a = [0,0,0], b = [0,0,0], c = [0,0,0];
    scene.traverse((o) => { if (!o.isMesh || !o.userData.cellGeometry) return; meshes++;
      const g = o.geometry, p = g.attributes.position.array, n = g.attributes.normal.array, idx = g.index.array;
      for (let t = 0; t + 2 < idx.length; t += 3) { const i0 = idx[t]*3, i1 = idx[t+1]*3, i2 = idx[t+2]*3;
        const ux = p[i1]-p[i0], uy = p[i1+1]-p[i0+1], uz = p[i1+2]-p[i0+2]; const vx = p[i2]-p[i0], vy = p[i2+1]-p[i0+1], vz = p[i2+2]-p[i0+2];
        const fx = uy*vz-uz*vy, fy = uz*vx-ux*vz, fz = ux*vy-uy*vx; const d = fx*n[i0]+fy*n[i0+1]+fz*n[i0+2]; if (d > 0) agree++; else if (d < 0) disagree++; } });
    return { meshes, agree, disagree };
  })()`);
  console.log('winding-vs-normal', JSON.stringify(stats));
  await page.screenshot({ path: OUT + '/probe2-asis.png' });
  // 2. FrontSide culling: does the interior survive?
  await page.evaluate(`(() => { const s = window.__ac.sceneManager.scene; s.traverse((o) => { if (o.isMesh && o.userData.cellGeometry) { o.material.side = 0; o.material.needsUpdate = true; } }); })()`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/probe2-frontside.png' });
  // 3. negate normals (DoubleSide restored) — do pools appear?
  await page.evaluate(`(() => { const s = window.__ac.sceneManager.scene; s.traverse((o) => { if (o.isMesh && o.userData.cellGeometry) { o.material.side = 2; o.material.needsUpdate = true; const n = o.geometry.attributes.normal; for (let i = 0; i < n.array.length; i++) n.array[i] = -n.array[i]; n.needsUpdate = true; } }); })()`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/probe2-negnormals.png' });
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
