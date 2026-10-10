/**
 * CORE.17.q.b — live A/B: no sun inside env cells, no pool lights outside them.
 *
 * `--label before|after` captures (against the running dev server + ACE stack):
 *   interior-yaw* — the Holtburg meeting-hall ground floor 0xA9B40117 (a
 *     14 m SeenOutside cell with four portals: walls, furniture, the player), noon;
 *   town-day — the Holtburg square at yaw 2.4 (the cottages' doorways), noon;
 *   town-night — the same at midnight (cottage torches: pool lights vs outdoor objects).
 * Each frame samples the visible lit materials by retail kind (the program cache
 * key), the player's part kinds, the sun / viewer-light state and the viewer cell.
 * `--compose` writes verification/core17qb/core17qb-no-sun-sidebyside.png.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17qb');
const REFS = [
  join(REPO, 'reference/images/hud/rawg_03.jpg'),
  join(REPO, 'reference/images/hud/rawg_08.jpg'),
  join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png'),
];
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const INTERIOR_YAWS = [0, 1.5, 3, 4.5];
/** The world canvas region above the HUD rows (luminance stats). */
const WORLD = { x: 0, y: 0, w: 1568, h: 560 };

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

interface Sample {
  scene: string;
  viewerCell: string;
  sunVisible: boolean;
  viewerLightVisible: boolean;
  kinds: Record<string, number>;
  cellKinds: Record<string, number>;
  playerKinds: Record<string, number>;
  serverObjectKinds: Record<string, Record<string, number>>;
  luminance: number;
}

async function sample(page: Page, scene: string): Promise<Sample> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const kindOf = (m) => {
      const key = typeof m.customProgramCacheKey === 'function' ? m.customProgramCacheKey() : '';
      const mm = key.match(/acRetailLighting:(\\w+)/);
      return mm ? mm[1] : (m.isMeshLambertMaterial ? 'lambert-unpatched' : 'unlit');
    };
    const count = (root, into, visibleOnly) => {
      root.traverse((o) => {
        if (!o.isMesh) return;
        if (visibleOnly) { let p = o; while (p) { if (!p.visible) return; p = p.parent; } }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (!m) continue; const k = kindOf(m); into[k] = (into[k] || 0) + 1; }
      });
      return into;
    };
    const kinds = count(ac.sceneManager.scene, {}, true);
    const cellKinds = {};
    ac.sceneManager.scene.traverse((o) => { if (o.name && o.name.startsWith('envcell_')) count(o, cellKinds, false); });
    const playerKinds = ac.playerModel ? count(ac.playerModel, {}, false) : {};
    const som = {};
    if (ac.serverObjectManager) {
      for (const [guid, obj] of ac.serverObjectManager.getAllObjects()) {
        if (!obj.mesh || !obj.mesh.visible) continue;
        const k = count(obj.mesh, {}, false);
        som[(obj.name || '') + '@0x' + (obj.cellId >>> 0).toString(16)] = k;
      }
    }
    let viewerCell = '?';
    try { viewerCell = '0x' + (window.acDebug.surfaceCellState().currentCellId >>> 0).toString(16); } catch {}
    const canvas = ac.sceneManager.renderer.domElement;
    const c = document.createElement('canvas'); c.width = ${WORLD.w}; c.height = ${WORLD.h};
    const g = c.getContext('2d'); g.drawImage(canvas, ${WORLD.x}, ${WORLD.y}, ${WORLD.w}, ${WORLD.h}, 0, 0, ${WORLD.w}, ${WORLD.h});
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return { scene: ${JSON.stringify(scene)}, viewerCell, sunVisible: !!ac.skybox.sunLight.visible, viewerLightVisible: !!ac.viewerLight.visible,
      kinds, cellKinds, playerKinds, serverObjectKinds: som, luminance: +(sum / (d.length / 4)).toFixed(2) };
  })()`) as Promise<Sample>;
}

async function captureLive(label: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  const errors: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/shader|THREE\.WebGLProgram|GLSL|error/i.test(t)) errors.push(t.slice(0, 300)); });
  console.log(`[core17qb] ${label}: navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[core17qb] character-create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17qb] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, `_${label}-login-failed.png`) });
    await browser.close();
    throw new Error('never entered world');
  }
  console.log('[core17qb] in world; settling');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);

  const samples: Sample[] = [];
  const shoot = async (name: string): Promise<void> => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${label}-${name}.png`) });
    const s = await sample(page, name);
    samples.push(s);
    console.log(`[core17qb] ${label} ${name}: cell=${s.viewerCell} sun=${s.sunVisible} viewerLight=${s.viewerLightVisible} lum=${s.luminance} kinds=${JSON.stringify(s.kinds)} player=${JSON.stringify(s.playerKinds)}`);
  };

  // The Holtburg shop interior (SeenOutside cell 0xA9B40100), noon.
  await page.evaluate(`window.acDebug.tele('0xA9B40117', 154.2, 132.8, 66.05)`);
  await page.waitForTimeout(7000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  // A 3.5 m follow distance keeps the chase camera inside the room (the
  // default 5 m parks it in the wall behind the player).
  await page.evaluate(`(() => { const c = window.__ac.cameraController; c.targetCameraDistance = 3.5; c.currentCameraDistance = 3.5; })()`);
  for (const yaw of INTERIOR_YAWS) {
    await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), yaw);
    await page.waitForTimeout(2200);
    await shoot(`interior-yaw${yaw}`);
  }
  await page.evaluate(`(() => { const c = window.__ac.cameraController; c.resetZoom(); })()`);

  // The square: the cottages' doorways at yaw 2.4, noon then midnight.
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(6000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 2.4);
  await page.waitForTimeout(2500);
  await shoot('town-day');
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.0);
  await page.waitForTimeout(2500);
  await shoot('town-night');

  writeFileSync(join(OUT, `${label}-state.json`), JSON.stringify({ label, url: URL, at: new Date().toISOString(), samples, errors }, null, 2));
  console.log(`[core17qb] ${label}: ${errors.length} shader/error console lines`);
  await browser.close();
}

const dataUrl = (f: string) => `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(f).toString('base64')}`;
const CSS = `<style>
  body{background:#111;color:#ddd;font:12px/1.4 system-ui;margin:12px}
  .row{display:flex;gap:12px;margin-bottom:10px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#bbb;max-width:640px}
  .full img{display:block;width:640px;height:auto;border:1px solid #444}
  .ref img{display:block;width:420px;height:auto;border:1px solid #444}
  .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
  h1{font-size:14px;margin:0 0 8px} h2{font-size:13px;margin:12px 0 6px;color:#9cf}
  table{border-collapse:collapse} td,th{border:1px solid #444;padding:2px 6px;font-size:11px;text-align:left}
</style>`;
function full(file: string, label: string, cls = 'full'): string {
  return `<div class="cell ${cls}"><div class="lbl">${label}</div><img src="${dataUrl(file)}"/></div>`;
}
function crop(file: string, label: string, r: { x: number; y: number; w: number; h: number }, zoom: number): string {
  return `<div class="cell"><div class="lbl">${label}</div>
    <div class="clip" style="width:${r.w * zoom}px;height:${r.h * zoom}px">
      <img src="${dataUrl(file)}" style="position:absolute;left:${-r.x * zoom}px;top:${-r.y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/>
    </div></div>`;
}

async function compose(): Promise<void> {
  const before = JSON.parse(readFileSync(join(OUT, 'before-state.json'), 'utf8'));
  const after = JSON.parse(readFileSync(join(OUT, 'after-state.json'), 'utf8'));
  const scenes = [...INTERIOR_YAWS.map(y => `interior-yaw${y}`), 'town-day', 'town-night'];
  const PLAYER = { x: 640, y: 180, w: 300, h: 300 };
  // Mean Rec.709 luminance over the PNGs (the WebGL canvas has no preserved buffer to read live).
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
  const lum: Record<string, { world: number; player: number }> = {};
  for (const label of ['before', 'after']) for (const s of scenes) {
    lum[`${label}-${s}`] = await page.evaluate(`(async () => {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = ${JSON.stringify(dataUrl(join(OUT, `${label}-${s}.png`)))}; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const mean = (r) => { const d = g.getImageData(r.x, r.y, r.w, r.h).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; return +(sum / (d.length / 4)).toFixed(2); };
      return { world: mean(${JSON.stringify(WORLD)}), player: mean(${JSON.stringify(PLAYER)}) };
    })()`) as { world: number; player: number };
  }
  const row = (s: string) => {
    const b = before.samples.find((x: Sample) => x.scene === s); const a = after.samples.find((x: Sample) => x.scene === s);
    const lb = lum[`before-${s}`], la = lum[`after-${s}`];
    return `<tr><td>${s}</td><td>${a.viewerCell}</td><td>${b.sunVisible} / ${a.sunVisible}</td><td>${b.viewerLightVisible} / ${a.viewerLightVisible}</td>
      <td>world ${lb.world} → ${la.world}<br/>player crop ${lb.player} → ${la.player}</td><td>${JSON.stringify(b.kinds)}</td><td>${JSON.stringify(a.kinds)}</td><td>${JSON.stringify(b.playerKinds)} → ${JSON.stringify(a.playerKinds)}</td></tr>`;
  };
  const html = `<!doctype html><html><head><meta charset="utf-8">${CSS}</head><body>
  <h1>CORE.17.q.b — no sun inside env cells (PView::DrawCells @ 005a4840: useSunlightSet(0) for every cell + its objects, from inside and through a building portal), no pool lights in the landscape pass (useSunlightSet(1): the sun alone) — before | after</h1>
  <h2>Retail references (EoL client): rawg_03 (missile combat in a fortress interior — walls lit without a sun term), rawg_08 (town), the Wine Holtburg frame</h2>
  <div class="row">${REFS.filter(existsSync).map(f => full(f, f.split('/').pop()!, 'ref')).join('')}</div>
  ${INTERIOR_YAWS.map((y, i) => `<h2>Ours — Holtburg meeting-hall ground floor 0xA9B40117 (SeenOutside cell, four portals), noon, yaw ${y}, 3.5 m camera</h2>
  <div class="row">${full(join(OUT, `before-interior-yaw${y}.png`), i === 0 ? 'BEFORE: the sun directional lit the cell walls, the furniture and the player' : 'BEFORE')}${full(join(OUT, `after-interior-yaw${y}.png`), i === 0 ? 'AFTER: envcell + cellobject kinds — ambient + the pool lights (viewer light, DAT torches), no sun' : 'AFTER')}</div>
  ${i === 0 ? `<div class="row">${crop(join(OUT, `before-interior-yaw${y}.png`), 'player + furniture 2x — BEFORE', PLAYER, 2)}${crop(join(OUT, `after-interior-yaw${y}.png`), 'player + furniture 2x — AFTER', PLAYER, 2)}</div>` : ''}`).join('')}
  <h2>Ours — Holtburg square, yaw 2.4 (the cottage doorways), noon</h2>
  <div class="row">${full(join(OUT, 'before-town-day.png'), 'BEFORE: interiors seen through the doors sun-lit; outdoor objects took the cottage torches')}${full(join(OUT, 'after-town-day.png'), 'AFTER: the interiors through the doors sunless (PView::DrawPortal → DrawCells); outdoor objects sun-only')}</div>
  <h2>Ours — the same at midnight</h2>
  <div class="row">${full(join(OUT, 'before-town-night.png'), 'BEFORE')}${full(join(OUT, 'after-town-night.png'), 'AFTER')}</div>
  <h2>Samples (visible lit materials by retail kind; luminance = mean Rec.709 over the world canvas above the HUD)</h2>
  <table><tr><th>scene</th><th>viewer cell</th><th>sun visible b/a</th><th>viewer light b/a</th><th>luminance</th><th>kinds BEFORE</th><th>kinds AFTER</th><th>player parts</th></tr>${scenes.map(row).join('')}</table>
  <div class="lbl">shader/error console lines — before ${before.errors.length}, after ${after.errors.length}</div>
  </body></html>`;
  writeFileSync(join(OUT, 'luminance.json'), JSON.stringify(lum, null, 2));
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, 'core17qb-no-sun-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17qb] wrote ${join(OUT, 'core17qb-no-sun-sidebyside.png')}`);
}

const li = process.argv.indexOf('--label');
if (process.argv.includes('--compose')) compose().catch((e) => { console.error(e); process.exit(1); });
else captureLive(li >= 0 ? process.argv[li + 1] : 'after').catch((e) => { console.error(e); process.exit(1); });
