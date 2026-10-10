/**
 * CORE.17.h.g.c.c.b — live capture + side-by-side evidence for the retail
 * world-light pool (Render::world_lights static / dynamic lists under
 * SetDegradeLevelInternal's caps) replacing the nearest-8 DatLightBudget,
 * and the viewer light's "active only inside a cell" rule.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright
 * like tools/capture-core17hgcca-cell-lod.ts, then:
 *   dungeon-retail.png / dungeon-cap8.png   Training Academy (the world-dungeon
 *                                           harness pin) with the retail caps
 *                                           (40 static / 7 dynamic) vs the old
 *                                           8-light cap (capsOverride)
 *   dungeon-hall-*.png                      a second pin down the corridor
 *   night-retail.png / night-forced.png     Holtburg at midnight, yaw 0: viewer
 *                                           light inactive outdoors (retail
 *                                           useSunlightSet(1)) vs forced on
 *                                           (the pre-task picture)
 *   samples.json                            per step: lodCensus().lights (known /
 *                                           pooled / actives / fillers / caps /
 *                                           viewerLightActive), renderer.info,
 *                                           programs, rAF frame-time sample,
 *                                           pixel diffs
 * `--compose` builds core17hgccb-light-budget-sidebyside.png from those files.
 *
 * Usage: npx tsx tools/capture-core17hgccb-light-budget.ts
 *        npx tsx tools/capture-core17hgccb-light-budget.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgccb');
const DUNGEON_REFS = ['rawg_02.jpg', 'rawg_04.jpg', 'rawg_09.jpg'].map(f => join(REPO, 'reference/images/hud', f));
const TOWN_REFS = [join(REPO, 'reference/images/hud/rawg_07.jpg'), join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png')];
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
/** The world-dungeon harness pin (capture-ui-screens.ts) + a spot down the corridor. */
const DUNGEON = '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';
const DUNGEON_HALL = '@teleloc 0x86020115 [190 -250 -11.5] 0.7 0 0 0.7';
const HOLTBURG = '@telepoi holtburg';
const CENTER = { x: 380, y: 160, w: 800, h: 420 };
/** What the pre-task budget did: the 8 nearest DAT lights, one list. */
const CAP8 = { maxStaticLights: 8, maxDynamicLights: 0 };

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

interface Lights {
  known: number; pooled: number; staticActive: number; dynamicActive: number; fillers: number;
  caps: { maxStaticLights: number; maxDynamicLights: number }; deviceMaxLights: number; viewerLightActive: boolean;
}
interface State {
  step: string;
  lights: Lights;
  capsOverride: unknown;
  viewerLightOverride: unknown;
  /** DAT lights (enabled or not) within 15 m / 30 m of the player — how many the old cap left dark. */
  near: { within15: number; within30: number; enabledWithin30: number };
  info: { calls: number; triangles: number; programs: number };
  frame: { samples: number; p50: number; p95: number; mean: number };
}

async function sample(page: Page, step: string): Promise<State> {
  return page.evaluate(`(async () => {
    const ac = window.__ac;
    const info = ac.sceneManager.renderer.info;
    const census = ac.lodCensus();
    const origin = ac.playerModel ? ac.playerModel.position : ac.sceneManager.camera.position;
    const wp = new ac.sceneManager.scene.position.constructor();
    let within15 = 0, within30 = 0, enabledWithin30 = 0;
    ac.sceneManager.scene.traverse((o) => {
      if (!o.userData || !o.userData.datLight || o.userData.datLightFiller) return;
      o.getWorldPosition(wp);
      const d = wp.distanceTo(origin);
      if (d <= 15) within15++;
      if (d <= 30) { within30++; if (o.visible) enabledWithin30++; }
    });
    // rAF frame-time sample (SwiftShader — relative only)
    const dts = [];
    await new Promise((res) => {
      let last = performance.now();
      const t0 = last;
      const tick = () => { const n = performance.now(); dts.push(n - last); last = n; if (n - t0 < 4000) requestAnimationFrame(tick); else res(); };
      requestAnimationFrame(tick);
    });
    dts.sort((a, b) => a - b);
    const q = (p) => dts.length ? dts[Math.min(dts.length - 1, Math.floor(p * dts.length))] : 0;
    return {
      step: ${JSON.stringify(step)},
      lights: census.lights,
      capsOverride: ac.datLightBudget.capsOverride,
      viewerLightOverride: ac.viewerLightOverride,
      near: { within15, within30, enabledWithin30 },
      info: { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs ? info.programs.length : -1 },
      frame: { samples: dts.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), mean: +(dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length)).toFixed(1) },
    };
  })()`) as Promise<State>;
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

async function park(page: Page, cmd: string, yaw: number | null, settleMs: number, timeOfDay = 0.5): Promise<void> {
  await page.evaluate((c) => (window as any).acDebug?.admin?.(c), cmd);
  await page.waitForTimeout(settleMs);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), timeOfDay);
  if (yaw !== null) await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), yaw);
  await page.evaluate(() => (window as any).__ac.datLightBudget.invalidate());
  await page.waitForTimeout(2500);
}

async function setCaps(page: Page, caps: { maxStaticLights: number; maxDynamicLights: number } | null): Promise<void> {
  await page.evaluate((c) => { (window as any).__ac.datLightBudget.capsOverride = c; }, caps);
  await page.waitForTimeout(1500);
}

async function setViewerLightOverride(page: Page, v: boolean | null): Promise<void> {
  await page.evaluate((x) => { (window as any).__ac.viewerLightOverride = x; }, v);
  await page.waitForTimeout(1500);
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  console.log(`[core17hgccb] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17hgccb] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17hgccb] not in world yet — reloading (phantom-session retry)');
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
  console.log('[core17hgccb] in world; settling');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ degradeDistance: 50, adaptiveDegradeBias: 0, adaptiveDegrade: false }));
  await page.waitForTimeout(800);

  const samples: State[] = [];
  const diffs: Record<string, Diff> = {};
  const shoot = async (name: string, step: string): Promise<void> => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    const s = await sample(page, step);
    samples.push(s);
    console.log(`[core17hgccb] ${step}: lights=${JSON.stringify(s.lights)} near=${JSON.stringify(s.near)} info=${JSON.stringify(s.info)} frame=${JSON.stringify(s.frame)}`);
  };

  // Training Academy — the harness pin: retail caps vs the old 8-cap.
  await park(page, DUNGEON, null, 9000);
  await setCaps(page, null);
  await shoot('dungeon-retail', 'dungeon retail caps (40 static / 7 dynamic)');
  await setCaps(page, CAP8);
  await shoot('dungeon-cap8', 'dungeon old nearest-8 cap');
  diffs.dungeon = await pixelDiff(page, join(OUT, 'dungeon-retail.png'), join(OUT, 'dungeon-cap8.png'));
  console.log(`[core17hgccb] diff dungeon: ${JSON.stringify(diffs.dungeon)}`);
  await setCaps(page, null);

  // Down the corridor, facing back — more torches in one view.
  await park(page, DUNGEON_HALL, null, 6000);
  await shoot('dungeon-hall-retail', 'dungeon hall retail caps');
  await setCaps(page, CAP8);
  await shoot('dungeon-hall-cap8', 'dungeon hall old nearest-8 cap');
  diffs.dungeonHall = await pixelDiff(page, join(OUT, 'dungeon-hall-retail.png'), join(OUT, 'dungeon-hall-cap8.png'));
  console.log(`[core17hgccb] diff dungeon-hall: ${JSON.stringify(diffs.dungeonHall)}`);
  await setCaps(page, null);

  // Adaptive Degrade on: the caps follow deg_mul (20 / 5 at −1 on SwiftShader).
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ adaptiveDegrade: true }));
  await page.waitForTimeout(3000);
  await shoot('dungeon-hall-auto', 'dungeon hall Adaptive Degrade on (caps from deg_mul)');
  await page.evaluate(() => (window as any).__ac.gameUI.applyOptionsBulk({ adaptiveDegrade: false }));
  await page.waitForTimeout(1000);

  // Holtburg at midnight — the viewer light is inactive outdoors (retail) vs forced on.
  await park(page, HOLTBURG, 0, 6000, 0.0);
  await setViewerLightOverride(page, null);
  await shoot('night-retail', 'town midnight yaw0 — viewer light inactive outdoors (useSunlightSet(1))');
  await setViewerLightOverride(page, true);
  await shoot('night-forced', 'town midnight yaw0 — viewer light forced on (pre-task picture)');
  diffs.night = await pixelDiff(page, join(OUT, 'night-retail.png'), join(OUT, 'night-forced.png'));
  console.log(`[core17hgccb] diff night: ${JSON.stringify(diffs.night)}`);
  await setViewerLightOverride(page, null);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.waitForTimeout(2000);
  await shoot('town-day', 'town noon yaw0 — retail (no pool light outdoors)');

  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ samples, diffs }, null, 2));
  console.log(`[core17hgccb] wrote ${OUT}/samples.json`);
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
    const l = st?.lights;
    return `${name} — lights known ${l?.known ?? '?'} / pooled ${l?.pooled ?? '?'} / static active ${l?.staticActive ?? '?'} / dynamic active ${l?.dynamicActive ?? '?'} / fillers ${l?.fillers ?? '?'} under caps ${JSON.stringify(l?.caps ?? {})} (device cap ${l?.deviceMaxLights ?? '?'}); viewer light active ${l?.viewerLightActive ?? '?'}; DAT lights within 15 m ${st?.near.within15 ?? '?'}, within 30 m ${st?.near.within30 ?? '?'} (${st?.near.enabledWithin30 ?? '?'} enabled); ${st?.info.calls ?? '?'} draw calls, ${st?.info.programs ?? '?'} programs; rAF p50 ${st?.frame.p50 ?? '?'} ms / p95 ${st?.frame.p95 ?? '?'} ms`;
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
  <h1>CORE.17.h.g.c.c.b — retail world-light pool (40 static / 7 dynamic from SetDegradeLevelInternal) vs the old nearest-8 cap; viewer light active only inside a cell</h1>
  <p>${line('dungeon retail', 'dungeon retail')}<br>${line('dungeon cap 8', 'dungeon old')}<br>${line('hall retail', 'dungeon hall retail')}<br>${line('hall cap 8', 'dungeon hall old')}<br>${line('hall adaptive', 'dungeon hall Adaptive')}<br>${line('night retail', 'town midnight yaw0 — viewer light inactive')}<br>${line('night forced', 'town midnight yaw0 — viewer light forced')}<br>${line('town noon', 'town noon')}<br>
  pixel diff (max-channel Δ &gt; 3): dungeon ${JSON.stringify(data.diffs.dungeon)}; hall ${JSON.stringify(data.diffs.dungeonHall)}; night ${JSON.stringify(data.diffs.night)}</p>
  <h2>Retail dungeon references</h2><div class="row">${refs(DUNGEON_REFS)}</div>
  <h2>Training Academy pin — retail caps | old nearest-8</h2>
  <div class="row">${full(join(OUT, 'dungeon-retail.png'), 'ours — retail caps')}${full(join(OUT, 'dungeon-cap8.png'), 'ours — old 8-light cap')}</div>
  <h2>Hall — retail caps | old nearest-8 | Adaptive Degrade on</h2>
  <div class="row">${full(join(OUT, 'dungeon-hall-retail.png'), 'ours — retail caps')}${full(join(OUT, 'dungeon-hall-cap8.png'), 'ours — old 8-light cap')}${full(join(OUT, 'dungeon-hall-auto.png'), 'ours — Adaptive Degrade on')}</div>
  <h2>Hall centre crops (1.5×)</h2>
  <div class="row">${crop(join(OUT, 'dungeon-hall-retail.png'), 'retail caps', CENTER, 1.5)}${crop(join(OUT, 'dungeon-hall-cap8.png'), 'old 8-cap', CENTER, 1.5)}</div>
  <h2>Retail town references</h2><div class="row">${refs(TOWN_REFS)}</div>
  <h2>Holtburg midnight yaw 0 — viewer light inactive (retail) | forced on (pre-task) | noon</h2>
  <div class="row">${full(join(OUT, 'night-retail.png'), 'ours — retail: sun only outdoors')}${full(join(OUT, 'night-forced.png'), 'ours — viewer light forced on')}${full(join(OUT, 'town-day.png'), 'ours — noon')}</div>`;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2200, height: 1200 } });
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17hgccb-light-budget-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17hgccb] wrote ${OUT}/core17hgccb-light-budget-sidebyside.png`);
}

if (process.argv.includes('--compose')) compose().catch(e => { console.error(e); process.exit(1); });
else captureLive().catch(e => { console.error(e); process.exit(1); });
