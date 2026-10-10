/**
 * CORE.17.h.g.c.c — live capture + side-by-side evidence for retail's
 * per-part degrade (LOD) system.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright,
 * logs in like tools/capture-core17hgcb-detail-texturing.ts, parks at
 * Holtburg with the scene harness' pins (noon, weather off), then:
 *   town-lod.png / town-nolod.png          whole frame, yaw 0, degrade ON (retail
 *                                          defaults: distance 50, bias 0) / degrades
 *                                          disabled (SmartBox::DisableDegrades — every
 *                                          part at level 0, the pre-change picture)
 *   town-alt-lod.png / town-alt-nolod.png  the same at yaw 2.4
 *   town-far-lod.png                        yaw 0 with Degrade Distance 100 through the
 *                                          REAL Reset/Defaults path (applyOptionsBulk)
 *   town-bias-lod.png                       yaw 0 with Adaptive Degrade Bias +1
 *   menu-frame.png                          Options › Config open on the rows
 *   samples.json                            per step: live prefs / bias / deg_mul, the
 *                                          pooled-instance census per level, the
 *                                          per-object part census, renderer.info
 *                                          (draw calls / triangles) and the ON/OFF
 *                                          pixel diff per frame band
 * `--compose` builds core17hgcc-degrade-sidebyside.png (retail refs | ours LOD
 * | ours no-LOD, with crops of the far tree line) from those files.
 *
 * Usage: npx tsx tools/capture-core17hgcc-degrade-lod.ts
 *        npx tsx tools/capture-core17hgcc-degrade-lod.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgcc');
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
  info: { calls: number; triangles: number; lodMeshes: number; visibleLodMeshes: number };
}

async function sample(page: Page, step: string): Promise<State> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const info = ac.sceneManager.renderer.info.render;
    let lodMeshes = 0, visibleLodMeshes = 0;
    ac.sceneManager.scene.traverse((o) => { if (o.name && /_lod\\d+$/.test(o.name)) { lodMeshes++; if (o.visible) visibleLodMeshes++; } });
    const s = ac.gameUI.optionsSettings;
    return {
      step: ${JSON.stringify(step)},
      disabled: ac.degradeLod.disabled,
      settings: { degradeDistance: s.degradeDistance, adaptiveDegradeBias: s.adaptiveDegradeBias, adaptiveDegrade: s.adaptiveDegrade },
      census: ac.lodCensus(),
      info: { calls: info.calls, triangles: info.triangles, lodMeshes, visibleLodMeshes },
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
  console.log(`[core17hgcc] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17hgcc] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17hgcc] not in world yet — reloading (phantom-session retry)');
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
  console.log('[core17hgcc] in world; settling');
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
    console.log(`[core17hgcc] ${step}: disabled=${s.disabled} settings=${JSON.stringify(s.settings)} info=${JSON.stringify(s.info)}`);
    console.log(`[core17hgcc]   census=${JSON.stringify(s.census)}`);
  };

  // Retail defaults through the real Reset/Defaults path.
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 50, adaptiveDegradeBias: 0, adaptiveDegrade: false }));
  await page.waitForTimeout(1200);
  await setDisabled(page, false);
  await shoot('town-lod', 'town yaw0 LOD (retail defaults)');
  await setDisabled(page, true);
  await shoot('town-nolod', 'town yaw0 degrades disabled (pre-change picture)');
  diffs.town = await pixelDiff(page, join(OUT, 'town-lod.png'), join(OUT, 'town-nolod.png'));
  console.log(`[core17hgcc] diff town: ${JSON.stringify(diffs.town)}`);

  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 2.4);
  await page.waitForTimeout(2500);
  await setDisabled(page, false);
  await shoot('town-alt-lod', 'town yaw2.4 LOD');
  await setDisabled(page, true);
  await shoot('town-alt-nolod', 'town yaw2.4 degrades disabled');
  diffs.townAlt = await pixelDiff(page, join(OUT, 'town-alt-lod.png'), join(OUT, 'town-alt-nolod.png'));
  console.log(`[core17hgcc] diff town-alt: ${JSON.stringify(diffs.townAlt)}`);

  // The real preference paths: Degrade Distance 100 (Far) and bias +1 (Detail).
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(2500);
  await setDisabled(page, false);
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 100 }));
  await page.waitForTimeout(1500);
  await shoot('town-far-lod', 'town yaw0 Degrade Distance 100');
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 50, adaptiveDegradeBias: 1 }));
  await page.waitForTimeout(1500);
  await shoot('town-bias-lod', 'town yaw0 bias +1');
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ adaptiveDegradeBias: 0, adaptiveDegrade: true }));
  await page.waitForTimeout(3000);
  await shoot('town-auto-lod', 'town yaw0 Adaptive Degrade on (deg_mul from the SwiftShader frame rate)');
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ adaptiveDegrade: false }));
  await page.waitForTimeout(1000);

  // Options › Config open on the rows for the record.
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.toggleOptionsPanel(); })()`);
  await page.waitForTimeout(1200);
  await page.click('[data-options-tab="config"]').catch(() => { /* tab may already be active */ });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, 'menu-frame.png') });
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);

  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ samples, diffs, logs }, null, 2));
  console.log(`[core17hgcc] wrote ${OUT}/samples.json`);
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
    const c = st?.census as { scenery?: { instances: number; drawn: number; byLevel: Record<string, number> }; statics?: { instances: number; drawn: number }; buildings?: { instances: number; drawn: number }; parts?: Record<string, number>; prefs?: unknown; bias?: number } | undefined;
    return `${name} — ${st?.info.calls ?? '?'} draw calls / ${((st?.info.triangles ?? 0) / 1e6).toFixed(2)} M tris; scenery ${c?.scenery?.drawn ?? '?'} of ${c?.scenery?.instances ?? '?'} drawn ${JSON.stringify(c?.scenery?.byLevel ?? {})}, statics ${c?.statics?.drawn ?? '?'}/${c?.statics?.instances ?? '?'}, buildings ${c?.buildings?.drawn ?? '?'}/${c?.buildings?.instances ?? '?'}, parts ${JSON.stringify(c?.parts ?? {})}`;
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
  <h1>CORE.17.h.g.c.c — DegradeInfo part LOD: retail refs | ours with retail's degrade system | ours with degrades disabled</h1>
  <p>${line('LOD (distance 50, bias 0)', 'town yaw0 LOD')}<br>${line('degrades disabled', 'town yaw0 degrades')}<br>${line('Degrade Distance 100', 'town yaw0 Degrade Distance')}<br>${line('bias +1', 'town yaw0 bias')}<br>
  LOD vs disabled pixel diff (max-channel Δ &gt; 3): town ${JSON.stringify(samples.diffs.town)}; yaw 2.4 ${JSON.stringify(samples.diffs.townAlt)}</p>
  <h2>Retail references</h2><div class="row">${refs}</div>
  <h2>Holtburg, yaw 0 — LOD | disabled | Degrade Distance 100 | bias +1</h2>
  <div class="row">${full(join(OUT, 'town-lod.png'), 'ours — retail defaults (distance 50, bias 0)')}${full(join(OUT, 'town-nolod.png'), 'ours — degrades disabled (every part at level 0)')}${full(join(OUT, 'town-far-lod.png'), 'ours — Degrade Distance 100 (Far)')}${full(join(OUT, 'town-bias-lod.png'), 'ours — Adaptive Degrade Bias +1 (Detail)')}</div>
  <h2>Horizon / tree line crops (2×)</h2>
  <div class="row">${crop(join(OUT, 'town-lod.png'), 'LOD', HORIZON, 2)}${crop(join(OUT, 'town-nolod.png'), 'disabled', HORIZON, 2)}</div>
  <h2>Near scenery crops (2×)</h2>
  <div class="row">${crop(join(OUT, 'town-lod.png'), 'LOD', NEAR, 2)}${crop(join(OUT, 'town-nolod.png'), 'disabled', NEAR, 2)}</div>
  <h2>Holtburg, yaw 2.4 — LOD | disabled</h2>
  <div class="row">${full(join(OUT, 'town-alt-lod.png'), 'ours — LOD')}${full(join(OUT, 'town-alt-nolod.png'), 'ours — disabled')}</div>
  <h2>Options › Config rows</h2>
  <div class="row">${full(join(OUT, 'menu-frame.png'), 'Adaptive Degrade / Adaptive Degrade Bias / Degrade Distance rows (live consumers)')}</div>`;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2200, height: 1200 } });
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17hgcc-degrade-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17hgcc] wrote ${OUT}/core17hgcc-degrade-sidebyside.png`);
}

if (process.argv.includes('--compose')) compose().catch(e => { console.error(e); process.exit(1); });
else captureLive().catch(e => { console.error(e); process.exit(1); });
