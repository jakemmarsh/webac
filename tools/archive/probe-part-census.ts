/**
 * PERF.1 town-facing part-bucket slice — finer draw-call attribution for the
 * `part` bucket. Walks each drawn object's ancestor chain to the scene root
 * and classifies: local player model, server object (animated vs static-pose),
 * wielded attachments, pools, terrain. For static-pose server objects it also
 * aggregates per-setup draw calls + object counts (instancing/merge potential).
 */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'node:fs';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=partcensus';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug; const cs = dbg && dbg.collisionState && dbg.collisionState();
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 300_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  await page.waitForTimeout(10_000);
  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(15_000);
  await page.evaluate(`window.acDebug.setTimeOfDay(0.5)`);
  let lastMeshes = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(6000);
    const meshes = await page.evaluate(`(() => { let m = 0; window.__ac.sceneManager.scene.traverse(o => { if (o.isMesh) m++; }); return m; })()`) as number;
    console.log(`settle: ${meshes} meshes`);
    if (meshes === lastMeshes) break;
    lastMeshes = meshes;
  }

  for (const yawName of ['yaw0', 'town']) {
    const yaw = yawName === 'yaw0' ? 0 : (4 * Math.PI) / 3;
    await page.evaluate(`window.acDebug.setPlayerYaw(${yaw})`);
    await page.waitForTimeout(2000);
    const result = await page.evaluate(`(() => {
      const ac = window.__ac;
      const sm = ac.sceneManager;
      const som = ac.serverObjectManager;
      const player = ac.playerModel;
      const r = sm.renderer;
      const buckets = {};
      const perSetup = {};   // static-pose server objects: setup hex -> calls
      const perName = {};    // static-pose server objects: obj name -> calls
      const objGuids = {};   // setup hex -> Set of guids drawn
      const orig = r.renderBufferDirect.bind(r);
      let frames = 0;
      const classify = (object) => {
        // Walk to the topmost scene child, remembering the server_ root if any
        let n = object, serverRoot = null, underPlayer = false, firstNamed = null;
        while (n) {
          if (!firstNamed && n.name) firstNamed = n.name;
          if (n === player) underPlayer = true;
          if (n.name && n.name.indexOf('server_') === 0) serverRoot = n;
          n = n.parent;
        }
        if (underPlayer) return 'player-model';
        if (serverRoot) {
          const m = serverRoot.name.match(/^server_([0-9a-f]+)_(.*)$/);
          const guid = m ? parseInt(m[1], 16) : 0;
          const animated = guid && som.getAnimated && som.getAnimated(guid);
          // Is this draw from a wielded attachment (a setup_ group nested
          // under a part of the server root)?
          let p = object, sawSetupUnderPart = false;
          while (p && p !== serverRoot) {
            if (p.name && p.name.indexOf('setup_') === 0) sawSetupUnderPart = true;
            p = p.parent;
          }
          if (sawSetupUnderPart) return animated ? 'srv-animated-attachment' : 'srv-static-attachment';
          if (animated) return 'srv-animated';
          const obj = som.objects && som.objects.get ? som.objects.get(guid) : null;
          const setup = obj && obj.setupId ? obj.setupId.toString(16) : '?';
          perSetup[setup] = (perSetup[setup] || 0) + 1;
          const nm = obj ? obj.name : serverRoot.name;
          perName[nm] = (perName[nm] || 0) + 1;
          (objGuids[setup] = objGuids[setup] || new Set()).add(guid);
          return 'srv-static';
        }
        // No server root: split by owning chain — envcell_ ancestor means
        // interior-cell furniture; otherwise it's an outdoor per-object group.
        let q = object, underEnvcell = false, rootName = '';
        while (q) {
          if (q.name) { rootName = q.name; if (q.name.indexOf('envcell_') === 0) underEnvcell = true; }
          q = q.parent;
        }
        const nm = (firstNamed || '?').replace(/[0-9a-fx]{6,}/g, '#').replace(/part_\\d+/, 'part');
        if (underEnvcell) return 'envfurn:' + nm;
        return 'outdoor:' + nm + ' root=' + rootName.replace(/[0-9a-fx]{6,}/g, '#');
      };
      return new Promise(res => {
        r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
          // DoubleSide+transparent materials go through the three.js two-pass
          // path (renderBufferDirect twice per object) — tag them so the
          // clipmap-two-pass share of each bucket is visible.
          const twoPass = material && material.transparent && material.side === 2;
          const clip = material && material.alphaTest >= 0.4;
          const k = classify(object) + (twoPass ? (clip ? ' [2pass-clip]' : ' [2pass]') : '');
          buckets[k] = (buckets[k] || 0) + 1;
          return orig(camera, scene, geometry, material, object, group);
        };
        const finish = () => {
          r.renderBufferDirect = orig;
          const g = {};
          for (const k in objGuids) g[k] = objGuids[k].size;
          res({ frames, buckets, perSetup, perName, objCounts: g });
        };
        const tick = () => { frames++; if (frames >= 3) requestAnimationFrame(() => finish()); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
    })()`) as {
      frames: number; buckets: Record<string, number>;
      perSetup: Record<string, number>; perName: Record<string, number>; objCounts: Record<string, number>;
    };
    const f = result.frames;
    console.log(`\n=== ${yawName} (yaw=${yaw.toFixed(2)}) — per-frame buckets over ${f} frames ===`);
    for (const [k, v] of Object.entries(result.buckets).sort((a, b) => b[1] - a[1])) {
      if (Math.round(v / f) > 0) console.log(`${String(Math.round(v / f)).padStart(6)}  ${k}`);
    }
    console.log(`--- srv-static per setup (calls/frame, distinct objs) ---`);
    for (const [k, v] of Object.entries(result.perSetup).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`${String(Math.round(v / f)).padStart(6)}  0x${k}  objs=${result.objCounts[k] || 0}`);
    }
    console.log(`--- srv-static per object name (top 20) ---`);
    for (const [k, v] of Object.entries(result.perName).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`${String(Math.round(v / f)).padStart(6)}  ${k}`);
    }
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
