/**
 * CORE.17.h.g.c.c.c — live capture + side-by-side evidence that the Degrade
 * Distance slider MOVES the LOD thresholds (get_degrade subtracts it) and
 * that level 0 draws degrades[0].gfxobj_id.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright
 * like tools/capture-core17hgcc-degrade-lod.ts, parks at Holtburg (noon,
 * weather off), then through the REAL options path (applyOptionsBulk):
 *   town-dd50.png    yaw 0, Degrade Distance 50 (retail default)
 *   town-dd100.png   yaw 0, Degrade Distance 100 (Far)
 *   town-dd0.png     yaw 0, Degrade Distance 0 (Near)
 *   town-nolod.png   yaw 0, degrades disabled (every part at level 0)
 *   samples.json     per step: live prefs, the pooled-instance census per level
 *                    (scenery / statics / buildings), the part census, the
 *                    number of level-0 substitutions live (families whose
 *                    chain names another level-0 GfxObj), renderer.info, and
 *                    the pixel diffs dd50↔dd100 / dd50↔dd0 per frame band
 * `--compose` builds core17hgccc-degrade-distance-sidebyside.png (retail refs
 * | dd 0 | dd 50 | dd 100 | disabled, with horizon crops) from those files.
 *
 * Usage: npx tsx tools/capture-core17hgccc-degrade-distance.ts
 *        npx tsx tools/capture-core17hgccc-degrade-distance.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgccc');
const TOWN_REFS = [
  join(REPO, 'reference/images/hud/rawg_07.jpg'),
  join(REPO, 'reference/images/hud/gw_01.jpg'),
  join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png'),
];
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

/** Crops (viewport px): the far tree line / horizon, the near scenery. */
const HORIZON = { x: 300, y: 150, w: 900, h: 220 };
const NEAR = { x: 400, y: 380, w: 700, h: 260 };

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
  disabled: boolean;
  settings: { degradeDistance: unknown; adaptiveDegradeBias: unknown; adaptiveDegrade: unknown };
  census: unknown;
  info: { calls: number; triangles: number; lodMeshes: number; visibleLodMeshes: number; lod0Meshes: number; visibleLod0Meshes: number };
}

async function sample(page: Page, step: string): Promise<State> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const info = ac.sceneManager.renderer.info.render;
    let lodMeshes = 0, visibleLodMeshes = 0, lod0Meshes = 0, visibleLod0Meshes = 0;
    ac.sceneManager.scene.traverse((o) => {
      if (o.name && /_lod\\d+$/.test(o.name)) { lodMeshes++; if (o.visible) visibleLodMeshes++; }
      if (o.name && /_lod0$/.test(o.name)) { lod0Meshes++; if (o.visible) visibleLod0Meshes++; }
    });
    const s = ac.gameUI.optionsSettings;
    return {
      step: ${JSON.stringify(step)},
      disabled: ac.degradeLod.disabled,
      settings: { degradeDistance: s.degradeDistance, adaptiveDegradeBias: s.adaptiveDegradeBias, adaptiveDegrade: s.adaptiveDegrade },
      census: ac.lodCensus(),
      info: { calls: info.calls, triangles: info.triangles, lodMeshes, visibleLodMeshes, lod0Meshes, visibleLod0Meshes },
    };
  })()`) as Promise<State>;
}

async function setDisabled(page: Page, disabled: boolean): Promise<void> {
  await page.evaluate((v) => {
    const ac = (window as any).__ac;
    ac.degradeLod.disabled = v;
    if (v) ac.degradeLod.resetParts();
  }, disabled);
  await page.waitForTimeout(1500);
}

interface Band { total: number; differing: number; maxDelta: number; meanDelta: number }
interface Diff { whole: Band; sky: Band; horizon: Band; near: Band }

async function pixelDiff(page: Page, a: string, b: string): Promise<Diff> {
  return page.evaluate(`(async () => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [ia, ib] = await Promise.all([load(${JSON.stringify(dataUrl(a))}), load(${JSON.stringify(dataUrl(b))})]);
    const w = ia.width, h = ia.height;
    const cv = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const A = cv(ia), B = cv(ib);
    const band = (x0, y0, bw, bh) => {
      let differing = 0, maxDelta = 0, sum = 0, total = 0;
      for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) {
        const i = (y * w + x) * 4;
        const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i+1] - B[i+1]), Math.abs(A[i+2] - B[i+2]));
        total++; sum += d; if (d > 3) differing++; if (d > maxDelta) maxDelta = d;
      }
      return { total, differing, maxDelta, meanDelta: +(sum / Math.max(1, total)).toFixed(3) };
    };
    return { whole: band(0, 0, w, h), sky: band(0, 0, w, 120), horizon: band(${HORIZON.x}, ${HORIZON.y}, ${HORIZON.w}, ${HORIZON.h}), near: band(${NEAR.x}, ${NEAR.y}, ${NEAR.w}, ${NEAR.h}) };
  })()`) as Promise<Diff>;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  const logs: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('Degrade prefs')) logs.push(t); });
  console.log(`[core17hgccc] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17hgccc] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17hgccc] not in world yet — reloading (phantom-session retry)');
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
  console.log('[core17hgccc] in world; settling');
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
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    const s = await sample(page, step);
    samples.push(s);
    console.log(`[core17hgccc] ${step}: disabled=${s.disabled} settings=${JSON.stringify(s.settings)} info=${JSON.stringify(s.info)}`);
    console.log(`[core17hgccc]   census=${JSON.stringify(s.census)}`);
  };

  // Through the real options path: 50 (default) → 100 (Far) → 0 (Near) → disabled.
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 50, adaptiveDegradeBias: 0, adaptiveDegrade: false }));
  await page.waitForTimeout(1200);
  await setDisabled(page, false);
  await shoot('town-dd50', 'town yaw0 Degrade Distance 50 (retail default)');
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 100 }));
  await page.waitForTimeout(1500);
  await shoot('town-dd100', 'town yaw0 Degrade Distance 100 (Far)');
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 0 }));
  await page.waitForTimeout(1500);
  await shoot('town-dd0', 'town yaw0 Degrade Distance 0 (Near)');
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 50 }));
  await page.waitForTimeout(1200);
  await setDisabled(page, true);
  await shoot('town-nolod', 'town yaw0 degrades disabled (every part at level 0)');
  await setDisabled(page, false);
  diffs.dd50_dd100 = await pixelDiff(page, join(OUT, 'town-dd50.png'), join(OUT, 'town-dd100.png'));
  diffs.dd50_dd0 = await pixelDiff(page, join(OUT, 'town-dd50.png'), join(OUT, 'town-dd0.png'));
  diffs.dd50_nolod = await pixelDiff(page, join(OUT, 'town-dd50.png'), join(OUT, 'town-nolod.png'));
  console.log(`[core17hgccc] diffs: ${JSON.stringify(diffs)}`);

  // Options › Config open on the rows for the record.
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.toggleOptionsPanel(); })()`);
  await page.waitForTimeout(1200);
  await page.click('[data-options-tab="config"]').catch(() => { /* tab may already be active */ });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, 'menu-frame.png') });
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);

  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ samples, diffs, logs }, null, 2));
  console.log(`[core17hgccc] wrote ${OUT}/samples.json`);
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

function crop(file: string, label: string, r: { x: number; y: number; w: number; h: number }, zoom: number): string {
  return `<figure class="crop"><div class="win" style="width:${r.w * zoom}px;height:${r.h * zoom}px">`
    + `<img src="${dataUrl(file)}" style="width:${VIEW.width * zoom}px;height:${VIEW.height * zoom}px;margin-left:${-r.x * zoom}px;margin-top:${-r.y * zoom}px"></div>`
    + `<figcaption>${label}</figcaption></figure>`;
}

function full(file: string, label: string, cls = 'full'): string {
  return `<figure class="${cls}"><img src="${dataUrl(file)}"><figcaption>${label}</figcaption></figure>`;
}

async function compose(): Promise<void> {
  const samples = JSON.parse(readFileSync(join(OUT, 'samples.json'), 'utf8')) as { samples: State[]; diffs: Record<string, Diff> };
  const refs = TOWN_REFS.filter(existsSync).map(f => full(f, `retail: ${f.split('/').pop()}`, 'ref')).join('');
  const s = (step: string) => samples.samples.find(x => x.step.startsWith(step));
  const line = (name: string, step: string) => {
    const st = s(step);
    const c = st?.census as { scenery?: { instances: number; drawn: number; byLevel: Record<string, number> }; statics?: { instances: number; drawn: number; byLevel: Record<string, number> }; buildings?: { instances: number; drawn: number }; parts?: Record<string, number> } | undefined;
    return `${name} — ${st?.info.calls ?? '?'} draw calls / ${((st?.info.triangles ?? 0) / 1e6).toFixed(2)} M tris; scenery ${c?.scenery?.drawn ?? '?'} of ${c?.scenery?.instances ?? '?'} drawn ${JSON.stringify(c?.scenery?.byLevel ?? {})}, statics ${c?.statics?.drawn ?? '?'}/${c?.statics?.instances ?? '?'} ${JSON.stringify(c?.statics?.byLevel ?? {})}, buildings ${c?.buildings?.drawn ?? '?'}/${c?.buildings?.instances ?? '?'}, parts ${JSON.stringify(c?.parts ?? {})}, level-0 substitutions ${st?.info.visibleLod0Meshes ?? '?'} of ${st?.info.lod0Meshes ?? '?'} lod0 meshes visible`;
  };
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{background:#111;color:#ddd;font:13px system-ui;margin:12px}
    h1{font-size:16px;margin:6px 0} h2{font-size:14px;margin:14px 0 4px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start}
    figure{margin:0} figcaption{font-size:11px;color:#aaa;margin-top:3px;max-width:520px}
    .ref img{max-width:520px;max-height:400px} .full img{width:520px}
    .win{overflow:hidden;border:1px solid #444} .crop img{display:block;max-width:none}
    p{max-width:1500px;color:#bbb}
  </style>
  <h1>CORE.17.h.g.c.c.c — Degrade Distance subtracted (thresholds move with the slider), level 0 = degrades[0]: retail refs | ours at 0 / 50 / 100 / disabled</h1>
  <p>${line('Degrade Distance 0 (Near)', 'town yaw0 Degrade Distance 0')}<br>${line('Degrade Distance 50 (default)', 'town yaw0 Degrade Distance 50')}<br>${line('Degrade Distance 100 (Far)', 'town yaw0 Degrade Distance 100')}<br>${line('degrades disabled', 'town yaw0 degrades')}<br>
  pixel diffs (max-channel Δ &gt; 3): 50↔100 ${JSON.stringify(samples.diffs.dd50_dd100)}; 50↔0 ${JSON.stringify(samples.diffs.dd50_dd0)}; 50↔disabled ${JSON.stringify(samples.diffs.dd50_nolod)}</p>
  <h2>Retail references</h2><div class="row">${refs}</div>
  <h2>Holtburg, yaw 0 — Degrade Distance 0 | 50 | 100 | disabled</h2>
  <div class="row">${full(join(OUT, 'town-dd0.png'), 'ours — Degrade Distance 0 (Near)')}${full(join(OUT, 'town-dd50.png'), 'ours — Degrade Distance 50 (retail default)')}${full(join(OUT, 'town-dd100.png'), 'ours — Degrade Distance 100 (Far)')}${full(join(OUT, 'town-nolod.png'), 'ours — degrades disabled (every part at level 0)')}</div>
  <h2>Horizon / tree line crops (2×) — 0 | 50 | 100 | disabled</h2>
  <div class="row">${crop(join(OUT, 'town-dd0.png'), 'DD 0', HORIZON, 2)}${crop(join(OUT, 'town-dd50.png'), 'DD 50', HORIZON, 2)}${crop(join(OUT, 'town-dd100.png'), 'DD 100', HORIZON, 2)}${crop(join(OUT, 'town-nolod.png'), 'disabled', HORIZON, 2)}</div>
  <h2>Near scenery crops (2×) — 0 | 50 | 100 | disabled</h2>
  <div class="row">${crop(join(OUT, 'town-dd0.png'), 'DD 0', NEAR, 2)}${crop(join(OUT, 'town-dd50.png'), 'DD 50', NEAR, 2)}${crop(join(OUT, 'town-dd100.png'), 'DD 100', NEAR, 2)}${crop(join(OUT, 'town-nolod.png'), 'disabled', NEAR, 2)}</div>
  <h2>Options › Config rows</h2>
  <div class="row">${full(join(OUT, 'menu-frame.png'), 'Degrade Distance row (the live consumer)')}</div>`;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2200, height: 1200 } });
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17hgccc-degrade-distance-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17hgccc] wrote ${OUT}/core17hgccc-degrade-distance-sidebyside.png`);
}

if (process.argv.includes('--compose')) compose().catch(e => { console.error(e); process.exit(1); });
else captureLive().catch(e => { console.error(e); process.exit(1); });
