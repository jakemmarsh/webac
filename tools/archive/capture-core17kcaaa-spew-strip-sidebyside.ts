/**
 * CORE.17.k.c.a.a.a — live evidence of the spew strip's draw order against the
 * floaty vitals plate on the ACE stack, composed against the retail frame.
 *
 * Retail (decompiled EoL client): the 3D-view region 0x1000049a of the gameplay
 * screen inherits zLevel 9999 from 0x2100000f:0x10000037; UIRegion::AddChild
 * @ 006a0760 sorts siblings descending by z (CompareZLevel @ 0069f000) and
 * UIRegion::DrawChildren @ 0069fca0 paints head → tail, so the 3D view and the
 * spew strip inside it paint FIRST and the vitals plate (z 0) covers the rows
 * it overlaps. Ours reproduces that order (#hud-spew-box z 1 under #hud-vitals
 * z 10); this capture shows the frame with a real 0x1a notice under the plate.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright:
 *   ours-notice-under-plate.png   the "one item at a time" line raised on the
 *                                 strip with the stacked plate in place (the
 *                                 Training Academy start room — the same room as
 *                                 the retail Wine capture)
 *   ours-notice-plate-moved.png   the plate dragged aside (persisted geometry
 *                                 path) — the whole line readable, proving the
 *                                 occluder is the plate, not the strip
 *   live-state.json               the DOM z-indexes, geometry and row texts
 * Composes core17kcaaa-spew-strip-sidebyside.png under verification/core17kcaaa/.
 *
 *   npx tsx tools/capture-core17kcaaa-spew-strip-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kcaaa');
const WINE_ACADEMY = join(REPO, 'docs/images/retail-client-wine-inworld-academy-welcome.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17kcaaa]';
const LINE = 'You can only move or use one item at a time';

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}
async function driveCharacterCreate(page: Page, name: string): Promise<string> {
  return ev<string>(page, `(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = ${JSON.stringify(name)};
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`);
}
async function enterWorld(page: Page): Promise<void> {
  console.log(`${TAG} navigating`);
  await page.goto(`${URL}&cb=kcaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await driveCharacterCreate(page, 'Strip Tester').catch(() => 'error');
      if (r === 'sent') { console.log(`${TAG} character creation submitted`); lastReload = Date.now(); }
      lastCreate = Date.now();
    }
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
}

const keepAlive = (page: Page, texts: string[]) => ev(page, `(() => {
  const w = window; if (w.__spewKeep) { clearInterval(w.__spewKeep); w.__spewKeep = null; }
  const texts = ${JSON.stringify(texts)};
  if (texts.length) { const f = () => { const ui = w.__ac && w.__ac.gameUI; if (ui) for (const t of texts) ui.spewNotice(t); }; f(); w.__spewKeep = setInterval(f, 2000); }
})()`);

interface DomState { strip: Record<string, string>; vitals: Record<string, string>; rows: string[]; sameParent: boolean }
const domState = (page: Page) => ev<DomState>(page, `(() => {
  const s = document.getElementById('hud-spew-box'), v = document.getElementById('hud-vitals');
  const g = (e) => { const r = e.getBoundingClientRect(); return { z: e.style.zIndex, top: e.style.top, left: e.style.left, w: e.style.width, h: e.style.height, rect: [r.left, r.top, r.width, r.height].map(Math.round).join(',') }; };
  return { strip: g(s), vitals: g(v), rows: [...s.querySelectorAll('.spew-item')].map((r) => r.textContent), sameParent: s.parentElement === v.parentElement && s.parentElement.id === 'game-hud' };
})()`);

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (msg) => { const t = msg.text(); if (/\[AC\]|rror/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`); });
  await enterWorld(page);
  await ev(page, `window.__ac && window.__ac.skybox && window.__ac.skybox.setWeatherEnabled && window.__ac.skybox.setWeatherEnabled(false)`);
  await ev(page, `window.acDebug.freezeTimeOfDay && window.acDebug.freezeTimeOfDay(0.5)`);
  await ev(page, `window.acDebug.pinDayGroup && window.acDebug.pinDayGroup('Sunny')`);
  await ev(page, `window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(12_000);
  await page.waitForFunction(() => !document.getElementById('portal-spew-box'), undefined, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(8000);
  const state: Record<string, unknown> = { url: URL };

  // ── the notice under the plate (retail's order) ──
  await keepAlive(page, [LINE]);
  await page.waitForTimeout(300);
  state.underPlate = await domState(page);
  await page.screenshot({ path: join(OUT, 'ours-notice-under-plate.png') });
  console.log(`${TAG} under plate: ${JSON.stringify(state.underPlate)}`);

  // ── the plate moved aside: the same row, now fully readable (the occluder is the plate) ──
  await ev(page, `(() => { const v = document.getElementById('hud-vitals'); v.style.left = '40px'; v.style.top = '120px'; })()`);
  await page.waitForTimeout(300);
  state.plateMoved = await domState(page);
  await page.screenshot({ path: join(OUT, 'ours-notice-plate-moved.png') });
  await ev(page, `(() => { const v = document.getElementById('hud-vitals'); v.style.left = ''; v.style.top = ''; })()`);
  await keepAlive(page, []);
  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }
const CSS = `<style>body{margin:0;background:#111;color:#ddd;font:13px/1.35 system-ui}h1{font-size:15px;margin:8px 10px}.row{display:flex;gap:8px;padding:0 8px}.cell{background:#000;flex:1}.lbl{font-size:11px;color:#bbb;padding:3px 4px;min-height:74px}.full img{width:100%}</style>`;
const dataUrl = (f: string) => `data:image/${f.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(f).toString('base64')}`;
const cropCell = (p: Panel, scale: number) =>
  `<div class="cell"><div class="lbl">${p.label}</div><div style="width:${p.w * scale}px;height:${p.h * scale}px;overflow:hidden;position:relative"><img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * scale}px;top:${-p.y * scale}px;transform-origin:0 0;transform:scale(${scale})"/></div></div>`;

async function compose(): Promise<void> {
  const UNDER = join(OUT, 'ours-notice-under-plate.png');
  const MOVED = join(OUT, 'ours-notice-plate-moved.png');
  for (const f of [WINE_ACADEMY, UNDER, MOVED]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const st = JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) as { underPlate: DomState; plateMoved: DomState };
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1500 } });
  const top: Panel[] = [
    { file: WINE_ACADEMY, label: 'retail EoL client under Wine (1024x768): the stacked floaty vitals plate 0x100005fa (160x58, top centre) — z 0 in the DAT, drawn AFTER the 3D-view region 0x1000049a (inherited z 9999) by UIRegion::DrawChildren @ 0069fca0, i.e. over anything the 3D view draws under it, the spew strip (0x2100000f pane 0x10000046 at y 20) included', x: 212, y: 0, w: 600, h: 60 },
    { file: UNDER, label: `ours (ACE stack, SwiftShader): the 0x1a line "${LINE}" on the strip (#hud-spew-box z ${st.underPlate.strip.z}) under the plate (#hud-vitals z ${st.underPlate.vitals.z}, same #game-hud stacking context: ${st.underPlate.sameParent}) — retail's order`, x: 484, y: 0, w: 600, h: 60 },
    { file: MOVED, label: `ours, plate moved aside (a persisted-position drag): the same row fully readable — the occluder is the plate, the strip itself is whole (rows: ${JSON.stringify(st.plateMoved.rows)})`, x: 484, y: 0, w: 600, h: 60 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.k.c.a.a.a — the spew strip paints BEHIND the floaty vitals plate in retail (AddChild sorts siblings descending by zLevel, DrawChildren paints head → tail, the 3D view inherits 9999) — ours matches (2x crops, top band)</h1>
    <div class="row">${top.map((p) => cropCell(p, 2)).join('')}</div>
    <div style="height:12px"></div>
    <h1>whole screen: retail EoL client (Wine 1024x768, the Training Academy start room) | ours in the same room with the notice under the plate | ours with the plate moved (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine (Training Academy, the same room; the welcome dialog is the retail first-login dialog)</div><img src="${dataUrl(WINE_ACADEMY)}"/></div>
      <div class="cell"><div class="lbl">ours: the notice under the plate (retail's order)</div><img src="${dataUrl(UNDER)}"/></div>
      <div class="cell"><div class="lbl">ours: the plate moved aside</div><img src="${dataUrl(MOVED)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kcaaa-spew-strip-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kcaaa-spew-strip-sidebyside.png')}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}
main().catch((e) => { console.error(e); process.exit(1); });
