/** CORE.17.q diagnostic — why do point lights not reach the retail-lit materials? */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'fs';
const OUT = '/home/user/acjs/verification/core17q';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe3';
async function inWorld(page: Page) { return page.evaluate(() => { const cs = (window as any).acDebug?.collisionState?.(); return !!(cs && cs.x > 0); }); }
async function main() {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'], ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000); page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (/THREE|shader|Shader|ERROR/.test(t)) console.log('  [page] ' + t.slice(0, 400)); });
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
  const info = await page.evaluate(`(() => {
    const ac = window.__ac; const r = ac.sceneManager.renderer; const gl = r.getContext();
    const progs = r.info.programs.map((p) => { const src = gl.getShaderSource(p.fragmentShader) || ''; return { name: p.name, used: p.usedTimes,
      numPoint: (src.match(/#define NUM_POINT_LIGHTS (\\d+)/) || [])[1], numDir: (src.match(/#define NUM_DIR_LIGHTS (\\d+)/) || [])[1],
      landscape: src.includes('#define AC_LANDSCAPE'), retail: src.includes('acAmbientScale'), pointLoop: src.includes('pointLights[ 0 ]'), guard: (src.match(/#if \\( NUM_POINT_LIGHTS[^\\n]*/g) || [])[0] }; });
    let rendered = 0, unrendered = 0; ac.sceneManager.scene.traverse((o) => { if (o.isMesh && o.userData.cellGeometry) { if (r.properties.get(o.material).currentProgram) rendered++; else unrendered++; } });
    return { progs, cellMeshes: { rendered, unrendered }, renderCalls: r.info.render.calls };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  // Isolated object test: a sphere in front of the camera with a stock Lambert, under a strong test light at the camera
  await page.evaluate(`(() => {
    const ac = window.__ac; const scene = ac.sceneManager.scene; const cam = ac.sceneManager.camera;
    const THREE_ = ac.viewerLight.constructor.__proto__; // not usable; use scene classes via existing objects
    const g = new (ac.sceneManager.scene.constructor)(); // placeholder to get module? fallback below
  })()`).catch(() => {});
  // Use a lightweight injection: import three from the vite dev server module graph
  await page.evaluate(`(async () => {
    const mod = await import('/node_modules/three/build/three.module.js').catch(() => import('/@fs/home/user/acjs/node_modules/three/build/three.module.js'));
    const THREE = mod; window.__THREE_probe = THREE;
    const ac = window.__ac; const scene = ac.sceneManager.scene; const cam = ac.sceneManager.camera;
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    const p = cam.position.clone().add(dir.multiplyScalar(4));
    const s1 = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 16), new THREE.MeshLambertMaterial({ color: 0x808080 })); s1.position.copy(p).add(new THREE.Vector3(-1, 0, 0)); s1.name = 'probe-stock'; scene.add(s1);
    const mod2 = await import('/@fs/home/user/acjs/packages/renderer/src/models/RetailLighting.ts');
    const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 16), mod2.applyRetailLighting(new THREE.MeshLambertMaterial({ color: 0x808080 }), 'object')); s2.position.copy(p).add(new THREE.Vector3(1, 0, 0)); s2.name = 'probe-patched'; scene.add(s2);
    const L = new THREE.PointLight(0xff4040, 40, 30, 1); L.position.copy(cam.position); L.name = 'probe-light'; scene.add(L);
    window.__probeObjs = [s1, s2, L];
  })()`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: OUT + '/probe3-spheres-redlight.png' });
  const info2 = await page.evaluate(`(() => { const ac = window.__ac; const r = ac.sceneManager.renderer; const gl = r.getContext(); const out = {};
    for (const o of window.__probeObjs.slice(0, 2)) { const p = r.properties.get(o.material).currentProgram; if (!p) { out[o.name] = 'none'; continue; } const src = gl.getShaderSource(p.fragmentShader); out[o.name] = { numPoint: p.parameters.numPointLights, hasLoop: src.includes('pointLights[ 0 ]'), guard: (src.match(/#if \\( NUM_POINT_LIGHTS[^\\n]*/g) || []).slice(0, 1) }; }
    const lights = r.info; out.renderInfoPrograms = r.info.programs.length; return out; })()`);
  console.log(JSON.stringify(info2, null, 2));
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
