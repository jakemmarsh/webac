/**
 * CORE.17.k.b.b.a.f — live capture + side-by-side for the chargen
 * profession page's attribute rows: the lock toggle 0x100002ec (states
 * 0x10000018 / 0x10000019, media 0x06004d3b / 0x06004d3c, tooltip
 * 222843554), the 0x100002ee slider drawn as the 0x100002ea scrollbar
 * template (bar strips 0x06004d39 / 0x06004d3a, the 0x06004d34 widget at
 * ftol(value × 0.01 × 247)), and CharGenState's balancing: a slider rise
 * past the credits drains the other UNLOCKED attributes round-robin (Str →
 * End → Coord → Quick → Focus → Self), a locked one holds; a profession row
 * clears the locks.
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character → Next → the profession page:
 * idle; the mouse resting on a lock (its tooltip); Bow Hunter (credits
 * spent); Coordination locked; Strength dragged to ~60 (End / Quick / Focus
 * pay, Coord holds); dragged to the end (the rise clamps once the payers
 * are at 10); Custom (locks cleared). Every shot records the wizard's
 * values, locks and remaining credits plus every row's DOM state (lock
 * state / media, bar media, widget x, value text).
 *
 * Composition: the retail heritage-page frame (reference/images/preworld/
 * char-create-ref1.png — the only EoL chargen screen on file; no EoL
 * profession-page screenshot exists, the DAT + decompiled client are the
 * reference) | before (the CORE.17.k.b.b.a.b close capture: no lock, the
 * invented gold fill bar) | after, with 3x crops of a row in both lock
 * states, the lock media themselves, and the whole page at each step.
 *
 *   npx tsx tools/capture-core17kbbaf-chargen-attribute-lock-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbaf');
const BEFORE = join(REPO, 'verification', 'core17kbbab', 'ours-char-create-profession.png');
const RETAIL_HERITAGE = join(REPO, 'reference', 'images', 'preworld', 'char-create-ref1.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;
/** The profession page content sits 55 px under the tab bar; the rows are at content (291, 155 + 45 i). */
const PAGE_Y = 55;
const ROW_X = 291; const ROW_Y0 = 155; const ROW_PITCH = 45; const ROW_W = 480; const ROW_H = 39;
const SLIDER_X = 148; const SLIDER_W = 284;

interface Rect { x: number; y: number; width: number; height: number }
interface RowState { attr: string; value: string; locked: boolean; lockState: string; lockMedia: string; barMedia: string; widgetLeft: string; position: string }
interface ShotState { step: number; attributes: Record<string, number>; locks: Record<string, boolean>; remaining: number; rows: RowState[]; credits: string; vitals: Record<string, string>; tooltip: string | null; profession: string | null }

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const STATE_JS = `(() => {
  const ui = window.__ac && window.__ac.gameUI;
  const w = ui && ui.wizard;
  const rows = Array.from(document.querySelectorAll('.attr-row')).map((r) => {
    const lock = r.querySelector('.attr-lock'); const s = r.querySelector('.attr-slider'); const wd = s && s.querySelector('.attr-slider-widget');
    return { attr: r.dataset.attr, value: (r.querySelector('.attr-value') || {}).textContent, locked: !!(w && w.attributeLocks && w.attributeLocks[r.dataset.attr]),
      lockState: lock ? lock.dataset.acState : null, lockMedia: lock ? lock.dataset.acMedia : null, barMedia: s ? s.dataset.acMedia : null,
      widgetLeft: wd ? wd.style.left : null, position: s ? s.dataset.acPosition : null };
  });
  const tip = document.querySelector('.ac-dat-tooltip');
  const lit = document.querySelector('.template-btn [data-ac-state="10000017"]');
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    attributes: w ? Object.assign({}, w.attributes) : {}, locks: w ? Object.assign({}, w.attributeLocks) : {}, remaining: w ? w.attributesRemaining : -1,
    rows, credits: (document.querySelector('.attr-credits-value') || {}).textContent,
    vitals: Object.fromEntries(Array.from(document.querySelectorAll('.attr-vital-value')).map((v) => [v.dataset.vital, v.textContent])),
    tooltip: tip ? tip.dataset.acText : null,
    profession: lit ? (lit.closest('.template-btn') || {}).dataset.profession : null,
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbaf] still waiting — reloading');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      lastReload = Date.now();
    }
    await page.waitForTimeout(2500);
  }
  return false;
}

/** Screen point of a layout point on the profession page's content (content y + 55 = layout y). */
const screen = (x: number, y: number): [number, number] => [OFF_X + x * SCALE, OFF_Y + (y + PAGE_Y) * SCALE];
const rowIndex: Record<string, number> = { strength: 0, endurance: 1, coordination: 2, quickness: 3, focus: 4, self: 5 };
/** The screen point on `attr`'s track whose PointToPosition gives `value` (the widget centre for that value). */
function trackPoint(attr: string, value: number): [number, number] {
  const x = ROW_X + SLIDER_X + 18 + Math.round(value * 0.01 * 246);
  const y = ROW_Y0 + rowIndex[attr] * ROW_PITCH + ROW_H / 2;
  return screen(x, y);
}
function lockPoint(attr: string): [number, number] {
  return screen(ROW_X + 4 + 7.5, ROW_Y0 + rowIndex[attr] * ROW_PITCH + 4 + 12);
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  const state: Record<string, unknown> = { capturedAt: new Date().toISOString(), viewport: VIEW, scale: SCALE, screens: {} };
  const screens = state.screens as Record<string, { file: string; state: ShotState }>;
  const shoot = async (name: string): Promise<ShotState> => {
    const file = `ours-${name}.png`;
    await page.screenshot({ path: join(OUT, file), timeout: 150_000 });
    const st = await page.evaluate(STATE_JS) as ShotState;
    screens[name] = { file, state: st };
    const a = st.attributes;
    console.log(`[core17kbbaf] ${file}: step ${st.step}, ${st.rows.length} rows, str ${a.strength} end ${a.endurance} coord ${a.coordination} quick ${a.quickness} focus ${a.focus} self ${a.self}, remaining ${st.remaining}, locks ${Object.entries(st.locks).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'}, tip ${st.tooltip ? `"${st.tooltip.slice(0, 40)}…"` : 'none'}`);
    return st;
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const parkMouse = async (): Promise<void> => { await page.mouse.move(OFF_X + 400 * SCALE, OFF_Y + 590 * SCALE, { steps: 2 }); await page.waitForTimeout(300); };
  const next = async (): Promise<void> => {
    const before = await page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as number;
    await parkMouse();
    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      clicked = await clickSel('#btn-next').catch(() => false);
      if (!clicked) await page.waitForTimeout(1000);
    }
    const advanced = await page.waitForFunction((prev) =>
      parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev, before, { timeout: 15_000 })
      .then(() => true).catch(() => false);
    if (!advanced) throw new Error(`wizard did not advance past step ${before}`);
    await page.waitForTimeout(1500);
  };
  /** A real mouse drag on `attr`'s track from its current value to `to` (the widget follows; the others balance live). */
  const drag = async (attr: string, from: number, to: number): Promise<void> => {
    const [x0, y0] = trackPoint(attr, from);
    await page.mouse.move(x0, y0, { steps: 3 });
    await page.mouse.down();
    await page.waitForTimeout(150);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const [x, y] = trackPoint(attr, from + (to - from) * (i / steps));
      await page.mouse.move(x, y, { steps: 2 });
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(200);
  };

  console.log('[core17kbbaf] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=kbbaf`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickSel('#btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(2000);
  await next();
  await page.evaluate(`window.__ac.gameUI.tooltipDurationSeconds = 600`);

  await shoot('profession-idle');
  // The lock's tooltip: the mouse resting on Strength's lock.
  const [lx, ly] = lockPoint('strength');
  await page.mouse.move(lx - 4, ly + 2, { steps: 3 });
  await page.mouse.move(lx, ly, { steps: 2 });
  await page.waitForTimeout(700);
  await shoot('profession-lock-tooltip');
  await parkMouse();

  // Bow Hunter: 40 / 30 / 100 / 100 / 50 / 10 — the credits spent.
  await clickSel('.template-btn[data-profession="Bow Hunter"]');
  await page.waitForTimeout(1200);
  await shoot('profession-bowhunter');

  // Lock Coordination with a real click on its lock.
  const [cx, cy] = lockPoint('coordination');
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(600);
  await parkMouse();
  await shoot('profession-coord-locked');

  // Strength up to ~60 while the drag is held: End / Quick / Focus pay, Coordination holds.
  await drag('strength', 40, 60);
  await shoot('profession-drag-str60-held');
  await page.mouse.up();
  await page.waitForTimeout(800);
  await parkMouse();
  await shoot('profession-str60');

  // Strength to the end of the track: the rise clamps once the payers are at 10.
  await drag('strength', 60, 100);
  await page.mouse.up();
  await page.waitForTimeout(800);
  await parkMouse();
  await shoot('profession-str-max');

  // Unlock Coordination, then push Endurance up: Coordination pays now.
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(600);
  await drag('endurance', 10, 40);
  await page.mouse.up();
  await page.waitForTimeout(800);
  await parkMouse();
  await shoot('profession-coord-unlocked-end40');

  // Lock Strength and Self, then Custom: the locks clear with the template.
  const [sx, sy] = lockPoint('strength');
  await page.mouse.click(sx, sy);
  await page.waitForTimeout(300);
  const [fx, fy] = lockPoint('self');
  await page.mouse.click(fx, fy);
  await page.waitForTimeout(600);
  await parkMouse();
  await shoot('profession-two-locked');
  await clickSel('.template-btn[data-profession="Custom"]');
  await page.waitForTimeout(1200);
  await shoot('profession-custom-cleared');

  await clickSel('#btn-cancel');
  await page.waitForTimeout(500);
  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function cropOf(file: string, rect: Rect, frameW: number, frameH: number, label: string, zoom: number): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><div class="crop" style="width:${Math.round(rect.width * zoom)}px;height:${Math.round(rect.height * zoom)}px"><img src="${dataUrl(file)}" style="left:${-rect.x * zoom}px;top:${-rect.y * zoom}px;width:${frameW * zoom}px;height:${frameH * zoom}px"/></div></div>`;
}
function frameRect(content: Rect): Rect {
  return { x: OFF_X + content.x * SCALE, y: OFF_Y + (content.y + PAGE_Y) * SCALE, width: content.width * SCALE, height: content.height * SCALE };
}
function cropOurs(file: string, content: Rect, label: string, zoom: number): string {
  return cropOf(file, frameRect(content), VIEW.width, VIEW.height, label, zoom / SCALE);
}
function frame(file: string, label: string, width = 700): string {
  return existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${width}px;border:1px solid #444"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:700px}
  .crop{position:relative;overflow:hidden;border:1px solid #444}
  .crop img{position:absolute;image-rendering:pixelated}
  h1{font-size:14px;margin:0 0 8px}
  h2{font-size:13px;margin:14px 0 0;color:#9cf}
  table{border-collapse:collapse;margin-top:8px} td,th{border:1px solid #444;padding:2px 6px;text-align:right} th{color:#9cf}
</style>`;

async function compose(): Promise<void> {
  const live = existsSync(join(OUT, 'live-state.json'))
    ? JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) as { screens: Record<string, { file: string; state: ShotState }> }
    : { screens: {} };
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2300, height: 900 } });
  const ours = (n: string) => join(OUT, `ours-${n}.png`);
  const rowRect = (i: number, pad = 6): Rect => ({ x: ROW_X - pad, y: ROW_Y0 + i * ROW_PITCH - pad, width: ROW_W + 2 * pad, height: ROW_H + 2 * pad });
  const rowsRect: Rect = { x: ROW_X - 6, y: ROW_Y0 - 6, width: ROW_W + 12, height: ROW_PITCH * 5 + ROW_H + 12 };
  const rowCrop = (name: string, i: number, label: string, zoom = 3): string => cropOurs(ours(name), rowRect(i), label, zoom);
  const table = (): string => {
    const names = Object.keys(live.screens);
    if (!names.length) return '';
    const head = `<tr><th>shot</th><th>str</th><th>end</th><th>coord</th><th>quick</th><th>focus</th><th>self</th><th>remaining</th><th>locks</th><th>profession lit</th></tr>`;
    const rows = names.map((n) => { const s = live.screens[n].state; const a = s.attributes; return `<tr><td style="text-align:left">${n}</td><td>${a.strength}</td><td>${a.endurance}</td><td>${a.coordination}</td><td>${a.quickness}</td><td>${a.focus}</td><td>${a.self}</td><td>${s.remaining}</td><td style="text-align:left">${Object.entries(s.locks).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'}</td><td style="text-align:left">${s.profession ?? '—'}</td></tr>`; }).join('');
    return `<table>${head}${rows}</table>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.f — the profession page's attribute rows: the lock 0x100002ec (0x06004d3b unlocked / 0x06004d3c locked, tooltip 222843554), the 0x100002ee slider as the 0x100002ea scrollbar (bar 0x06004d39 / 0x06004d3a, widget 0x06004d34 at ftol(value × 0.01 × 247)), and CharGenState's balancing (a rise drains the unlocked others Str → End → Coord → Quick → Focus → Self; a locked one holds; a profession row clears the locks). Retail (the EoL heritage page — no EoL profession-page screenshot is on file; the DAT + decompiled client are the reference) | before (CORE.17.k.b.b.a.b close: no lock, an invented gold fill bar) | after.</h1>
    <div class="row">${frame(RETAIL_HERITAGE, 'retail — EoL chargen (heritage page, char-create-ref1.png): the chrome family', 600)}${frame(BEFORE, 'before — profession page (CORE.17.k.b.b.a.b close)', 700)}${frame(ours('profession-idle'), 'after — profession page, Custom, every row unlocked', 700)}</div>
    <h2>the rows at 3x — before | after (unlocked) | after (Coordination locked: the lock and the bar in 0x10000019)</h2>
    <div class="row">${cropOurs(BEFORE, rowsRect, 'before — the six rows', 2)}${cropOurs(ours('profession-bowhunter'), rowsRect, 'after — Bow Hunter (40 / 30 / 100 / 100 / 50 / 10), unlocked', 2)}${cropOurs(ours('profession-coord-locked'), rowsRect, 'after — Coordination locked', 2)}</div>
    <div class="row">${rowCrop('profession-bowhunter', 2, 'Coordination row unlocked — lock 0x06004d3b, bar 0x06004d39, widget at 247 (100)')}${rowCrop('profession-coord-locked', 2, 'Coordination row locked — lock 0x06004d3c, bar 0x06004d3a')}${rowCrop('profession-idle', 0, 'Strength row at 10 — the widget at 24 (the first 10 % of the track is dead: values start at 10)')}</div>
    <h2>the lock's tooltip (222843554) — the mouse resting on Strength's lock</h2>
    <div class="row">${cropOurs(ours('profession-lock-tooltip'), { x: ROW_X - 10, y: ROW_Y0 - 10, width: 420, height: 130 }, 'after — "Locks and unlocks the attribute…"', 2)}${frame(ours('profession-lock-tooltip'), 'whole page', 600)}</div>
    <h2>balancing — Strength dragged from 40 to 60 with Coordination locked: Endurance / Quickness / Focus pay one point per pass, Coordination holds (drag held | released), then to the end of the track (the rise clamps once the payers reach 10)</h2>
    <div class="row">${cropOurs(ours('profession-drag-str60-held'), rowsRect, 'drag held at ~60 — the other widgets moved live', 2)}${cropOurs(ours('profession-str60'), rowsRect, 'released', 2)}${cropOurs(ours('profession-str-max'), rowsRect, 'Strength to the end: 100 / 10 / 100 / 80 / 30 / 10', 2)}</div>
    <h2>Coordination unlocked and Endurance raised to 40: Coordination pays now; two locks, then Custom clears them</h2>
    <div class="row">${cropOurs(ours('profession-coord-unlocked-end40'), rowsRect, 'Coordination unlocked, Endurance 40', 2)}${cropOurs(ours('profession-two-locked'), rowsRect, 'Strength + Self locked', 2)}${cropOurs(ours('profession-custom-cleared'), rowsRect, 'Custom — every lock off, all 10', 2)}</div>
    <h2>the wizard state per shot (live-state.json)</h2>
    ${table()}
    <h2>whole pages — after, each step</h2>
    <div class="row">${frame(ours('profession-bowhunter'), 'Bow Hunter', 560)}${frame(ours('profession-coord-locked'), 'Coordination locked', 560)}${frame(ours('profession-str60'), 'Strength 60', 560)}${frame(ours('profession-str-max'), 'Strength 100', 560)}</div>
    <div class="row">${frame(ours('profession-coord-unlocked-end40'), 'Endurance 40', 560)}${frame(ours('profession-two-locked'), 'two locked', 560)}${frame(ours('profession-custom-cleared'), 'Custom', 560)}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbaf-attribute-lock-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbaf] wrote ${join(OUT, 'core17kbbaf-attribute-lock-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
