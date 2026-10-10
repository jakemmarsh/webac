/**
 * CORE.17.h.g.c.b — live capture + side-by-side evidence for the retail
 * Environment Detail Textures pass (building shells + env-cell walls).
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright,
 * logs in like tools/capture-core17hgc-texture-prefs.ts, parks at Holtburg
 * with the scene harness' pins (noon, weather off), then:
 *   town-on.png / town-off.png         whole frame, yaw 0, pass ON (the default) / OFF
 *                                      (via gameUI.applyOptionsBulk — the Reset/Defaults path)
 *   town-alt-on.png / town-alt-off.png the same at yaw 2.4 (world-town-day-alt's buildings)
 *   dungeon-on.png / dungeon-off.png   the harness' Training Academy cell (0x86020115)
 *   menu-before-frame.png / menu-click-frame.png
 *                                      Options › Config open on the row, then the REAL
 *                                      toggle clicked once (ON → OFF)
 *   samples.json                       per step: live state (enabled, surfaces, uniform
 *                                      values, detail-material census by kind) + the
 *                                      ON/OFF pixel diffs per frame band
 * `--compose` builds core17hgcb-detail-sidebyside.png (retail refs | ours ON |
 * ours OFF, with 2x crops of the buildings / a dungeon wall) from those files.
 *
 * Usage: npx tsx tools/capture-core17hgcb-detail-texturing.ts
 *        npx tsx tools/capture-core17hgcb-detail-texturing.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgcb');
const TOWN_REFS = [
  join(REPO, 'reference/images/hud/rawg_07.jpg'),
  join(REPO, 'reference/images/hud/rawg_08.jpg'),
  join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png'),
];
const DUNGEON_REFS = [
  join(REPO, 'reference/images/hud/rawg_04.jpg'),
  join(REPO, 'reference/images/hud/rawg_09.jpg'),
];
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const DUNGEON = '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';

/** Crops (viewport px) — the buildings across the square (yaw 2.4: the
 *  cottage + the Holtburg meeting hall), a ground patch, a dungeon wall. */
const BUILDINGS = { x: 520, y: 200, w: 420, h: 220 };
const COTTAGE = { x: 440, y: 280, w: 230, h: 140 };
const HALL = { x: 0, y: 190, w: 210, h: 250 };
const GROUND = { x: 560, y: 560, w: 320, h: 150 };
const WALL = { x: 900, y: 150, w: 420, h: 260 };

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

interface State {
  step: string;
  enabled: boolean;
  setting: unknown;
  surfaces: unknown;
  uniforms: Record<string, { on: number; tiling: number; map: string | null }>;
  census: Record<string, number>;
}

async function sample(page: Page, step: string): Promise<State> {
  const s = await page.evaluate(`(() => {
    const ac = window.__ac;
    const d = ac.detailTexturing;
    const uni = {};
    for (const kind of ['building', 'environment']) {
      const u = d.uniformsFor(kind);
      uni[kind] = { on: u.on.value, tiling: u.tiling.value, map: u.map.value ? (u.map.value.image.width + 'x' + u.map.value.image.height) : null };
    }
    const census = { building: 0, environment: 0, plain: 0, bldginstMeshes: 0, envcellMeshes: 0 };
    const seen = new Set();
    ac.sceneManager.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        const key = typeof m.customProgramCacheKey === 'function' ? m.customProgramCacheKey() : '';
        if (key.includes('acDetail:building')) census.building++;
        else if (key.includes('acDetail:environment')) census.environment++;
        else census.plain++;
      }
      if (o.name.startsWith('bldginst_')) census.bldginstMeshes++;
      if (o.parent && o.parent.name && o.parent.name.startsWith('envcell_')) census.envcellMeshes++;
    });
    return { step: ${JSON.stringify(step)}, enabled: d.isEnabled, setting: ac.gameUI.optionsSettings.buildingDetailTextures, surfaces: d.loadedSurfaces, uniforms: uni, census };
  })()`) as State;
  return s;
}

async function setPass(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => (window as any).__ac.gameUI.applyOptionsBulk({ buildingDetailTextures: v }), on);
  await page.waitForTimeout(1200);
}

interface Band { total: number; differing: number; maxDelta: number; meanDelta: number }
interface Diff { whole: Band; sky: Band; ground: Band; buildings: Band; wall: Band }

async function pixelDiff(page: Page, a: string, b: string): Promise<Diff> {
  return page.evaluate(`(async () => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const A = await load(${JSON.stringify(dataUrl(a))});
    const B = await load(${JSON.stringify(dataUrl(b))});
    const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
    const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const pa = px(A), pb = px(B);
    const R = ${JSON.stringify({ GROUND, BUILDINGS, WALL })};
    const mk = () => ({ total: 0, differing: 0, maxDelta: 0, sum: 0 });
    const bands = { whole: mk(), sky: mk(), ground: mk(), buildings: mk(), wall: mk() };
    const inR = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      const hit = [bands.whole];
      if (y < h * 0.40 && x < w * 0.82) hit.push(bands.sky);
      if (inR(R.GROUND, x, y)) hit.push(bands.ground);
      if (inR(R.BUILDINGS, x, y)) hit.push(bands.buildings);
      if (inR(R.WALL, x, y)) hit.push(bands.wall);
      for (const b of hit) { b.total++; b.sum += d; if (d > 3) b.differing++; if (d > b.maxDelta) b.maxDelta = d; }
    }
    const out = {};
    for (const k of Object.keys(bands)) { const b = bands[k]; out[k] = { total: b.total, differing: b.differing, maxDelta: b.maxDelta, meanDelta: +(b.sum / Math.max(1, b.total)).toFixed(3) }; }
    return out;
  })()`) as Promise<Diff>;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  const logs: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('Detail texturing') || t.includes('[AC] Texture prefs')) logs.push(t); });
  console.log(`[core17hgcb] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17hgcb] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17hgcb] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world — see _login-failed.png');
  }
  console.log('[core17hgcb] in world; settling');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(4000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(2500);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);
  await page.waitForTimeout(800);

  const samples: State[] = [];
  const diffs: Record<string, Diff> = {};
  const shoot = async (name: string, step: string): Promise<void> => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    const s = await sample(page, step);
    samples.push(s);
    console.log(`[core17hgcb] ${step}: enabled=${s.enabled} uniforms=${JSON.stringify(s.uniforms)} census=${JSON.stringify(s.census)}`);
  };

  await setPass(page, true);
  await shoot('town-on', 'town yaw0 ON (default)');
  await setPass(page, false);
  await shoot('town-off', 'town yaw0 OFF');
  await setPass(page, true);
  await shoot('town-on2', 'town yaw0 ON again');
  diffs['town on-vs-off'] = await pixelDiff(page, join(OUT, 'town-on.png'), join(OUT, 'town-off.png'));
  diffs['town on-vs-on2 (noise floor)'] = await pixelDiff(page, join(OUT, 'town-on.png'), join(OUT, 'town-on2.png'));

  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 2.4);
  await page.waitForTimeout(2000);
  await shoot('town-alt-on', 'town yaw2.4 ON');
  await setPass(page, false);
  await shoot('town-alt-off', 'town yaw2.4 OFF');
  await setPass(page, true);
  diffs['town-alt on-vs-off'] = await pixelDiff(page, join(OUT, 'town-alt-on.png'), join(OUT, 'town-alt-off.png'));

  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), DUNGEON);
  await page.waitForTimeout(9000);
  await shoot('dungeon-on', 'dungeon ON');
  await setPass(page, false);
  await shoot('dungeon-off', 'dungeon OFF');
  await setPass(page, true);
  await shoot('dungeon-on2', 'dungeon ON again');
  diffs['dungeon on-vs-off'] = await pixelDiff(page, join(OUT, 'dungeon-on.png'), join(OUT, 'dungeon-off.png'));
  diffs['dungeon on-vs-on2 (noise floor)'] = await pixelDiff(page, join(OUT, 'dungeon-on.png'), join(OUT, 'dungeon-on2.png'));

  // Back to town, then the REAL toggle: open Options › Config and click the row once.
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(4000);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(1500);
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = 'config'; ui.optionsSettings.optionsTab = 'config';
    ui.toggleOptionsPanel();
  })()`);
  await page.waitForTimeout(600);
  const menuBefore = await page.evaluate(`(() => {
    const row = window.__ac.gameUI.optionsPanel.querySelector('[data-option-key="buildingDetailTextures"]');
    if (!row) return 'no-row';
    row.scrollIntoView({ block: 'center' });
    return { setting: window.__ac.gameUI.optionsSettings.buildingDetailTextures, enabled: window.__ac.detailTexturing.isEnabled };
  })()`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'menu-before-frame.png') });
  const menuAfter = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const row = ui.optionsPanel.querySelector('[data-option-key="buildingDetailTextures"]');
    if (!row) return 'no-row';
    row.dispatchEvent(new Event('click', { bubbles: true }));
    const row2 = ui.optionsPanel.querySelector('[data-option-key="buildingDetailTextures"]');
    if (row2) row2.scrollIntoView({ block: 'center' });
    const d = window.__ac.detailTexturing;
    return { setting: ui.optionsSettings.buildingDetailTextures, enabled: d.isEnabled, on: [d.uniformsFor('building').on.value, d.uniformsFor('environment').on.value] };
  })()`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, 'menu-click-frame.png') });
  console.log(`[core17hgcb] menu click: before=${JSON.stringify(menuBefore)} after=${JSON.stringify(menuAfter)}`);
  // Click back ON and close the panel.
  const menuRestore = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const row = ui.optionsPanel.querySelector('[data-option-key="buildingDetailTextures"]');
    if (row) row.dispatchEvent(new Event('click', { bubbles: true }));
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    return { setting: ui.optionsSettings.buildingDetailTextures, enabled: window.__ac.detailTexturing.isEnabled };
  })()`);
  samples.push(await sample(page, 'restored'));
  for (const [k, d] of Object.entries(diffs)) console.log(`[core17hgcb] diff ${k}: ${JSON.stringify(d)}`);
  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ menuBefore, menuAfter, menuRestore, samples, diffs, logs }, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:640px}
  .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
  .full img{display:block;width:620px;height:auto;border:1px solid #444}
  .ref img{display:block;width:400px;height:auto;border:1px solid #444}
  h1{font-size:14px;margin:0 0 8px}
  h2{font-size:13px;margin:12px 0 6px;color:#9cf}
</style>`;

function crop(file: string, label: string, r: { x: number; y: number; w: number; h: number }, zoom: number): string {
  return `<div class="cell"><div class="lbl">${label}</div>
    <div class="clip" style="width:${r.w * zoom}px;height:${r.h * zoom}px">
      <img src="${dataUrl(file)}" style="position:absolute;left:${-r.x * zoom}px;top:${-r.y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/>
    </div></div>`;
}

function full(file: string, label: string, cls = 'full'): string {
  return `<div class="cell ${cls}"><div class="lbl">${label}</div><img src="${dataUrl(file)}"/></div>`;
}

async function compose(): Promise<void> {
  const need = ['town-on', 'town-off', 'town-alt-on', 'town-alt-off', 'dungeon-on', 'dungeon-off', 'menu-click-frame'].map(n => join(OUT, `${n}.png`));
  for (const f of need) if (!existsSync(f)) throw new Error(`missing ${f} — run the capture first`);
  const samples = JSON.parse(readFileSync(join(OUT, 'samples.json'), 'utf8'));
  const d = samples.diffs;
  const fmt = (b: Band) => `${(100 * b.differing / b.total).toFixed(1)} % px >3, mean Δ ${b.meanDelta}, max ${b.maxDelta}`;
  const html = `<!doctype html><html><head><meta charset="utf-8">${CSS}</head><body>
  <h1>CORE.17.h.g.c.b — Environment Detail Textures: retail second draw (DESTCOLOR / INVSRCALPHA, 0x5001787 ×4) over building shells + env-cell walls — ours ON (default) vs OFF</h1>
  <h2>Retail references (EoL client): Holtburg town + dungeon walls</h2>
  <div class="row">${TOWN_REFS.filter(existsSync).map(f => full(f, f.split('/').pop()!, 'ref')).join('')}${DUNGEON_REFS.filter(existsSync).map(f => full(f, f.split('/').pop()!, 'ref')).join('')}</div>
  <h2>Ours — Holtburg, noon, yaw 0 (whole screen)</h2>
  <div class="row">${full(join(OUT, 'town-on.png'), 'ON (default): pass folded into the building/env-cell programs')}${full(join(OUT, 'town-off.png'), 'OFF: Config "Environment Detail Textures" unticked (applyOptionsBulk)')}</div>
  <div class="row">${crop(join(OUT, 'town-on.png'), 'buildings 2x — ON', BUILDINGS, 2)}${crop(join(OUT, 'town-off.png'), 'buildings 2x — OFF', BUILDINGS, 2)}</div>
  <div class="row">${crop(join(OUT, 'town-on.png'), 'ground 2x — ON (must equal OFF: landscape never carries the pass)', GROUND, 2)}${crop(join(OUT, 'town-off.png'), 'ground 2x — OFF', GROUND, 2)}</div>
  <div class="lbl">diff town ON vs OFF — whole ${fmt(d['town on-vs-off'].whole)}; buildings ${fmt(d['town on-vs-off'].buildings)}; ground ${fmt(d['town on-vs-off'].ground)}; sky ${fmt(d['town on-vs-off'].sky)}<br/>
  noise floor (ON vs ON again) — whole ${fmt(d['town on-vs-on2 (noise floor)'].whole)}; buildings ${fmt(d['town on-vs-on2 (noise floor)'].buildings)}; ground ${fmt(d['town on-vs-on2 (noise floor)'].ground)}</div>
  <h2>Ours — Holtburg, yaw 2.4</h2>
  <div class="row">${full(join(OUT, 'town-alt-on.png'), 'ON')}${full(join(OUT, 'town-alt-off.png'), 'OFF')}</div>
  <div class="row">${crop(join(OUT, 'town-alt-on.png'), 'cottage 3x — ON', COTTAGE, 3)}${crop(join(OUT, 'town-alt-off.png'), 'cottage 3x — OFF', COTTAGE, 3)}</div>
  <div class="row">${crop(join(OUT, 'town-alt-on.png'), 'meeting hall 2x — ON', HALL, 2)}${crop(join(OUT, 'town-alt-off.png'), 'meeting hall 2x — OFF', HALL, 2)}</div>
  <div class="lbl">diff town-alt ON vs OFF — whole ${fmt(d['town-alt on-vs-off'].whole)}; buildings ${fmt(d['town-alt on-vs-off'].buildings)}; ground ${fmt(d['town-alt on-vs-off'].ground)}</div>
  <h2>Ours — Training Academy cell 0x86020115 (env cells)</h2>
  <div class="row">${full(join(OUT, 'dungeon-on.png'), 'ON')}${full(join(OUT, 'dungeon-off.png'), 'OFF')}</div>
  <div class="row">${crop(join(OUT, 'dungeon-on.png'), 'wall 2x — ON', WALL, 2)}${crop(join(OUT, 'dungeon-off.png'), 'wall 2x — OFF', WALL, 2)}</div>
  <div class="lbl">diff dungeon ON vs OFF — whole ${fmt(d['dungeon on-vs-off'].whole)}; wall ${fmt(d['dungeon on-vs-off'].wall)}<br/>
  noise floor (ON vs ON again) — whole ${fmt(d['dungeon on-vs-on2 (noise floor)'].whole)}</div>
  <h2>The real toggle: Options › Config › Environment Detail Textures clicked once</h2>
  <div class="row">${full(join(OUT, 'menu-before-frame.png'), `before: ${JSON.stringify(samples.menuBefore)}`)}${full(join(OUT, 'menu-click-frame.png'), `after click: ${JSON.stringify(samples.menuAfter)}`)}</div>
  </body></html>`;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, 'core17hgcb-detail-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17hgcb] wrote ${join(OUT, 'core17hgcb-detail-sidebyside.png')}`);
}

if (process.argv.includes('--compose')) {
  compose().catch((e) => { console.error(e); process.exit(1); });
} else {
  captureLive().catch((e) => { console.error(e); process.exit(1); });
}
