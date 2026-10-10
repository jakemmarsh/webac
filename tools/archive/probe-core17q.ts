/**
 * CORE.17.q live probe — is the retail interior lighting actually wired?
 *
 * Logs in (same flow as capture-ui-screens.ts), teleports to the world-dungeon
 * scene cell, freezes noon, then reports the light state the renderer sees:
 * viewer light parent/position/intensity, sky sealed mode + ambient, fog,
 * background, DAT light budget counts, the compiled point-light count of a
 * cell material, and a before/after screenshot pair with the viewer light
 * boosted ×8 (a wiring proof: if the frame does not change, the light is not
 * reaching the materials).
 *
 *   npx tsx tools/probe-core17q.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname ?? process.cwd(), '..', '..');
const OUT = join(ROOT, 'verification', 'core17q');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe';
const DUNGEON = '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const cs = (window as any).acDebug?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 200)}`));
  page.on('console', (msg) => { const t = msg.text(); if (/Sealed|Teleport|error|Error/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');
  console.log('[probe] in world');
  await page.waitForTimeout(6000);
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), DUNGEON);
  await page.waitForTimeout(4000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.waitForTimeout(9000);

  const state = await page.evaluate(`(() => {
    const ac = window.__ac; const THREE_ = null;
    const scene = ac.sceneManager.scene;
    const vl = ac.viewerLight;
    const pointLights = []; let visiblePoint = 0; let cellMat = null; let cellMesh = null;
    scene.traverse((o) => {
      if (o.isPointLight) { pointLights.push({ name: o.name, vis: o.visible, i: o.intensity, d: o.distance, decay: o.decay, dat: !!o.userData.datLight, pos: o.getWorldPosition(new o.position.constructor()).toArray().map(v => +v.toFixed(2)) }); if (o.visible) visiblePoint++; }
      if (!cellMesh && o.isMesh && o.userData.cellGeometry && o.material) { cellMesh = o; cellMat = o.material; }
    });
    const cam = ac.sceneManager.camera.position.toArray().map(v => +v.toFixed(2));
    const pm = ac.playerModel ? ac.playerModel.position.toArray().map(v => +v.toFixed(2)) : null;
    let prog = null;
    try {
      const r = ac.sceneManager.renderer; const props = r.properties.get(cellMat);
      const p = props && props.currentProgram; prog = p ? { numPointLights: p.parameters && p.parameters.numPointLights, cacheKey: p.cacheKey && String(p.cacheKey).slice(0, 80) } : 'no program';
    } catch (e) { prog = 'err ' + e; }
    const dist = (pm && vl) ? Math.hypot(pm[0] - vl.position.x, pm[1] - vl.position.y, pm[2] - vl.position.z) : null;
    return {
      viewerLight: vl ? { parentIsScene: vl.parent === scene, vis: vl.visible, i: vl.intensity, d: vl.distance, decay: vl.decay, pos: vl.position.toArray().map(v => +v.toFixed(2)), color: vl.color.getHexString() } : 'MISSING',
      playerModelPos: pm, cameraPos: cam, viewerToPlayer: dist,
      sky: { sealed: ac.skybox.isSealedInterior, ambI: +ac.skybox.ambient.intensity.toFixed(3), ambColor: ac.skybox.ambient.color.getHexString(), sunVis: ac.skybox.directionalLight.visible, sunI: ac.skybox.directionalLight.intensity, domeVis: ac.skybox.skyObject.visible, t: ac.skybox.currentTimeOfDay },
      fog: scene.fog ? { color: scene.fog.color.getHexString(), near: scene.fog.near, far: scene.fog.far } : null,
      background: scene.background && scene.background.isColor ? scene.background.getHexString() : String(scene.background),
      budget: { known: ac.datLightBudget.lightCount, active: ac.datLightBudget.activeCount },
      pointLights: pointLights.filter(p => p.vis).slice(0, 12), visiblePoint,
      cellMat: cellMat ? { type: cellMat.type, key: cellMat.customProgramCacheKey && cellMat.customProgramCacheKey(), hasOBC: !!cellMat.onBeforeCompile, prog } : null,
      cellMeshPos: cellMesh ? cellMesh.getWorldPosition(new cellMesh.position.constructor()).toArray().map(v => +v.toFixed(1)) : null,
      renderInfo: ac.sceneManager.renderer ? { calls: ac.sceneManager.renderer.info.render.calls, programs: ac.sceneManager.renderer.info.programs && ac.sceneManager.renderer.info.programs.length } : null,
    };
  })()`);
  console.log(JSON.stringify(state, null, 2));

  await page.screenshot({ path: join(OUT, 'probe-normal.png') });
  await page.evaluate(() => { const vl = (window as any).__ac.viewerLight; if (vl) vl.intensity *= 8; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'probe-viewerlight-x8.png') });
  await page.evaluate(() => { const vl = (window as any).__ac.viewerLight; if (vl) vl.intensity /= 8; });
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
