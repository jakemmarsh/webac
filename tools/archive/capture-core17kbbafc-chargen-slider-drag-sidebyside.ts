/**
 * CORE.17.k.b.b.a.f.c — live capture + side-by-side for the chargen
 * attribute slider's drag as UIElement_Scrollbar runs it: a press
 * recentres the widget (p124 ScrollToPoint) and records the press position
 * as m_fResetPosition; a move inside the band |y| < 101 px from the bar's
 * top edge recentres it again; the first move outside the band snaps the
 * widget (and the value, through message 10 → SetAttribValue) back to the
 * press position and holds it there until the mouse returns; the release
 * ends the drag. Nothing eases (p131 only animates a p133 write, which
 * needs the absent p132).
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character → Next → the profession page:
 * idle; Strength pressed at 50 and HELD; dragged to 90 inside the band;
 * the mouse taken 130 px below the bar's top (off the band) — the widget
 * snaps back to 50; moved along x while off the band — still 50; back
 * inside at 70 — the widget follows again; released — 70 stays. Then Bow
 * Hunter (credits spent): Self pressed at 90 (the 80 over drained from the
 * others), off the band — Self back to the reset (90 re-applied: unchanged,
 * nothing drained returns), inside at 100 (10 more drained), off again —
 * Self 90 with 10 credits freed, released. Every shot records the wizard's
 * attributes, the credits and each row's widget x.
 *
 * `--before` captures the same beats against the pre-fix code (the caller
 * stashes the fix first) into ours-before-*.png. `--compose-only` rebuilds
 * the sheet from the frames on disk.
 *
 *   npx tsx tools/capture-core17kbbafc-chargen-slider-drag-sidebyside.ts [--before] [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbafc');
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
const SLIDER_X = 148; const WIDGET_W = 37; const ACTIVE = 284 - WIDGET_W;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

interface Rect { x: number; y: number; width: number; height: number }
interface ShotState {
  step: number; attributes: Record<string, number>; remaining: number; widgets: Record<string, number>; values: Record<string, string>;
  mouse: { x: number; y: number; barY: number | null; held: boolean };
}

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const STATE_JS = `(() => {
  const ui = window.__ac && window.__ac.gameUI;
  const w = ui && ui.wizard;
  const widgets = {}; const values = {};
  for (const row of document.querySelectorAll('.attr-row')) {
    const a = row.dataset.attr;
    const wd = row.querySelector('.attr-slider-widget');
    widgets[a] = wd ? parseInt(wd.style.left, 10) : -1;
    const v = row.querySelector('.attr-value');
    values[a] = v ? (v.dataset.acValue ?? '') : '';
  }
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    attributes: w ? Object.assign({}, w.attributes) : {}, remaining: w ? w.attributesRemaining : -1,
    widgets, values,
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbafc] still waiting — reloading');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      lastReload = Date.now();
    }
    await page.waitForTimeout(2500);
  }
  return false;
}

/** Screen point of a layout point on the profession page's content (content y + 55 = layout y). */
const screen = (x: number, y: number): [number, number] => [OFF_X + x * SCALE, OFF_Y + (y + PAGE_Y) * SCALE];
const rowIndex: Record<string, number> = { strength: 0, endurance: 1, coordinate: 2, coordination: 2, quickness: 3, focus: 4, self: 5 };
/** The bar's top edge (content y) for a row. */
const barTop = (attr: string): number => ROW_Y0 + rowIndex[attr] * ROW_PITCH;
/** The track x whose PointToPosition gives `value` (the widget centred there; ceil so the truncation lands on the value). */
const trackX = (value: number): number => ROW_X + SLIDER_X + Math.trunc(WIDGET_W / 2) + Math.ceil(value * 0.01 * (ACTIVE - 1) - 1e-9) + 1;
/** Screen point for `value` on `attr`'s bar at `dy` px below the bar's top edge. */
function barPoint(attr: string, value: number, dy: number): [number, number] {
  return screen(trackX(value), barTop(attr) + dy);
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  const state: Record<string, unknown> = { capturedAt: new Date().toISOString(), before: BEFORE, viewport: VIEW, scale: SCALE, screens: {} };
  const screens = state.screens as Record<string, { file: string; state: ShotState }>;
  let mouse = { x: 0, y: 0, barY: null as number | null, held: false };
  const shoot = async (name: string): Promise<ShotState> => {
    const file = `${PREFIX}${name}.png`;
    await page.screenshot({ path: join(OUT, file), timeout: 150_000 });
    const st = await page.evaluate(STATE_JS) as ShotState;
    st.mouse = { ...mouse };
    screens[name] = { file, state: st };
    const a = st.attributes;
    console.log(`[core17kbbafc] ${file}: step ${st.step}, str ${a.strength} end ${a.endurance} coord ${a.coordination} quick ${a.quickness} focus ${a.focus} self ${a.self}, remaining ${st.remaining}, widgets ${JSON.stringify(st.widgets)}, mouse ${JSON.stringify(st.mouse)}`);
    return st;
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const parkMouse = async (): Promise<void> => { await page.mouse.move(OFF_X + 400 * SCALE, OFF_Y + 590 * SCALE, { steps: 2 }); mouse = { x: 400, y: 590, barY: null, held: false }; await page.waitForTimeout(300); };
  const stepTo = async (btn: string): Promise<void> => {
    const before = await page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as number;
    await parkMouse();
    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      clicked = await clickSel(btn).catch(() => false);
      if (!clicked) await page.waitForTimeout(1000);
    }
    const advanced = await page.waitForFunction((prev) =>
      parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev, before, { timeout: 15_000 })
      .then(() => true).catch(() => false);
    if (!advanced) throw new Error(`wizard did not move from step ${before} via ${btn}`);
    await page.waitForTimeout(1500);
  };
  /** Move the (held or free) mouse to `value` on `attr`'s bar, `dy` px below the bar's top. */
  const moveTo = async (attr: string, value: number, dy: number): Promise<void> => {
    const [x, y] = barPoint(attr, value, dy);
    await page.mouse.move(x, y, { steps: 6 });
    mouse = { x: trackX(value), y: barTop(attr) + dy, barY: dy, held: mouse.held };
    await page.waitForTimeout(500);
  };
  const pressAt = async (attr: string, value: number, dy = 20): Promise<void> => {
    await moveTo(attr, value, dy);
    await page.mouse.down();
    mouse.held = true;
    await page.waitForTimeout(500);
  };
  const releaseMouse = async (): Promise<void> => { await page.mouse.up(); mouse.held = false; await page.waitForTimeout(900); };

  console.log(`[core17kbbafc] navigating (autoenter=false)${BEFORE ? ' — BEFORE capture' : ''}`);
  await page.goto(`${BASE}&autoenter=false&cb=kbbafc${BEFORE ? 'b' : ''}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickSel('#btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(2000);
  await stepTo('#btn-next');

  await shoot('profession-idle');

  // Strength: press at 50 and hold — the widget recentres, 50 is the reset.
  await pressAt('strength', 50);
  await shoot('str-press-50');
  // Drag to 90 inside the band (20 px below the bar's top).
  await moveTo('strength', 90, 20);
  await shoot('str-drag-90');
  // Off the band: 130 px below the bar's top (over the Focus row) — snap back to 50.
  await moveTo('strength', 90, 130);
  await shoot('str-off-axis-snapback');
  // Still off the band, x taken to the far end — nothing changes.
  await moveTo('strength', 100, 150);
  await shoot('str-off-axis-held');
  // Back inside at 70 — the widget follows again.
  await moveTo('strength', 70, 10);
  await shoot('str-resume-70');
  // Above the bar but inside (−60 px) at 20 — still inside the band.
  await moveTo('strength', 20, -60);
  await shoot('str-above-inside-20');
  // Off above (−110 px) — snap back to 50.
  await moveTo('strength', 20, -110);
  await shoot('str-off-above-snapback');
  // Back at 70 and release — 70 stays.
  await moveTo('strength', 70, 20);
  await releaseMouse();
  await parkMouse();
  await shoot('str-released-70');

  // Bow Hunter: credits spent. Self pressed at 90: the 80 over is drained from the others.
  await clickSel('.template-btn[data-profession="Bow Hunter"]');
  await page.waitForTimeout(1200);
  await shoot('bowhunter-clicked');
  await pressAt('self', 90);
  await shoot('self-press-90-drained');
  // Off the band: the reset 0.9 re-applied — Self 90 (unchanged), nothing drained comes back.
  await moveTo('self', 90, 140);
  await shoot('self-off-axis-90');
  // Inside at 100: 10 more drained.
  await moveTo('self', 100, 20);
  await shoot('self-drag-100');
  // Off again: back to 90 — 10 credits freed, the others stay where the balance left them.
  await moveTo('self', 100, 140);
  await shoot('self-off-axis-snapback-90');
  await releaseMouse();
  await parkMouse();
  await shoot('self-released-90');

  await clickSel('#btn-cancel');
  await page.waitForTimeout(500);
  writeFileSync(join(OUT, BEFORE ? 'live-state-before.json' : 'live-state.json'), JSON.stringify(state, null, 2));
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
  const load = (f: string) => existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), 'utf8')) as { screens: Record<string, { file: string; state: ShotState }> } : { screens: {} };
  const live = load('live-state.json');
  const before = load('live-state-before.json');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2300, height: 900 } });
  const ours = (n: string) => join(OUT, `ours-${n}.png`);
  const ourBefore = (n: string) => join(OUT, `ours-before-${n}.png`);
  /** The six attribute rows plus 140 px below (where the off-band mouse sits) and 120 px above. */
  const rowsRect: Rect = { x: ROW_X - 6, y: ROW_Y0 - 120, width: ROW_W + 12, height: ROW_PITCH * 5 + ROW_H + 120 + 60 };
  const strRect: Rect = { x: ROW_X + SLIDER_X - 6, y: ROW_Y0 - 6, width: ROW_W - SLIDER_X + 12, height: ROW_H + 12 };
  const rowsCrop = (file: string, label: string, zoom = 1.0): string => cropOurs(file, rowsRect, label, zoom);
  const strCrop = (file: string, label: string, zoom = 1.6): string => cropOurs(file, strRect, label, zoom);
  const table = (src: { screens: Record<string, { file: string; state: ShotState }> }, title: string): string => {
    const names = Object.keys(src.screens);
    if (!names.length) return '';
    const head = `<tr><th>shot</th><th>mouse (bar-relative y)</th><th>held</th><th>str</th><th>end</th><th>coord</th><th>quick</th><th>focus</th><th>self</th><th>remaining</th><th>widget x: str / self</th></tr>`;
    const rows = names.map((n) => { const s = src.screens[n].state; const a = s.attributes; return `<tr><td style="text-align:left">${n}</td><td>${s.mouse.barY === null ? 'parked' : `x ${s.mouse.x}, y ${s.mouse.barY}`}</td><td>${s.mouse.held ? 'yes' : 'no'}</td><td>${a.strength}</td><td>${a.endurance}</td><td>${a.coordination}</td><td>${a.quickness}</td><td>${a.focus}</td><td>${a.self}</td><td>${s.remaining}</td><td>${s.widgets.strength} / ${s.widgets.self}</td></tr>`; }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.f.c — the chargen attribute slider's drag as UIElement_Scrollbar runs it (ListenToElementMessage @ 00471870): the press recentres the widget (p124 ScrollToPoint) and records the press position as m_fResetPosition; a move inside |y| &lt; 101 px of the bar's top edge recentres it again; the first move outside the band snaps the widget and the value back to the press position (SetScrollbarPosition(m_fResetPosition) → message 10 → SetAttribValue) and holds until the mouse returns; the release ends the drag. No widget offset (m_nMouseWidgetXOffset is written only in the constructor), no easing (p131 needs the absent p132). Retail (the EoL heritage page — no EoL profession-page screenshot is on file; the DAT + decompiled client are the reference) | before (the widget followed x wherever the mouse went — no band, no snap-back) | after.</h1>
    <div class="row">${frame(RETAIL_HERITAGE, 'retail — EoL chargen (heritage page, char-create-ref1.png): the chrome family', 600)}${frame(ourBefore('str-off-axis-snapback'), 'before — Strength pressed at 50, dragged to 90, the mouse 130 px below the bar: the widget stayed at 90 (followed x only)', 700)}${frame(ours('str-off-axis-snapback'), 'after — the same mouse path: the widget and the value snapped back to 50 (the reset) while the mouse is off the band', 700)}</div>
    <h2>the Strength row per beat (after) — press 50 | drag 90 | off the band (130 px below): back to 50 | still off, x at the far end: 50 holds | back inside at 70 | −60 px above (inside) at 20 | −110 px above: back to 50 | released at 70</h2>
    <div class="row">${strCrop(ours('str-press-50'), 'press 50 (held)')}${strCrop(ours('str-drag-90'), 'drag → 90')}${strCrop(ours('str-off-axis-snapback'), 'off the band → 50')}${strCrop(ours('str-off-axis-held'), 'off, x → 100: 50 holds')}</div>
    <div class="row">${strCrop(ours('str-resume-70'), 'back inside → 70')}${strCrop(ours('str-above-inside-20'), '−60 px above, inside → 20')}${strCrop(ours('str-off-above-snapback'), '−110 px above → 50')}${strCrop(ours('str-released-70'), 'released at 70')}</div>
    <h2>the same beats before the fix (the widget followed x off the band)</h2>
    <div class="row">${strCrop(ourBefore('str-press-50'), 'before — press 50')}${strCrop(ourBefore('str-drag-90'), 'before — drag → 90')}${strCrop(ourBefore('str-off-axis-snapback'), 'before — off the band: still 90')}${strCrop(ourBefore('str-off-axis-held'), 'before — off, x → 100: followed to 100')}${strCrop(ourBefore('str-off-above-snapback'), 'before — −110 px above: followed to 20')}</div>
    <h2>the rows with the mouse off the band (after): the pointer sits over the Focus row while Strength holds the reset</h2>
    <div class="row">${rowsCrop(ours('str-drag-90'), 'drag → 90 (inside)')}${rowsCrop(ours('str-off-axis-snapback'), 'off the band: Strength back to 50')}${rowsCrop(ours('str-off-axis-held'), 'off the band, x at the far end: 50 holds')}</div>
    <h2>Bow Hunter (credits spent) — Self pressed at 90 drains 80 from the others; off the band the reset 0.9 is re-applied (Self 90, nothing drained returns); inside at 100 drains 10 more; off again → Self 90 with 10 credits freed, the others where the balance left them</h2>
    <div class="row">${rowsCrop(ours('bowhunter-clicked'), 'Bow Hunter: 40/30/100/100/50/10, 0 credits')}${rowsCrop(ours('self-press-90-drained'), 'Self pressed at 90 (held): the others drained')}${rowsCrop(ours('self-off-axis-90'), 'off the band: Self 90, the others unchanged')}</div>
    <div class="row">${rowsCrop(ours('self-drag-100'), 'inside at 100: 10 more drained')}${rowsCrop(ours('self-off-axis-snapback-90'), 'off again: Self 90, 10 credits freed')}${rowsCrop(ours('self-released-90'), 'released: 90 stays')}</div>
    ${table(live, 'the wizard state per shot (after, live-state.json)')}
    ${table(before, 'the wizard state per shot (before, live-state-before.json)')}
    <h2>whole pages — after: idle | Strength off the band (snapped back to 50) | Self off the band after 100 (snapped back to 90)</h2>
    <div class="row">${frame(ours('profession-idle'), 'idle', 560)}${frame(ours('str-off-axis-snapback'), 'Strength off the band', 560)}${frame(ours('self-off-axis-snapback-90'), 'Self off the band', 560)}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbafc-slider-drag-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbafc] wrote ${join(OUT, 'core17kbbafc-slider-drag-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
