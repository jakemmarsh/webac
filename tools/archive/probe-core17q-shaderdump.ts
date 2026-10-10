/** CORE.17.q diagnostic — dump the compiled GLSL of an app material vs a freshly patched sphere material. */
import { chromium, type Page } from 'playwright';
import { existsSync, writeFileSync } from 'fs';
const OUT = '/tmp/claude-0/-home-user-acjs/d443cbaf-2718-5840-a4e9-fa20ef61b0c0/scratchpad';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe8';
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
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.waitForTimeout(8000);
  const res = await page.evaluate(`(async () => {
    const THREE = await import('/@fs/home/user/acjs/node_modules/three/build/three.module.js');
    const RL = await import('/@fs/home/user/acjs/packages/renderer/src/models/RetailLighting.ts');
    const ac = window.__ac; const scene = ac.sceneManager.scene; const cam = ac.sceneManager.camera; const r = ac.sceneManager.renderer; const gl = r.getContext();
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir); const p = cam.position.clone().add(dir.multiplyScalar(4));
    const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 16), RL.applyRetailLighting(new THREE.MeshLambertMaterial({ color: 0x808080 }), 'object')); s2.position.copy(p); scene.add(s2);
    const L = new THREE.PointLight(0xff4040, 40, 30, 1); L.position.copy(cam.position); scene.add(L);
    await new Promise((res) => setTimeout(res, 6000));
    // app material: a cell mesh in the stream with a program
    let cellMat = null; scene.traverse((o) => { if (!cellMat && o.isMesh && o.userData.cellGeometry && r.properties.get(o.material).currentProgram) cellMat = o.material; });
    let charMat = null; scene.traverse((o) => { if (!charMat && o.isMesh && o.parent && o.parent.parent && String(o.parent.parent.name).startsWith('player_') && r.properties.get(o.material).currentProgram) charMat = o.material; });
    const dump = (m) => { const p = r.properties.get(m).currentProgram; if (!p) return null; return { vs: gl.getShaderSource(p.vertexShader), fs: gl.getShaderSource(p.fragmentShader), key: String(p.cacheKey) }; };
    const uni = (m) => { const u = r.properties.get(m).uniforms; return u ? Object.keys(u) : null; };
    return { cell: dump(cellMat), char: dump(charMat), sphere: dump(s2.material), cellUniforms: uni(cellMat), sphereUniforms: uni(s2.material),
      cellMatProps: cellMat ? { obc: String(cellMat.onBeforeCompile).slice(0, 200), key: cellMat.customProgramCacheKey(), defines: cellMat.defines, side: cellMat.side, map: !!cellMat.map, transparent: cellMat.transparent, alphaTest: cellMat.alphaTest, fog: cellMat.fog, vertexColors: cellMat.vertexColors, flatShading: cellMat.flatShading } : null,
      sphereMatProps: { obc: String(s2.material.onBeforeCompile).slice(0, 200), key: s2.material.customProgramCacheKey() } };
  })()`);
  for (const k of ['cell', 'char', 'sphere']) { const d = (res as any)[k]; if (d) { writeFileSync(OUT + '/' + k + '.frag.glsl', d.fs); writeFileSync(OUT + '/' + k + '.vert.glsl', d.vs); writeFileSync(OUT + '/' + k + '.key.txt', d.key); } else console.log(k, 'no program'); }
  console.log(JSON.stringify({ cellUniforms: (res as any).cellUniforms, sphereUniforms: (res as any).sphereUniforms, cellMatProps: (res as any).cellMatProps, sphereMatProps: (res as any).sphereMatProps }, null, 1));
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
