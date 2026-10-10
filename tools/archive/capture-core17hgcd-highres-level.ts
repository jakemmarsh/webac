/**
 * CORE.17.h.g.c.d — live capture + side-by-side evidence for client_highres.dat
 * as the Environment Texture Detail "Very High" level.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright
 * like tools/capture-core17hgc-texture-prefs.ts, parks at Holtburg (noon,
 * weather off, yaw 0) and then in the Training Academy hall, and captures:
 *   town-high.png / town-veryhigh.png / town-high-again.png
 *       whole frame at High (the retail default), after selecting Very High
 *       through applyOptionsBulk (the Reset/Defaults path) and waiting for
 *       the on-demand client_highres.dat mount, and back at High
 *   menu-click-frame.png
 *       the REAL Options › Config menu: Environment Texture Detail clicked
 *       once (High → Very High) with the prefs it produced
 *   dungeon-high.png / dungeon-veryhigh.png
 *       the same A/B inside cell 0x86020115 (DXT1 wall textures 512² over 256²)
 *   samples.json
 *       per step: pref values, highres mount state, registry census (textures
 *       carrying a highres level / drawing it now, current image sizes),
 *       TextureManager stats
 * `--compose` builds core17hgcd-highres-level-sidebyside.png (retail refs |
 * High | Very High with 3x crops, pixel diffs of the High/Very High pairs and
 * of the High/High-again control) from those files.
 *
 * Usage: npx tsx tools/capture-core17hgcd-highres-level.ts
 *        npx tsx tools/capture-core17hgcd-highres-level.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgcd');
const TOWN_REFS = [
  join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png'),
  join(REPO, 'reference/images/hud/rawg_07.jpg'),
];
const DUNGEON_REFS = [
  join(REPO, 'reference/images/hud/rawg_02.jpg'),
  join(REPO, 'reference/images/hud/rawg_04.jpg'),
  join(REPO, 'reference/images/hud/rawg_09.jpg'),
];
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const DEFAULTS = { textureFiltering: 1, landscapeTextureDetail: 2, environmentTextureDetail: 1 };
const DUNGEON = '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';

/** Crops (viewport px): the player + tree bases at Holtburg (yaw 0 faces the hill, no buildings in frame); the Academy's left wall. */
const BUILDINGS = { x: 620, y: 330, w: 300, h: 210 };
const TREES = { x: 920, y: 60, w: 380, h: 270 };
const HALL = { x: 300, y: 330, w: 520, h: 230 };

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

interface Census { count: number; sizes: Record<string, number>; withHiRes: number; atHiRes: number }
interface Sample {
  step: string;
  applied: Record<string, number>;
  values: Record<string, number>;
  highResMounted: boolean;
  highResFiles: number | null;
  usesHighRes: boolean;
  registered: number;
  census: { landscape: Census; environment: Census };
  stats: Record<string, unknown>;
}

async function sample(page: Page, step: string, applied: Record<string, number>): Promise<Sample> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const p = ac.textureSamplerPrefs;
    return {
      step: ${JSON.stringify(step)}, applied: ${JSON.stringify(applied)}, values: p.values,
      highResMounted: p.highResMounted, highResFiles: ac.highResDb ? ac.highResDb.fileCount : null,
      usesHighRes: p.usesHighResLevel('environment'), registered: p.registeredCount,
      census: p.census(), stats: ac.textureManager.stats,
    };
  })()`) as Promise<Sample>;
}

async function apply(page: Page, step: string, prefs: Record<string, number>): Promise<Sample> {
  await page.evaluate(`(() => { window.__ac.gameUI.applyOptionsBulk(${JSON.stringify(prefs)}); })()`);
  if (prefs.environmentTextureDetail === 0) {
    // The on-demand client_highres.dat fetch (127 MB, OPFS-cached after the first run).
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const mounted = await page.evaluate(`window.__ac.textureSamplerPrefs.highResMounted`) as boolean;
      if (mounted) break;
      await page.waitForTimeout(1000);
    }
  }
  // Let the re-imaged textures reach the screen.
  await page.waitForTimeout(3500);
  return sample(page, step, prefs);
}

function topSizes(c: Census, n = 5): string {
  return Object.entries(c.sizes).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}×${v}`).join(' ');
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  const logs: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/highres|HiFi|Texture prefs/i.test(t)) logs.push(t); });
  console.log(`[core17hgcd] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17hgcd] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17hgcd] not in world yet — reloading (phantom-session retry)');
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
  console.log('[core17hgcd] in world; settling');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(4000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(2500);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);
  await page.waitForTimeout(800);

  const samples: Sample[] = [];
  const high = await apply(page, 'town-high', DEFAULTS);
  samples.push(high);
  console.log(`[core17hgcd] town High: mounted=${high.highResMounted} env=${JSON.stringify(high.census.environment)}`);
  await page.screenshot({ path: join(OUT, 'town-high.png') });

  const t0 = Date.now();
  const veryHigh = await apply(page, 'town-veryhigh', { ...DEFAULTS, environmentTextureDetail: 0 });
  samples.push(veryHigh);
  console.log(`[core17hgcd] town Very High (+${((Date.now() - t0) / 1000).toFixed(1)} s): mounted=${veryHigh.highResMounted} files=${veryHigh.highResFiles} uses=${veryHigh.usesHighRes} withHiRes=${veryHigh.census.environment.withHiRes} atHiRes=${veryHigh.census.environment.atHiRes} sizes ${topSizes(veryHigh.census.environment)}`);
  await page.screenshot({ path: join(OUT, 'town-veryhigh.png') });

  const again = await apply(page, 'town-high-again', DEFAULTS);
  samples.push(again);
  console.log(`[core17hgcd] town High again: atHiRes=${again.census.environment.atHiRes} sizes ${topSizes(again.census.environment)}`);
  await page.screenshot({ path: join(OUT, 'town-high-again.png') });

  // The REAL menu: Options › Config › Environment Texture Detail, one click (High → Very High).
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = 'config'; ui.optionsSettings.optionsTab = 'config';
    ui.toggleOptionsPanel();
  })()`);
  await page.waitForTimeout(600);
  const menuBefore = await page.evaluate(`(() => {
    const row = window.__ac.gameUI.optionsPanel.querySelector('[data-option-key="environmentTextureDetail"]');
    if (!row) return 'no-row';
    row.scrollIntoView({ block: 'center' });
    const plate = row.querySelector('.options-menu-value');
    return { plate: plate ? plate.textContent : 'no-plate', values: window.__ac.textureSamplerPrefs.values };
  })()`);
  const menuAfter = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const row = ui.optionsPanel.querySelector('[data-option-key="environmentTextureDetail"]');
    const field = row && row.querySelector('.options-menu-field');
    if (!field) return 'no-field';
    field.dispatchEvent(new Event('click', { bubbles: true }));
    const row2 = ui.optionsPanel.querySelector('[data-option-key="environmentTextureDetail"]');
    if (row2) row2.scrollIntoView({ block: 'center' });
    const plate = row2 && row2.querySelector('.options-menu-value');
    const p = window.__ac.textureSamplerPrefs;
    return { plate: plate ? plate.textContent : 'no-plate', setting: ui.optionsSettings.environmentTextureDetail, values: p.values, usesHighRes: p.usesHighResLevel('environment') };
  })()`);
  await page.waitForTimeout(3500);
  const menuSample = await sample(page, 'menu-click', {});
  samples.push(menuSample);
  await page.screenshot({ path: join(OUT, 'menu-click-frame.png') });
  console.log(`[core17hgcd] menu click: before=${JSON.stringify(menuBefore)} after=${JSON.stringify(menuAfter)} atHiRes=${menuSample.census.environment.atHiRes}`);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);
  await apply(page, 'town-restore', DEFAULTS);

  // Training Academy hall: the DXT1 walls carry 512² highres levels over 256².
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), DUNGEON);
  await page.waitForTimeout(9000);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(2000);
  const dHigh = await apply(page, 'dungeon-high', DEFAULTS);
  samples.push(dHigh);
  await page.screenshot({ path: join(OUT, 'dungeon-high.png') });
  const dVery = await apply(page, 'dungeon-veryhigh', { ...DEFAULTS, environmentTextureDetail: 0 });
  samples.push(dVery);
  await page.screenshot({ path: join(OUT, 'dungeon-veryhigh.png') });
  console.log(`[core17hgcd] dungeon: High sizes ${topSizes(dHigh.census.environment)} | Very High atHiRes=${dVery.census.environment.atHiRes}/${dVery.census.environment.withHiRes} sizes ${topSizes(dVery.census.environment)}`);
  const restored = await apply(page, 'dungeon-restore', DEFAULTS);
  samples.push(restored);
  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ menuBefore, menuAfter, samples, logs }, null, 2));
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
  h1{font-size:14px;margin:0 0 8px}
  h2{font-size:13px;margin:12px 0 6px;color:#9cf}
</style>`;

function crop(file: string, label: string, r: { x: number; y: number; w: number; h: number }, zoom: number): string {
  return `<div class="cell"><div class="lbl">${label}</div>
    <div class="clip" style="width:${r.w * zoom}px;height:${r.h * zoom}px">
      <img src="${dataUrl(file)}" style="position:absolute;left:${-r.x * zoom}px;top:${-r.y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/>
    </div></div>`;
}

interface Band { total: number; differing: number; maxDelta: number }
interface Diff { total: number; differing: number; maxDelta: number; world: Band; ground: Band; sky: Band; hud: Band }

/** Exact pixel diff: whole frame, the world band above the HUD (left of the radar), split sky/ground, and the HUD band. */
async function pixelDiff(page: Page, a: string, b: string): Promise<Diff> {
  return page.evaluate(`(async () => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const A = await load(${JSON.stringify(dataUrl(a))});
    const B = await load(${JSON.stringify(dataUrl(b))});
    const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
    const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const pa = px(A), pb = px(B);
    const x1 = Math.floor(w * 0.82), yWorld = Math.floor(h * 0.72), ySky = Math.floor(h * 0.40);
    const mk = () => ({ total: 0, differing: 0, maxDelta: 0 });
    const all = mk(), world = mk(), ground = mk(), sky = mk(), hud = mk();
    const add = (b, d) => { b.total++; if (d > 0) { b.differing++; if (d > b.maxDelta) b.maxDelta = d; } };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      add(all, d);
      if (x < x1 && y < yWorld) { add(world, d); add(y < ySky ? sky : ground, d); } else if (y >= yWorld) add(hud, d);
    }
    return { total: all.total, differing: all.differing, maxDelta: all.maxDelta, world, ground, sky, hud };
  })()`) as Promise<Diff>;
}

async function compose(): Promise<void> {
  const data = JSON.parse(readFileSync(join(OUT, 'samples.json'), 'utf8')) as { samples: Sample[]; menuAfter: unknown; menuBefore: unknown };
  const by = (step: string) => data.samples.find((s) => s.step === step)!;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1600 } });
  const pct = (b: Band) => (b.differing / Math.max(1, b.total) * 100).toFixed(2);
  const diffs: Record<string, Diff> = {};
  for (const [name, a, b] of [
    ['town: High vs Very High', 'town-high.png', 'town-veryhigh.png'],
    ['town: High vs High again (control)', 'town-high.png', 'town-high-again.png'],
    ['town: Very High vs menu click', 'town-veryhigh.png', 'menu-click-frame.png'],
    ['dungeon: High vs Very High', 'dungeon-high.png', 'dungeon-veryhigh.png'],
  ] as const) {
    if (existsSync(join(OUT, a)) && existsSync(join(OUT, b))) diffs[name] = await pixelDiff(page, join(OUT, a), join(OUT, b));
  }
  const diffLine = (name: string) => {
    const d = diffs[name];
    if (!d) return `${name}: n/a`;
    return `${name}: whole ${d.differing}/${d.total} (${pct(d)} %, max Δ ${d.maxDelta}); ground ${d.ground.differing}/${d.ground.total} (${pct(d.ground)} %, max Δ ${d.ground.maxDelta}); sky ${pct(d.sky)} %; HUD ${d.hud.differing}`;
  };
  const ref = (f: string) => existsSync(f) ? `<div class="cell"><div class="lbl">retail: ${f.replace(REPO + '/', '')}</div><img src="${dataUrl(f)}" style="width:520px;height:auto;border:1px solid #444"/></div>` : '';
  const full = (f: string, lbl: string) => `<div class="cell"><div class="lbl">${lbl}</div><img src="${dataUrl(join(OUT, f))}" style="width:640px;height:auto;border:1px solid #444"/></div>`;
  const th = by('town-high'), tv = by('town-veryhigh'), dh = by('dungeon-high'), dv = by('dungeon-veryhigh');
  const envLbl = (s: Sample) => `env detail ${s.values.environmentTextureDetail} · mounted ${s.highResMounted} · ${s.census.environment.atHiRes}/${s.census.environment.withHiRes} of ${s.census.environment.count} env textures at the highres level · sizes ${topSizes(s.census.environment, 4)}`;
  await page.setContent(`${CSS}<h1>CORE.17.h.g.c.d — client_highres.dat as the Very High texture level (Holtburg noon / Training Academy hall, SwiftShader)</h1>
    <h2>Holtburg — retail references | ours at High (default) | ours at Very High (highres level mounted on demand)</h2>
    <div class="row">${TOWN_REFS.map(ref).join('')}${full('town-high.png', `High — ${envLbl(th)}`)}${full('town-veryhigh.png', `Very High — ${envLbl(tv)}`)}</div>
    <h2>Player + ground 3x — High | Very High | High again | real menu click (Very High)</h2>
    <div class="row">${crop(join(OUT, 'town-high.png'), 'High', BUILDINGS, 3)}${crop(join(OUT, 'town-veryhigh.png'), 'Very High', BUILDINGS, 3)}${existsSync(join(OUT, 'town-high-again.png')) ? crop(join(OUT, 'town-high-again.png'), 'High again', BUILDINGS, 3) : ''}${existsSync(join(OUT, 'menu-click-frame.png')) ? crop(join(OUT, 'menu-click-frame.png'), `menu click → ${JSON.stringify(data.menuAfter)}`, BUILDINGS, 3) : ''}</div>
    <h2>Tree line 2x — High | Very High</h2>
    <div class="row">${crop(join(OUT, 'town-high.png'), 'High', TREES, 2)}${crop(join(OUT, 'town-veryhigh.png'), 'Very High', TREES, 2)}</div>
    <h2>Training Academy — retail references | ours at High | ours at Very High</h2>
    <div class="row">${DUNGEON_REFS.map(ref).join('')}${full('dungeon-high.png', `High — ${envLbl(dh)}`)}${full('dungeon-veryhigh.png', `Very High — ${envLbl(dv)}`)}</div>
    <h2>Hall wall 2x — High | Very High</h2>
    <div class="row">${crop(join(OUT, 'dungeon-high.png'), 'High', HALL, 2)}${crop(join(OUT, 'dungeon-veryhigh.png'), 'Very High', HALL, 2)}</div>
    <h2>Pixel diffs</h2>
    <div class="lbl">${Object.keys(diffs).map(diffLine).join('<br/>')}</div>`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17hgcd-highres-level-sidebyside.png'), fullPage: true });
  writeFileSync(join(OUT, 'diffs.json'), JSON.stringify(diffs, null, 2));
  for (const name of Object.keys(diffs)) console.log(`[core17hgcd] ${diffLine(name)}`);
  await browser.close();
}

if (process.argv.includes('--compose')) {
  compose().catch((e) => { console.error(e); process.exit(1); });
} else {
  captureLive().catch((e) => { console.error(e); process.exit(1); });
}
