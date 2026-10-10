/**
 * CORE.17.k.b.b.a.c — live capture + side-by-side for the chargen Summary
 * page 0x2100004b: the listbox 0x10000400 filled per
 * gmCGSummaryPage::SetSummaryText (the profession / gender / heritage / town
 * rows, the Attributes header on the 0x06004d0b bar, the ten name / value
 * rows, the four skill sections), the how-to 0x10000404 per SetHowToText
 * (SummaryHowTo + the heritage's naming conventions + SummaryHowToEnd), the
 * name field 0x10000402 with the ID_CharGen_NamePrompt, the 33-character
 * limit dialog (DoNameLimitDialog), the no-name / credit-warning FINISH
 * dialogs (gmCharGenMainUI::DoFinish) and the 3D view 0x10000406.
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character → Next x5 to the summary; the
 * default page, then a customised state (Bow Hunter, Yaraq, a specialised
 * skill, raised attributes) through the wizard API, a typed name, the 33rd
 * character (the NameTooLong dialog), FINISH with nothing typed (the
 * NoNameWarning dialog) and FINISH with credits left (the CreditWarning
 * dialog — answered No). Composition: before (the CORE.17.k.b.b.a.b close
 * capture) | after whole pages, then crops. No retail summary-page
 * screenshot is on file (reference/images/preworld/ has the heritage page
 * only) — the DAT + decompiled client are the reference.
 *
 *   npx tsx tools/capture-core17kbbac-chargen-summary-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbac');
const BEFORE = join(REPO, 'verification', 'core17kbbab', 'ours-char-create-summary.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;

interface Rect { x: number; y: number; width: number; height: number }

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const STATE_JS = `(() => {
  const run = (el) => el.tagName === 'CANVAS' ? (el.dataset.acWrapText || el.dataset.acText || '') : (el.textContent || '');
  const rows = Array.from(document.querySelectorAll('.summary-row')).map((row) => ({
    kind: row.classList.contains('summary-row-header') ? 'header' : row.classList.contains('summary-row-value') ? 'value' : 'text',
    runs: Array.from(row.querySelectorAll('[data-ac-desc]')).map((el) => ({ desc: el.dataset.acDesc, font: el.dataset.acFont, text: run(el) })),
    tex: row.dataset.tex, image: !!row.style.backgroundImage,
  }));
  const howTo = document.querySelector('.summary-howto [data-ac-desc]');
  const input = document.getElementById('char-name-input');
  const canvas = document.querySelector('.chargen-summary-canvas');
  let drawn = null;
  if (canvas) { try { const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; drawn = n; } catch (e) { drawn = 'err'; } }
  const ui = window.__ac && window.__ac.gameUI;
  return {
    rows, rowCount: rows.length,
    howTo: howTo ? { desc: howTo.dataset.acDesc, font: howTo.dataset.acFont, chars: run(howTo).length, head: run(howTo).slice(0, 60), tail: run(howTo).slice(-60) } : null,
    input: input ? { value: input.value, prompt: input.dataset.prompt, maxlength: input.getAttribute('maxlength'), align: input.style.textAlign } : null,
    canvas: canvas ? { w: canvas.width, h: canvas.height, opaquePixels: drawn } : null,
    frames: Array.from(document.querySelectorAll('.ac-dat-frame')).map((el) => ({ desc: el.dataset.frameDesc, rect: [el.style.left, el.style.top, el.style.width, el.style.height].join(' ') })),
    scrollbar: (() => { const b = document.querySelector('.summary-scrollbar'); return b ? { rect: [b.style.left, b.style.top, b.style.width, b.style.height].join(' '), pieces: Array.from(b.querySelectorAll('[data-tex]')).map((p) => p.dataset.tex) } : null; })(),
    messageDialog: (() => { const d = document.getElementById('ac-message-dialog'); return d ? Array.from(d.querySelectorAll('*')).map(run).filter(Boolean).join(' ') : null; })(),
    confirmDialog: (() => { const d = document.querySelector('.ac-dialog-text'); return d ? Array.from(d.querySelectorAll('*')).map(run).filter(Boolean).join(' ') : null; })(),
    wizard: ui && ui.wizard ? { name: ui.wizard.name, heritage: ui.wizard.heritage, gender: ui.wizard.gender, startArea: ui.wizard.startArea, profession: ui.selectedProfession, attributesRemaining: ui.wizard.attributesRemaining, skillCreditsRemaining: ui.wizard.skillCreditsRemaining, nameEntered: ui.chargenNameEntered } : null,
    validationLeftovers: !!document.getElementById('name-validation') || (document.body.textContent || '').includes('Enter a name for your character'),
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbac] still waiting — reloading');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      lastReload = Date.now();
    }
    await page.waitForTimeout(2500);
  }
  return false;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { if (/\[AC\] (ACE|CharacterError)/.test(m.text())) console.log(`  [page] ${m.text().slice(0, 120)}`); });
  const state: Record<string, unknown> = { capturedAt: new Date().toISOString(), viewport: VIEW, scale: SCALE, screens: {} };
  const screens = state.screens as Record<string, { file: string; state: unknown }>;
  const shoot = async (name: string): Promise<unknown> => {
    const file = `ours-${name}.png`;
    await page.screenshot({ path: join(OUT, file) });
    const st = await page.evaluate(STATE_JS) as { rowCount: number; input: unknown; messageDialog: unknown; confirmDialog: unknown };
    screens[name] = { file, state: st };
    console.log(`[core17kbbac] ${file}: ${st.rowCount} rows, input ${JSON.stringify(st.input)}, msg ${JSON.stringify(st.messageDialog)?.slice(0, 60)}, confirm ${JSON.stringify(st.confirmDialog)?.slice(0, 60)}`);
    return st;
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const clickById = (id: string): Promise<boolean> => clickSel(`#${id}`);
  const currentStep = async (): Promise<number> => page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as Promise<number>;

  console.log('[core17kbbac] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=kbbac`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickById('btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(1200);
    const before = await currentStep();
    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      clicked = await clickById('btn-next').catch(() => false);
      if (!clicked) await page.waitForTimeout(1000);
    }
    if (!clicked) {
      await page.evaluate(`(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.wizard) { ui.wizard.nextStep(); ui.renderCharacterCreate(); } })()`).catch(() => {});
    }
    const advanced = await page.waitForFunction((prev) =>
      parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev, before, { timeout: 15_000 })
      .then(() => true).catch(() => false);
    if (!advanced) throw new Error(`wizard did not advance past step ${before}`);
  }
  await page.waitForTimeout(2500);
  if ((await currentStep()) !== 5) throw new Error('not on the summary page');
  await shoot('char-create-summary');

  // A customised character through the wizard API (the pages' own controls
  // are covered by their captures): Bow Hunter, Yaraq, Gharu'ndim female,
  // Melee Defense specialised, Run trained, strength / quickness raised.
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.selectedProfession = 'Bow Hunter'; ui.wizard.setHeritage(2); ui.wizard.setGender(2); ui.wizard.startArea = 2;
    ui.wizard.attributes.strength = 60; ui.wizard.attributes.quickness = 73; ui.wizard.attributes.endurance = 31;
    ui.wizard.skills.set(6, 3); ui.wizard.skills.set(24, 2); ui.renderCharacterCreate(); })()`);
  await page.waitForTimeout(2000);
  await shoot('char-create-summary-custom');
  // Olthoi: the (0, −3.8, 1.15) camera.
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.wizard.setHeritage(12); ui.wizard.setGender(1); ui.renderCharacterCreate(); })()`);
  await page.waitForTimeout(2000);
  await shoot('char-create-summary-olthoi');
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.wizard.setHeritage(1); ui.renderCharacterCreate(); })()`);
  await page.waitForTimeout(1500);

  // FINISH with nothing typed → the NoNameWarning OK dialog.
  await clickById('btn-confirm');
  await page.waitForTimeout(800);
  await shoot('char-create-summary-noname-dialog');
  await clickSel('#ac-message-dialog-ok');
  await page.waitForTimeout(500);

  // Type a name (the prompt is selected whole, so typing replaces it).
  await page.focus('#char-name-input');
  await page.keyboard.type('Elowen Ashsun', { delay: 20 });
  await page.waitForTimeout(600);
  await shoot('char-create-summary-named');
  // The 33rd character → NameTooLong dialog, the field back to the stored name.
  await page.evaluate(`(() => { const el = document.getElementById('char-name-input'); el.value = 'A'.repeat(33); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.waitForTimeout(800);
  await shoot('char-create-summary-toolong-dialog');
  await clickSel('#ac-message-dialog-ok');
  await page.waitForTimeout(500);
  // FINISH with attribute credits left → the CreditWarning Yes / No; answer No.
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.wizard.attributes.strength = 10; ui.renderCharacterCreate(); })()`);
  await page.waitForTimeout(1500);
  await clickById('btn-confirm');
  await page.waitForTimeout(800);
  await shoot('char-create-summary-credit-dialog');
  await page.evaluate(`(() => { const b = document.querySelectorAll('.ac-dialog-button'); if (b[1]) b[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
  await page.waitForTimeout(500);

  await clickById('btn-cancel');
  await page.waitForTimeout(500);
  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}
function cropOf(file: string, rect: Rect, frameW: number, frameH: number, label: string, zoom: number): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><div class="crop" style="width:${Math.round(rect.width * zoom)}px;height:${Math.round(rect.height * zoom)}px"><img src="${dataUrl(file)}" style="left:${-rect.x * zoom}px;top:${-rect.y * zoom}px;width:${frameW * zoom}px;height:${frameH * zoom}px"/></div></div>`;
}
function frameRect(dat: Rect): Rect {
  return { x: OFF_X + dat.x * SCALE, y: OFF_Y + dat.y * SCALE, width: dat.width * SCALE, height: dat.height * SCALE };
}
function cropOurs(file: string, dat: Rect, label: string, zoom: number): string {
  return cropOf(file, frameRect(dat), VIEW.width, VIEW.height, label, zoom / SCALE);
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
</style>`;

async function compose(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2300, height: 900 } });
  const ours = (n: string) => join(OUT, `ours-${n}.png`);
  // Layout rects in 800x600 (content y + 55).
  const LISTBOX: Rect = { x: 5, y: 75, width: 300, height: 470 };
  const LISTBOX_TOP: Rect = { x: 12, y: 83, width: 255, height: 200 };
  const NAME_HOWTO: Rect = { x: 305, y: 75, width: 270, height: 470 };
  const NAME: Rect = { x: 310, y: 78, width: 260, height: 55 };
  const VIEW3D: Rect = { x: 570, y: 75, width: 230, height: 470 };
  const DIALOG: Rect = { x: 190, y: 240, width: 420, height: 130 };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.c — chargen summary 0x2100004b: SetSummaryText's listbox rows (0x2100004c row templates 0x100002f8 / fa / fb), SetHowToText's how-to, the ID_CharGen_NamePrompt name field, DoNameLimitDialog / DoFinish's dialogs, the 3D view 0x10000406. Before (CORE.17.k.b.b.a.b close) | after — whole pages, then crops. No retail summary-page screenshot is on file; the DAT + decompiled client are the reference.</h1>
    <div class="row">${frame(BEFORE, 'before — summary (invented rows, validation line + box, empty viewport frame)')}${frame(ours('char-create-summary'), 'after — default (Custom / Male / Aluvian / Holtburg, the [ Name ] prompt)')}</div>
    <div class="row">${frame(ours('char-create-summary-custom'), "after — Bow Hunter / Female / Gharu'ndim / Yaraq, Melee Defense specialised, Run trained, raised attributes")}${frame(ours('char-create-summary-named'), 'after — a typed name')}</div>
    <h2>listbox 0x10000400 (0x100003ff frame + the standalone scrollbar 0x10000401) — before | after default | after customised — 1.5x</h2>
    <div class="row">${cropOurs(BEFORE, LISTBOX, 'before', 1.5)}${cropOurs(ours('char-create-summary'), LISTBOX, 'after — default', 1.5)}${cropOurs(ours('char-create-summary-custom'), LISTBOX, 'after — customised', 1.5)}</div>
    <h2>listbox head rows — text rows (0x100002f9 white, 7 px in), the Attributes header (0x06004d0b bar, 0x100000fe yellow centred), name / value rows (0x100002fc / fd grey, value right-justified 20 px in) — 3x</h2>
    <div class="row">${cropOurs(BEFORE, LISTBOX_TOP, 'before', 3)}${cropOurs(ours('char-create-summary-custom'), LISTBOX_TOP, 'after', 3)}</div>
    <h2>name field 0x10000402 + how-to 0x10000404 — before | after (prompt) | after (typed) — 1.5x; the field at 3x</h2>
    <div class="row">${cropOurs(BEFORE, NAME_HOWTO, 'before', 1.5)}${cropOurs(ours('char-create-summary'), NAME_HOWTO, 'after — "[ Name ]" prompt, SummaryHowTo + AluMaleNames + SummaryHowToEnd', 1.5)}${cropOurs(ours('char-create-summary-named'), NAME_HOWTO, 'after — typed', 1.5)}</div>
    <div class="row">${cropOurs(BEFORE, NAME, 'before (centred, empty)', 3)}${cropOurs(ours('char-create-summary'), NAME, 'after — prompt, left-justified 8 px in', 3)}${cropOurs(ours('char-create-summary-named'), NAME, 'after — typed', 3)}</div>
    <h2>3D view 0x10000406 in the 0x10000405 frame — before (empty) | after Aluvian (camera (0, −2.5, 0.95)) | after Gharu'ndim female | after Olthoi ((0, −3.8, 1.15)) — 1.2x</h2>
    <div class="row">${cropOurs(BEFORE, VIEW3D, 'before', 1.2)}${cropOurs(ours('char-create-summary'), VIEW3D, 'after — Aluvian male', 1.2)}${cropOurs(ours('char-create-summary-custom'), VIEW3D, "after — Gharu'ndim female", 1.2)}${cropOurs(ours('char-create-summary-olthoi'), VIEW3D, 'after — Olthoi', 1.2)}</div>
    <h2>dialogs — FINISH with nothing typed (ID_CharGen_NoNameWarning, type 3) | the 33rd character (ID_CharGen_NameTooLong, type 3) | FINISH with attribute credits left (ID_CharGen_CreditWarning, type 1 Yes / No) — 1.5x</h2>
    <div class="row">${cropOurs(ours('char-create-summary-noname-dialog'), DIALOG, 'no name', 1.5)}${cropOurs(ours('char-create-summary-toolong-dialog'), DIALOG, 'too long', 1.5)}${cropOurs(ours('char-create-summary-credit-dialog'), DIALOG, 'credits left', 1.5)}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbac-summary-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbac] wrote ${join(OUT, 'core17kbbac-summary-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
