/**
 * CORE.17.h.g.c.c.a — live capture + side-by-side evidence for the degrade
 * (LOD) system on the remaining part paths: per-cell furniture pools and
 * the bare-GfxObj fallback groups, plus the object-distance branch.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright
 * like tools/capture-core17hgcc-degrade-lod.ts, then:
 *   dungeon-lod.png / dungeon-nolod.png   Training Academy (the world-dungeon
 *                                         harness pin), degrades ON at the retail
 *                                         defaults / disabled
 *   dungeon-far-lod.png                   the same cell from the far end of the
 *                                         corridor (furniture past its levels)
 *   town-lod.png / town-nolod.png         Holtburg yaw 0 (cottage interiors seen
 *                                         through doors, statics fallbacks)
 *   samples.json                          per step: live prefs / bias / deg_mul,
 *                                         SetDegradeLevelInternal's derived caps +
 *                                         cut-offs, the pooled census (scenery /
 *                                         statics / buildings / CELLS / parts),
 *                                         renderer.info, ON/OFF pixel diffs
 * `--compose` builds core17hgcca-cell-lod-sidebyside.png (retail dungeon refs |
 * ours LOD | ours no-LOD, crops) from those files.
 *
 * Usage: npx tsx tools/capture-core17hgcca-cell-lod.ts
 *        npx tsx tools/capture-core17hgcca-cell-lod.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgcca');
const DUNGEON_REFS = ['rawg_02.jpg', 'rawg_04.jpg', 'rawg_09.jpg'].map(f => join(REPO, 'reference/images/hud', f));
const TOWN_REFS = [join(REPO, 'reference/images/hud/rawg_07.jpg'), join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png')];
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
/** The world-dungeon harness pin (capture-ui-screens.ts) + a spot down the corridor. */
const DUNGEON = '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';
const DUNGEON_FAR = '@teleloc 0x86020115 [190 -262 -11.5] 1 0 0 0';
const HOLTBURG = '@telepoi holtburg';

const CENTER = { x: 380, y: 160, w: 800, h: 420 };

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
  info: { calls: number; triangles: number; furnMeshes: number; furnVisible: number; furnLevelMeshes: number; furnLevelVisible: number };
}

async function sample(page: Page, step: string): Promise<State> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const info = ac.sceneManager.renderer.info.render;
    let furnMeshes = 0, furnVisible = 0, furnLevelMeshes = 0, furnLevelVisible = 0;
    ac.sceneManager.scene.traverse((o) => {
      if (!o.name || !o.name.startsWith('envfurninst_')) return;
      if (/_lod\\d+$/.test(o.name)) { furnLevelMeshes++; if (o.visible && o.count > 0) furnLevelVisible++; }
      else { furnMeshes++; if (o.visible && o.count > 0) furnVisible++; }
    });
    const s = ac.gameUI.optionsSettings;
    return {
      step: ${JSON.stringify(step)},
      disabled: ac.degradeLod.disabled,
      settings: { degradeDistance: s.degradeDistance, adaptiveDegradeBias: s.adaptiveDegradeBias, adaptiveDegrade: s.adaptiveDegrade },
      census: ac.lodCensus(),
      info: { calls: info.calls, triangles: info.triangles, furnMeshes, furnVisible, furnLevelMeshes, furnLevelVisible },
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
interface Diff { whole: Band; hud: Band; center: Band }

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
    return { whole: band(0, 0, w, h), hud: band(0, h - 120, w, 120), center: band(${CENTER.x}, ${CENTER.y}, ${CENTER.w}, ${CENTER.h}) };
  })()`) as Promise<Diff>;
}

async function park(page: Page, cmd: string, yaw: number | null, settleMs: number): Promise<void> {
  await page.evaluate((c) => (window as any).acDebug?.admin?.(c), cmd);
  await page.waitForTimeout(settleMs);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  if (yaw !== null) await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), yaw);
  await page.waitForTimeout(2500);
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  const logs: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('Degrade prefs')) logs.push(t); });
  console.log(`[core17hgcca] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17hgcca] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17hgcca] not in world yet — reloading (phantom-session retry)');
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
  console.log('[core17hgcca] in world; settling');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);
  // Retail defaults through the real Reset/Defaults path.
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 50, adaptiveDegradeBias: 0, adaptiveDegrade: false }));
  await page.waitForTimeout(800);

  const samples: State[] = [];
  const diffs: Record<string, Diff> = {};
  const shoot = async (name: string, step: string): Promise<void> => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    const s = await sample(page, step);
    samples.push(s);
    console.log(`[core17hgcca] ${step}: disabled=${s.disabled} settings=${JSON.stringify(s.settings)} info=${JSON.stringify(s.info)}`);
    console.log(`[core17hgcca]   census=${JSON.stringify(s.census)}`);
  };

  // Training Academy — the per-cell furniture pools in a dungeon.
  await park(page, DUNGEON, null, 9000);
  await setDisabled(page, false);
  await shoot('dungeon-lod', 'dungeon LOD (retail defaults)');
  await setDisabled(page, true);
  await shoot('dungeon-nolod', 'dungeon degrades disabled');
  diffs.dungeon = await pixelDiff(page, join(OUT, 'dungeon-lod.png'), join(OUT, 'dungeon-nolod.png'));
  console.log(`[core17hgcca] diff dungeon: ${JSON.stringify(diffs.dungeon)}`);
  await setDisabled(page, false);
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 0 }));
  await page.waitForTimeout(1500);
  await shoot('dungeon-dd0-lod', 'dungeon Degrade Distance 0 (every furniture chain evaluated at its real distance)');
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 50 }));
  await park(page, DUNGEON_FAR, null, 6000);
  await shoot('dungeon-far-lod', 'dungeon corridor far end, LOD');
  await setDisabled(page, true);
  await shoot('dungeon-far-nolod', 'dungeon corridor far end, degrades disabled');
  diffs.dungeonFar = await pixelDiff(page, join(OUT, 'dungeon-far-lod.png'), join(OUT, 'dungeon-far-nolod.png'));
  console.log(`[core17hgcca] diff dungeon-far: ${JSON.stringify(diffs.dungeonFar)}`);
  await setDisabled(page, false);

  // Adaptive Degrade on: SetDegradeLevelInternal squares the cut-offs.
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ adaptiveDegrade: true }));
  await page.waitForTimeout(3000);
  await shoot('dungeon-auto-lod', 'dungeon Adaptive Degrade on (deg_mul from the SwiftShader frame rate; derived cut-offs squared)');
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ adaptiveDegrade: false }));
  await page.waitForTimeout(1000);

  // Holtburg — cottage interiors through their doors + the statics fallbacks.
  await park(page, HOLTBURG, 0, 6000);
  await setDisabled(page, false);
  await shoot('town-lod', 'town yaw0 LOD (retail defaults)');
  await setDisabled(page, true);
  await shoot('town-nolod', 'town yaw0 degrades disabled');
  diffs.town = await pixelDiff(page, join(OUT, 'town-lod.png'), join(OUT, 'town-nolod.png'));
  console.log(`[core17hgcca] diff town: ${JSON.stringify(diffs.town)}`);
  await setDisabled(page, false);

  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ samples, diffs, logs }, null, 2));
  console.log(`[core17hgcca] wrote ${OUT}/samples.json`);
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
  const data = JSON.parse(readFileSync(join(OUT, 'samples.json'), 'utf8')) as { samples: State[]; diffs: Record<string, Diff> };
  const refs = (files: string[]) => files.filter(existsSync).map(f => full(f, `retail: ${f.split('/').pop()}`, 'ref')).join('');
  const s = (step: string) => data.samples.find(x => x.step.startsWith(step));
  const line = (name: string, step: string) => {
    const st = s(step);
    const c = st?.census as { cells?: { cells: number; instances: number; drawn: number; byLevel: Record<string, number> }; parts?: Record<string, number>; derived?: unknown; degMul?: number } | undefined;
    return `${name} — ${st?.info.calls ?? '?'} draw calls / ${((st?.info.triangles ?? 0) / 1e6).toFixed(2)} M tris; furniture batches visible ${st?.info.furnVisible ?? '?'}/${st?.info.furnMeshes ?? '?'} (+ level meshes ${st?.info.furnLevelVisible ?? '?'}/${st?.info.furnLevelMeshes ?? '?'}); cells ${c?.cells?.cells ?? '?'}: ${c?.cells?.drawn ?? '?'} of ${c?.cells?.instances ?? '?'} instances drawn ${JSON.stringify(c?.cells?.byLevel ?? {})}; parts ${JSON.stringify(c?.parts ?? {})}; deg_mul ${c?.degMul ?? '?'} derived ${JSON.stringify(c?.derived ?? {})}`;
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
  <h1>CORE.17.h.g.c.c.a — cell furniture + fallback groups under retail's degrade system: retail refs | ours LOD | ours degrades disabled</h1>
  <p>${line('dungeon LOD', 'dungeon LOD')}<br>${line('dungeon disabled', 'dungeon degrades')}<br>${line('dungeon Degrade Distance 0', 'dungeon Degrade Distance 0')}<br>${line('dungeon far end LOD', 'dungeon corridor far end, LOD')}<br>${line('dungeon far end disabled', 'dungeon corridor far end, degrades')}<br>${line('dungeon adaptive', 'dungeon Adaptive')}<br>${line('town LOD', 'town yaw0 LOD')}<br>${line('town disabled', 'town yaw0 degrades')}<br>
  LOD vs disabled pixel diff (max-channel Δ &gt; 3): dungeon ${JSON.stringify(data.diffs.dungeon)}; dungeon far ${JSON.stringify(data.diffs.dungeonFar)}; town ${JSON.stringify(data.diffs.town)}</p>
  <h2>Retail dungeon references</h2><div class="row">${refs(DUNGEON_REFS)}</div>
  <h2>Training Academy — LOD | disabled | Degrade Distance 0</h2>
  <div class="row">${full(join(OUT, 'dungeon-lod.png'), 'ours — retail defaults')}${full(join(OUT, 'dungeon-nolod.png'), 'ours — degrades disabled (every part at level 0)')}${full(join(OUT, 'dungeon-dd0-lod.png'), 'ours — Degrade Distance 0')}</div>
  <h2>Centre crops (1.5×)</h2>
  <div class="row">${crop(join(OUT, 'dungeon-lod.png'), 'LOD', CENTER, 1.5)}${crop(join(OUT, 'dungeon-nolod.png'), 'disabled', CENTER, 1.5)}</div>
  <h2>Corridor far end — LOD | disabled</h2>
  <div class="row">${full(join(OUT, 'dungeon-far-lod.png'), 'ours — LOD')}${full(join(OUT, 'dungeon-far-nolod.png'), 'ours — disabled')}${full(join(OUT, 'dungeon-auto-lod.png'), 'ours — Adaptive Degrade on')}</div>
  <h2>Retail town references</h2><div class="row">${refs(TOWN_REFS)}</div>
  <h2>Holtburg yaw 0 — LOD | disabled</h2>
  <div class="row">${full(join(OUT, 'town-lod.png'), 'ours — LOD')}${full(join(OUT, 'town-nolod.png'), 'ours — disabled')}</div>`;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2200, height: 1200 } });
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17hgcca-cell-lod-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17hgcca] wrote ${OUT}/core17hgcca-cell-lod-sidebyside.png`);
}

if (process.argv.includes('--compose')) compose().catch(e => { console.error(e); process.exit(1); });
else captureLive().catch(e => { console.error(e); process.exit(1); });
