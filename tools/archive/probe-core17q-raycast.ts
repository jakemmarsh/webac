/** CORE.17.q diagnostic — what mesh/material/normal is on screen at the floor, wall and ceiling pixels? */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'fs';
const OUT = '/home/user/acjs/verification/core17q';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe5';
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
    const rc = new THREE.Raycaster(); const out = {};
    const pts = { floorAtFeet: [784, 700], floorLeft: [500, 640], wallLeft: [400, 420], wallRight: [1150, 420], ceiling: [800, 120], character: [784, 480] };
    for (const [name, [px, py]] of Object.entries(pts)) {
      const ndc = new THREE.Vector2((px / 1568) * 2 - 1, -(py / 775) * 2 + 1); rc.setFromCamera(ndc, cam);
      const hits = rc.intersectObjects(scene.children, true).filter((h) => h.object.visible && h.object.type !== 'Line');
      const h = hits[0]; if (!h) { out[name] = 'no hit'; continue; }
      const o = h.object; const chain = []; let p = o; while (p) { chain.push(p.name || p.type); p = p.parent; }
      const g = o.geometry; const fn = h.face ? h.face.normal.clone().transformDirection(o.matrixWorld) : null;
      let vn = null; if (h.face && g.attributes.normal) { const a = g.attributes.normal; const n = new THREE.Vector3().fromBufferAttribute(a, h.face.a).transformDirection(o.matrixWorld); vn = n.toArray().map((v) => +v.toFixed(2)); }
      const m = Array.isArray(o.material) ? o.material[0] : o.material; const props = r.properties.get(m); const prog = props && props.currentProgram;
      out[name] = { dist: +h.distance.toFixed(2), point: h.point.toArray().map((v) => +v.toFixed(2)), mesh: o.name, type: o.type, chain: chain.slice(0, 4).join(' < '), cellGeometry: !!o.userData.cellGeometry,
        material: { type: m.type, side: m.side, key: m.customProgramCacheKey ? m.customProgramCacheKey() : null, hasProgram: !!prog, transparent: m.transparent, vertexColors: m.vertexColors, emissive: m.emissive ? m.emissive.getHexString() : null },
        faceNormalWorld: fn ? fn.toArray().map((v) => +v.toFixed(2)) : null, vertexNormalWorld: vn, frontFacing: h.face ? (fn.dot(rc.ray.direction) < 0) : null, hitCount: hits.length,
        instanced: !!o.isInstancedMesh, matAmbientScale: props && props.uniforms && props.uniforms.acAmbientScale ? props.uniforms.acAmbientScale.value : undefined };
    }
    out.viewerLight = ac.viewerLight.position.toArray().map((v) => +v.toFixed(2)); out.camera = cam.position.toArray().map((v) => +v.toFixed(2));
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 2));
  await page.evaluate(() => { const vl = (window as any).__ac.viewerLight; vl.intensity *= 8; });
  await page.waitForTimeout(7000);
  await page.screenshot({ path: OUT + '/probe5-viewerlight-x8.png' });
  await page.evaluate(() => { const vl = (window as any).__ac.viewerLight; vl.intensity /= 8; });
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
