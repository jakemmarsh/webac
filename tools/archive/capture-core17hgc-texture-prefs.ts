/**
 * CORE.17.h.g.c — live capture + side-by-side evidence for the Config
 * Texture Filtering / Landscape Texture Detail / Environment Texture Detail
 * menus driving the world's samplers.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright,
 * logs in like tools/capture-core17hgb-chat-font.ts, parks at Holtburg with
 * the scene harness' pins (noon, weather off, yaw 0), then:
 *   default-frame.png          whole frame at the retail defaults (Trilinear / Medium / High)
 *   filter-<m>.png             whole frame after applyOptionsBulk({textureFiltering: m}) for m = 0..3
 *                              (the same path Reset/Defaults use)
 *   land-<L>.png               whole frame per Landscape Texture Detail level L = 4..0
 *   env-<L>.png                whole frame per Environment Texture Detail level L = 4..0
 *   menu-click-frame.png       whole frame after opening Options › Config and CLICKING the
 *                              Texture Filtering menu once (Trilinear → Sharp)
 *   samples.json               per step: live pref values, mip bias, registry census
 *                              (per-kind texture counts + current image sizes + sampler filters)
 * `--compose` then builds core17hgc-texture-prefs-sidebyside.png (retail Holtburg
 * refs | ours default | every filter mode | every detail level, 2x crops of a
 * ground patch and the buildings) and core17hgc-ab-sidebyside.png (the harness
 * scenes before/after this change, with the pixel diff) from those files.
 *
 * Usage: npx tsx tools/capture-core17hgc-texture-prefs.ts
 *        npx tsx tools/capture-core17hgc-texture-prefs.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgc');
const RETAIL_REFS = [
  join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png'),
  join(REPO, 'reference/images/hud/rawg_07.jpg'),
  join(REPO, 'reference/images/hud/rawg_08.jpg'),
];
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

const FILTER_NAMES = ['Bilinear', 'Trilinear', 'Sharp', 'Anisotropic'];
const DETAIL_NAMES: Record<number, string> = { 4: 'Very Low', 3: 'Low', 2: 'Medium', 1: 'High', 0: 'Very High' };
const DEFAULTS = { textureFiltering: 1, landscapeTextureDetail: 2, environmentTextureDetail: 1 };

/** Crops (viewport px) — a ground patch in front of the player and the buildings across the square. */
const GROUND = { x: 560, y: 560, w: 320, h: 150 };
const BUILDINGS = { x: 520, y: 200, w: 420, h: 220 };

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
  step: string;
  applied: Record<string, number>;
  values: Record<string, number>;
  mipLodBias: number;
  registered: number;
  landscapeShift: number;
  environmentShift: number;
  census: Record<string, { count: number; sizes: Record<string, number>; minFilters: number[]; magFilters: number[]; anisotropy: number[] }>;
  maxAnisotropy: number;
}

async function apply(page: Page, step: string, prefs: Record<string, number>): Promise<Sample> {
  const s = await page.evaluate(`(() => {
    const ac = window.__ac;
    ac.gameUI.applyOptionsBulk(${JSON.stringify(prefs)});
    const p = ac.textureSamplerPrefs;
    return {
      step: ${JSON.stringify(step)}, applied: ${JSON.stringify(prefs)}, values: p.values, mipLodBias: p.mipLodBias,
      registered: p.registeredCount, landscapeShift: p.shiftFor('landscape'), environmentShift: p.shiftFor('environment'),
      census: p.census(), maxAnisotropy: p.getMaxAnisotropy(),
    };
  })()`) as Sample;
  // Let the re-uploaded textures reach the screen (a detail change rebuilds every texture).
  await page.waitForTimeout(2500);
  return s;
}

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  console.log(`[core17hgc] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17hgc] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17hgc] not in world yet — reloading (phantom-session retry)');
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
  console.log('[core17hgc] in world; settling');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(4000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(2500);
  // The options panel's open state persists across sessions (the scene
  // harness leaves it open after its Options captures); close it so the
  // whole-screen frames show the bare HUD over the world.
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);
  await page.waitForTimeout(800);

  const samples: Sample[] = [];
  const initial = await apply(page, 'default', DEFAULTS);
  samples.push(initial);
  console.log(`[core17hgc] defaults: ${JSON.stringify(initial.values)} bias=${initial.mipLodBias} registered=${initial.registered} maxAniso=${initial.maxAnisotropy}`);
  console.log(`[core17hgc] census: ${JSON.stringify(initial.census)}`);
  await page.screenshot({ path: join(OUT, 'default-frame.png') });

  for (const m of [0, 1, 2, 3]) {
    const s = await apply(page, `filter-${m}`, { ...DEFAULTS, textureFiltering: m });
    await page.screenshot({ path: join(OUT, `filter-${m}.png`) });
    console.log(`[core17hgc] ${FILTER_NAMES[m]}: bias=${s.mipLodBias} land=${JSON.stringify(s.census.landscape.minFilters)}/${JSON.stringify(s.census.landscape.anisotropy)} env=${JSON.stringify(s.census.environment.minFilters)}/${JSON.stringify(s.census.environment.anisotropy)}`);
    samples.push(s);
  }
  for (const L of [4, 3, 2, 1, 0]) {
    const s = await apply(page, `land-${L}`, { ...DEFAULTS, landscapeTextureDetail: L });
    await page.screenshot({ path: join(OUT, `land-${L}.png`) });
    console.log(`[core17hgc] landscape ${DETAIL_NAMES[L]} (shift ${s.landscapeShift}): ${JSON.stringify(s.census.landscape.sizes)}`);
    samples.push(s);
  }
  for (const L of [4, 3, 2, 1, 0]) {
    const s = await apply(page, `env-${L}`, { ...DEFAULTS, environmentTextureDetail: L });
    await page.screenshot({ path: join(OUT, `env-${L}.png`) });
    const sizes = Object.entries(s.census.environment.sizes).sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`[core17hgc] environment ${DETAIL_NAMES[L]} (shift ${s.environmentShift}): top sizes ${JSON.stringify(sizes)}`);
    samples.push(s);
  }

  // Back to the defaults, then the REAL menu: open Options › Config and click Texture Filtering once.
  await apply(page, 'restore', DEFAULTS);
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = 'config'; ui.optionsSettings.optionsTab = 'config';
    ui.toggleOptionsPanel();
  })()`);
  await page.waitForTimeout(600);
  const menuBefore = await page.evaluate(`(() => {
    const row = window.__ac.gameUI.optionsPanel.querySelector('[data-option-key="textureFiltering"]');
    if (!row) return 'no-row';
    row.scrollIntoView({ block: 'center' });
    const plate = row.querySelector('.options-menu-value');
    return { plate: plate ? plate.textContent : 'no-plate', values: window.__ac.textureSamplerPrefs.values };
  })()`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'menu-before-frame.png') });
  const menuAfter = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const row = ui.optionsPanel.querySelector('[data-option-key="textureFiltering"]');
    const field = row && row.querySelector('.options-menu-field');
    if (!field) return 'no-field';
    field.dispatchEvent(new Event('click', { bubbles: true }));
    const row2 = ui.optionsPanel.querySelector('[data-option-key="textureFiltering"]');
    if (row2) row2.scrollIntoView({ block: 'center' });
    const p = window.__ac.textureSamplerPrefs;
    return { setting: ui.optionsSettings.textureFiltering, values: p.values, mipLodBias: p.mipLodBias };
  })()`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'menu-click-frame.png') });
  console.log(`[core17hgc] menu click: before=${JSON.stringify(menuBefore)} after=${JSON.stringify(menuAfter)}`);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);
  const restored = await apply(page, 'restored', DEFAULTS);
  samples.push(restored);
  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ menuBefore, menuAfter, samples }, null, 2));
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
  .full img{display:block;width:760px;height:auto;border:1px solid #444}
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
interface Diff { total: number; differing: number; maxDelta: number; world: Band; ground: Band; sky: Band }

/**
 * Exact pixel diff of two same-size PNGs in the page: whole frame, the
 * world band above the HUD (y < 72 %, left of the radar), and that band
 * split into sky (y < 40 %) and ground (y ≥ 40 % — terrain, trees, buildings,
 * the player). The sky/cloud layer drifts with wall-clock between identical
 * harness runs (CORE.17.r), so the ground band is the texture-change signal.
 */
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
    const all = mk(), world = mk(), ground = mk(), sky = mk();
    const add = (b, d) => { b.total++; if (d > 0) { b.differing++; if (d > b.maxDelta) b.maxDelta = d; } };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      add(all, d);
      if (x < x1 && y < yWorld) { add(world, d); add(y < ySky ? sky : ground, d); }
    }
    return { total: all.total, differing: all.differing, maxDelta: all.maxDelta, world, ground, sky };
  })()`) as Promise<Diff>;
}

async function compose(): Promise<void> {
  const samples = JSON.parse(readFileSync(join(OUT, 'samples.json'), 'utf8')) as { samples: Sample[]; menuAfter: unknown };
  const by = (step: string) => samples.samples.find((s) => s.step === step);
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2600, height: 1600 } });

  const refCells = RETAIL_REFS.filter(existsSync).map((f) =>
    `<div class="cell"><div class="lbl">retail: ${f.replace(REPO + '/', '')}</div><img src="${dataUrl(f)}" style="width:640px;height:auto;border:1px solid #444"/></div>`);
  const filterCells: string[] = [];
  for (const m of [0, 1, 2, 3]) {
    const f = join(OUT, `filter-${m}.png`);
    if (!existsSync(f)) continue;
    const s = by(`filter-${m}`)!;
    const land = s.census.landscape;
    const lbl = `${FILTER_NAMES[m]} (Render.TextureFiltering ${m}) · min ${JSON.stringify(land.minFilters)} aniso ${JSON.stringify(land.anisotropy)} · mip bias ${s.mipLodBias} · ${s.registered} textures`;
    filterCells.push(crop(f, `${lbl} — ground 2x`, GROUND, 2));
    filterCells.push(crop(f, `${FILTER_NAMES[m]} — buildings 2x`, BUILDINGS, 2));
  }
  const landCells: string[] = [];
  for (const L of [4, 3, 2, 1, 0]) {
    const f = join(OUT, `land-${L}.png`);
    if (!existsSync(f)) continue;
    const s = by(`land-${L}`)!;
    landCells.push(crop(f, `Landscape ${DETAIL_NAMES[L]} (${L}, shift ${s.landscapeShift}) · sizes ${JSON.stringify(s.census.landscape.sizes)} — ground 2x`, GROUND, 2));
  }
  const envCells: string[] = [];
  for (const L of [4, 3, 2, 1, 0]) {
    const f = join(OUT, `env-${L}.png`);
    if (!existsSync(f)) continue;
    const s = by(`env-${L}`)!;
    const top = Object.entries(s.census.environment.sizes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(' ');
    envCells.push(crop(f, `Environment ${DETAIL_NAMES[L]} (${L}, shift ${s.environmentShift}) · ${top} — buildings 2x`, BUILDINGS, 2));
  }
  await page.setContent(`${CSS}<h1>CORE.17.h.g.c — Texture Filtering / Landscape + Environment Texture Detail → the world's samplers (Holtburg, noon, weather off)</h1>
    <h2>Retail references | ours at the retail defaults (Trilinear / Medium / High — unchanged output)</h2>
    <div class="row">${refCells.join('')}<div class="cell"><div class="lbl">ours, defaults (default-frame.png)</div><img src="${dataUrl(join(OUT, 'default-frame.png'))}" style="width:640px;height:auto;border:1px solid #444"/></div></div>
    <h2>Texture Filtering — every choice through applyOptionsBulk (the Reset/Defaults path)</h2>
    <div class="row">${filterCells.join('')}</div>
    <h2>Landscape Texture Detail — Very Low … Very High (shifts relative to the covenant-pinned Medium)</h2>
    <div class="row">${landCells.join('')}</div>
    <h2>Environment Texture Detail — Very Low … Very High (High = today's portal level; Very High needs client_highres.dat)</h2>
    <div class="row">${envCells.join('')}</div>`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17hgc-texture-prefs-sidebyside.png'), fullPage: true });

  // Before/after A/B of the harness scenes at the defaults + the real menu click frames.
  const abCells: string[] = [];
  const diffs: Record<string, Diff> = {};
  for (const scene of ['world-town-day', 'world-dungeon', 'world-town-far']) {
    const a = join(OUT, `before-${scene}.png`);
    const b = join(OUT, `after-${scene}.png`);
    if (!existsSync(a) || !existsSync(b)) continue;
    const d = await pixelDiff(page, a, b);
    diffs[scene] = d;
    const pct = (bd: Band) => (bd.differing / Math.max(1, bd.total) * 100).toFixed(3);
    abCells.push(`<div class="cell"><div class="lbl">${scene} BEFORE (main @ 4a34945)</div><img src="${dataUrl(a)}"/></div>`);
    abCells.push(`<div class="cell"><div class="lbl">${scene} AFTER (this change, defaults) — whole frame ${d.differing}/${d.total} px differ (${pct(d)} %, max Δ ${d.maxDelta}); world band ${pct(d.world)} % (max Δ ${d.world.maxDelta}); sky ${pct(d.sky)} % (max Δ ${d.sky.maxDelta}); GROUND ${d.ground.differing}/${d.ground.total} (${pct(d.ground)} %, max Δ ${d.ground.maxDelta})</div><img src="${dataUrl(b)}"/></div>`);
  }
  const menuCells = ['menu-before-frame.png', 'menu-click-frame.png']
    .filter((f) => existsSync(join(OUT, f)))
    .map((f) => `<div class="cell"><div class="lbl">${f}${f.startsWith('menu-click') ? ` — after one click on Texture Filtering: ${JSON.stringify(samples.menuAfter)}` : ''}</div><img src="${dataUrl(join(OUT, f))}"/></div>`);
  await page.setContent(`${CSS}<h1>CORE.17.h.g.c — whole-screen A/B at the retail defaults (capture-ui-screens.ts --scenes) + the real Options › Config menu click</h1>
    <div class="row full">${abCells.join('')}</div>
    <h2>Options › Config: before | after one click on Texture Filtering (Trilinear → Sharp)</h2>
    <div class="row full">${menuCells.join('')}</div>`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17hgc-ab-sidebyside.png'), fullPage: true });
  writeFileSync(join(OUT, 'ab-diff.json'), JSON.stringify(diffs, null, 2));
  console.log(`[core17hgc] A/B diffs: ${JSON.stringify(diffs)}`);
  await browser.close();
  console.log(`[core17hgc] wrote side-by-sides to ${OUT}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (process.argv.includes('--compose')) { await compose(); return; }
  await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
