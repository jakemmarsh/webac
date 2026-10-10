/** CORE.17.q diagnostic — is the floor mesh the raycast hits the one on screen? Tint its material red. */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'fs';
const OUT = '/home/user/acjs/verification/core17q';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe6';
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
  const info = await page.evaluate(`(async () => {
    const THREE = await import('/@fs/home/user/acjs/node_modules/three/build/three.module.js');
    const ac = window.__ac; const scene = ac.sceneManager.scene; const cam = ac.sceneManager.camera; const r = ac.sceneManager.renderer;
    const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2((784 / 1568) * 2 - 1, -(700 / 775) * 2 + 1), cam);
    const hits = rc.intersectObjects(scene.children, true);
    const rows = hits.map((h) => { const o = h.object; const chain = []; let p = o; while (p) { chain.push(p.name || p.type); p = p.parent; }
      const m = Array.isArray(o.material) ? o.material[0] : o.material; const props = r.properties.get(m);
      return { dist: +h.distance.toFixed(2), chain: chain.slice(0, 4).join(' < '), objVisible: o.visible, matVisible: m.visible, matType: m.type, cellGeometry: !!o.userData.cellGeometry, propKeys: Object.keys(props), hasProgram: !!props.currentProgram, matVersion: m.version, matUuid: m.uuid.slice(0, 8), geomUuid: o.geometry.uuid.slice(0, 8) }; });
    // is the same material object used by any other mesh? count meshes sharing hit[0]'s material
    const first = hits.find((h) => h.object.userData.cellGeometry); let sharers = 0; if (first) scene.traverse((o) => { if (o.isMesh && o.material === first.object.material) sharers++; });
    // ancestors' visibility of the first cell hit
    let vis = []; if (first) { let p = first.object; while (p) { vis.push([p.name || p.type, p.visible]); p = p.parent; } }
    // three.js module identity: does the mesh's constructor come from the renderer's three?
    const sameThree = first ? (first.object instanceof THREE.Mesh) : null;
    // tint the first cell-geometry hit's material red
    if (first) { first.object.material.color.setHex(0xff0000); first.object.material.needsUpdate = true; window.__tinted = first.object; }
    return { rows, sharers, ancestorsVisible: vis, sameThreeAsFsImport: sameThree, tinted: !!first };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  await page.waitForTimeout(7000);
  await page.screenshot({ path: OUT + '/probe6-tint-floor-red.png' });
  // second: tint EVERY cellGeometry material of the player's cell group blue
  const info2 = await page.evaluate(`(() => { const ac = window.__ac; let n = 0; ac.sceneManager.scene.traverse((o) => { if (o.name === 'envcell_86020115') o.traverse((c) => { if (c.isMesh && c.userData.cellGeometry) { c.material.color.setHex(0x0000ff); n++; } }); }); return { tintedMeshes: n }; })()`);
  console.log(JSON.stringify(info2));
  await page.waitForTimeout(7000);
  await page.screenshot({ path: OUT + '/probe6-tint-cell-blue.png' });
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
