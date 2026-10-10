/**
 * CORE.17.k.b.b.a.f.a — live capture + side-by-side for the chargen
 * profession page's attribute VALUE box 0x100002ef as an edit field: a
 * click focuses it and selects the whole number (DrawSelf's NotColorBits —
 * the glyph box inverted), typing replaces the text in the DAT font while
 * the attribute / widget / credits hold (the p133 write is dead in retail),
 * Enter or Escape or a focus move commits to_uint32 of the text held to
 * [10, 100] through SetAttribValue (the credits clamp + balancing).
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character → Next → the profession page:
 * idle; a real click on Strength's value (selected); "6" typed; "60"
 * typed (the widget still at 10); Enter (60 lands: widget, credits);
 * Endurance "250" + Escape (100); Focus "070" + a click elsewhere (56 —
 * wcstoul's octal); Bow Hunter, Coordination locked, Strength "90" + Tab
 * (the drain); Self "abc" + Enter (10). Every shot records the wizard's
 * values / credits, each row's field value, box text, selection flag,
 * widget x, and the focused element.
 *
 * Composition: the retail heritage-page frame (the only EoL chargen screen
 * on file; the DAT + decompiled client are the reference for this page) |
 * before (the CORE.17.k.b.b.a.f close: a static value) | after, with 3x
 * crops of the value box in each state and the whole page per step.
 *
 *   npx tsx tools/capture-core17kbbafa-chargen-attribute-value-input-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbafa');
const BEFORE = join(REPO, 'verification', 'core17kbbaf', 'ours-profession-idle.png');
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
const VALUE_X = 440; const VALUE_W = 40;

interface Rect { x: number; y: number; width: number; height: number }
interface RowState { attr: string; value: string; text: string; field: string; selected: string | null; target: string | null; widgetLeft: string; locked: boolean }
interface ShotState { step: number; attributes: Record<string, number>; remaining: number; rows: RowState[]; credits: string; focused: string | null; inputFocused: boolean; profession: string | null }

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
    const box = r.querySelector('.attr-value'); const input = box && box.querySelector('.attr-value-input'); const s = r.querySelector('.attr-slider'); const wd = s && s.querySelector('.attr-slider-widget');
    // The rendered text is a canvas (no textContent): the box records what it painted in data-ac-value.
    return { attr: r.dataset.attr, value: w ? String(w.attributes[r.dataset.attr]) : '?', text: box ? (box.dataset.acValue ?? (box.textContent || '').trim()) : '', field: input ? input.value : '',
      selected: box ? (box.dataset.acSelected || null) : null, target: box ? (box.dataset.acTarget || null) : null, widgetLeft: wd ? wd.style.left : '', locked: !!(w && w.attributeLocks && w.attributeLocks[r.dataset.attr]) };
  });
  const lit = document.querySelector('.template-btn [data-ac-state="10000017"]');
  const ae = document.activeElement;
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    attributes: w ? Object.assign({}, w.attributes) : {}, remaining: w ? w.attributesRemaining : -1,
    rows, credits: (document.querySelector('.attr-credits-value') || {}).textContent,
    focused: ae && ae.classList.contains('attr-value-input') ? ae.dataset.attr : (ae ? ae.tagName : null),
    inputFocused: !!(ui && ui.uiManager && ui.uiManager.inputFocused),
    profession: lit ? (lit.closest('.template-btn') || {}).dataset.profession : null,
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbafa] still waiting — reloading');
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
function valuePoint(attr: string): [number, number] {
  return screen(ROW_X + VALUE_X + VALUE_W - 8, ROW_Y0 + rowIndex[attr] * ROW_PITCH + ROW_H / 2);
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
    const rows = st.rows.map((r) => `${r.attr.slice(0, 3)} v${r.value} t"${r.text}" f"${r.field}"${r.selected === '1' ? ' SEL' : ''}${r.locked ? ' LOCK' : ''}`).join(' | ');
    console.log(`[core17kbbafa] ${file}: step ${st.step}, focus ${st.focused ?? 'none'}, str ${a.strength} end ${a.endurance} coord ${a.coordination} quick ${a.quickness} focus ${a.focus} self ${a.self}, remaining ${st.remaining} :: ${rows}`);
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
  /** A real click on `attr`'s value box (focus + SelectAll). */
  const clickValue = async (attr: string): Promise<void> => {
    const [x, y] = valuePoint(attr);
    await page.mouse.move(x - 3, y + 1, { steps: 3 });
    await page.mouse.click(x, y);
    await page.waitForTimeout(500);
  };

  console.log('[core17kbbafa] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=kbbafa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickSel('#btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(2000);
  await next();

  await shoot('profession-idle');

  // Click Strength's value: focus + SelectAll (the "10" inverted).
  await clickValue('strength');
  await shoot('profession-str-selected');

  // Type "6" (replaces the selection), then "0": the box shows the typing, nothing else moves.
  await page.keyboard.type('6', { delay: 80 });
  await page.waitForTimeout(400);
  await shoot('profession-str-typed-6');
  await page.keyboard.type('0', { delay: 80 });
  await page.waitForTimeout(400);
  await shoot('profession-str-typed-60');

  // Enter: the text lands — 60, the widget at 148, the credits 220.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await shoot('profession-str-entered-60');

  // Endurance "250" + Escape → 100.
  await clickValue('endurance');
  await page.keyboard.type('250', { delay: 60 });
  await page.waitForTimeout(300);
  await shoot('profession-end-typed-250');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  await shoot('profession-end-escaped-100');

  // Focus "070" then a click on the page (the focus moves): wcstoul base 0 reads octal → 56.
  await clickValue('focus');
  await page.keyboard.type('070', { delay: 60 });
  await page.waitForTimeout(300);
  await shoot('profession-focus-typed-070');
  await page.mouse.click(OFF_X + 150 * SCALE, OFF_Y + (PAGE_Y + 400) * SCALE);
  await page.waitForTimeout(700);
  await parkMouse();
  await shoot('profession-focus-clicked-away-56');

  // Bow Hunter (credits spent), Coordination locked, Strength "90" + Tab: the rise drains the unlocked others, Coordination holds.
  await clickSel('.template-btn[data-profession="Bow Hunter"]');
  await page.waitForTimeout(1200);
  const [cx, cy] = lockPoint('coordination');
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(500);
  await clickValue('strength');
  await page.keyboard.type('90', { delay: 60 });
  await page.waitForTimeout(300);
  await shoot('profession-bowhunter-str-typed-90');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(700);
  await shoot('profession-bowhunter-str-tab-90');

  // Self "abc" + Enter: letters are taken (no filter), to_uint32 reads 0 → 10.
  await clickValue('self');
  await page.keyboard.type('abc', { delay: 60 });
  await page.waitForTimeout(300);
  await shoot('profession-self-typed-abc');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await parkMouse();
  await shoot('profession-self-entered-10');

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
  const valueRect = (i: number, pad = 8): Rect => ({ x: ROW_X + VALUE_X - 60 - pad, y: ROW_Y0 + i * ROW_PITCH - pad, width: 60 + VALUE_W + 2 * pad, height: ROW_H + 2 * pad });
  const rowsRect: Rect = { x: ROW_X - 6, y: ROW_Y0 - 6, width: ROW_W + 12, height: ROW_PITCH * 5 + ROW_H + 12 };
  const rowCrop = (name: string, i: number, label: string, zoom = 3): string => cropOurs(ours(name), rowRect(i), label, zoom);
  const valueCrop = (name: string, i: number, label: string, zoom = 4): string => cropOurs(ours(name), valueRect(i), label, zoom);
  const table = (): string => {
    const names = Object.keys(live.screens);
    if (!names.length) return '';
    const head = `<tr><th>shot</th><th>focused</th><th>str</th><th>end</th><th>coord</th><th>quick</th><th>focus</th><th>self</th><th>remaining</th><th>box texts</th><th>field values</th><th>selected</th></tr>`;
    const rows = names.map((n) => { const s = live.screens[n].state; const a = s.attributes; return `<tr><td style="text-align:left">${n}</td><td>${s.focused ?? '—'}</td><td>${a.strength}</td><td>${a.endurance}</td><td>${a.coordination}</td><td>${a.quickness}</td><td>${a.focus}</td><td>${a.self}</td><td>${s.remaining}</td><td style="text-align:left">${s.rows.map((r) => r.text).join(' / ')}</td><td style="text-align:left">${s.rows.map((r) => r.field).join(' / ')}</td><td style="text-align:left">${s.rows.filter((r) => r.selected === '1').map((r) => r.attr).join(', ') || '—'}</td></tr>`; }).join('');
    return `<table>${head}${rows}</table>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.f.a — the profession page's value box 0x100002ef as an edit field: a click selects the number (the glyph box inverted — DrawSelf's NotColorBits), typing shows in the DAT font while the attribute / widget / credits hold (the slider's p133 write is dead: no p132), Enter / Escape / a focus move commit to_uint32 (wcstoul base 0) held to [10, 100] through SetAttribValue. Retail (the EoL heritage page — no EoL profession-page screenshot is on file; the DAT + decompiled client are the reference) | before (CORE.17.k.b.b.a.f close: a static value) | after.</h1>
    <div class="row">${frame(RETAIL_HERITAGE, 'retail — EoL chargen (heritage page, char-create-ref1.png): the chrome family', 600)}${frame(BEFORE, 'before — profession page (CORE.17.k.b.b.a.f close)', 700)}${frame(ours('profession-idle'), 'after — profession page, idle (the edit fields are invisible until used)', 700)}</div>
    <h2>Strength's value box at 4x — idle | clicked (the "10" selected: inverted) | "6" typed | "60" typed (the widget still at 10, credits 270) | Enter (60 landed: widget 148, credits 220)</h2>
    <div class="row">${valueCrop('profession-idle', 0, 'idle — 10')}${valueCrop('profession-str-selected', 0, 'clicked — SelectAll, inverted')}${valueCrop('profession-str-typed-6', 0, '"6" typed')}${valueCrop('profession-str-typed-60', 0, '"60" typed')}${valueCrop('profession-str-entered-60', 0, 'Enter — 60')}</div>
    <div class="row">${rowCrop('profession-str-typed-60', 0, 'the Strength row while "60" is typed: the widget holds at 24 (value 10)')}${rowCrop('profession-str-entered-60', 0, 'after Enter: the widget at 148 (0.6 × 247), the value 60')}</div>
    <h2>Endurance "250" + Escape → 100 (Escape commits too) | Focus "070" then a click elsewhere → 56 (wcstoul base 0: octal)</h2>
    <div class="row">${valueCrop('profession-end-typed-250', 1, 'Endurance — "250" typed')}${valueCrop('profession-end-escaped-100', 1, 'Escape — 100')}${valueCrop('profession-focus-typed-070', 4, 'Focus — "070" typed')}${valueCrop('profession-focus-clicked-away-56', 4, 'clicked away — 56')}</div>
    <h2>Bow Hunter (0 credits), Coordination locked, Strength "90" + Tab: the rise clamps to the room and drains the unlocked others; Coordination holds | Self "abc" + Enter → 10 (no input filter; to_uint32 of letters is 0)</h2>
    <div class="row">${cropOurs(ours('profession-bowhunter-str-typed-90'), rowsRect, 'Strength "90" typed (nothing moved yet)', 2)}${cropOurs(ours('profession-bowhunter-str-tab-90'), rowsRect, 'Tab — 90 landed, the others paid, Coordination at 100', 2)}${valueCrop('profession-self-typed-abc', 5, 'Self — "abc" typed')}${valueCrop('profession-self-entered-10', 5, 'Enter — 10')}</div>
    <h2>the wizard state per shot (live-state.json)</h2>
    ${table()}
    <h2>whole pages — after, each step</h2>
    <div class="row">${frame(ours('profession-str-selected'), 'Strength selected', 560)}${frame(ours('profession-str-typed-60'), '"60" typed', 560)}${frame(ours('profession-str-entered-60'), 'Enter', 560)}${frame(ours('profession-end-escaped-100'), 'Endurance Escape 100', 560)}</div>
    <div class="row">${frame(ours('profession-focus-clicked-away-56'), 'Focus 070 → 56', 560)}${frame(ours('profession-bowhunter-str-tab-90'), 'Bow Hunter, Strength 90 + Tab', 560)}${frame(ours('profession-self-entered-10'), 'Self abc → 10', 560)}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbafa-attribute-value-input-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbafa] wrote ${join(OUT, 'core17kbbafa-attribute-value-input-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
