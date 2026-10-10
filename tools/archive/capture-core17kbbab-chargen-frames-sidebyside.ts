/**
 * CORE.17.k.b.b.a.b — live capture + side-by-side for the chargen pages'
 * DAT frames (0x2100004c:0x100002dd nine-slice on every text panel / the
 * map / the viewports), the town page's retail description strings
 * (ID_CharGen_TownHowTo + "\n\n" + ID_CharGen_<Town>Text) and StarterAreas
 * indices, the profession rows' 0x100002e9 radio (0x06004d37 / 38) and the
 * profession description (ID_CharGen_*Text on 0x100003e0).
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character → the six pages via Next; on
 * the profession page the Bow Hunter row is clicked, on the town page the
 * Shoushi and Yaraq pins (the start-area index and the description text
 * are recorded per click). Composition: the retail heritage frame
 * (reference/images/preworld/char-create-ref1.png) | before (the CORE.17.k.b.b.a
 * captures in verification/core17kbba/) | after, whole pages then crops.
 *
 *   npx tsx tools/capture-core17kbbab-chargen-frames-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbab');
const BEFORE_DIR = join(REPO, 'verification', 'core17kbba');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;
const REF_HERITAGE = join(REPO, 'reference', 'images', 'preworld', 'char-create-ref1.png');

interface Rect { x: number; y: number; width: number; height: number }
interface Run { desc: string; state?: string; font?: string; text: string }

const PAGES = ['heritage', 'profession', 'skills', 'appearance', 'town', 'summary'];

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const RUNS_JS = `(() => Array.from(document.querySelectorAll('[data-ac-desc]')).map((el) => ({
  desc: el.dataset.acDesc, state: el.dataset.acState, font: el.dataset.acFont,
  text: el.tagName === 'CANVAS' ? (el.dataset.acWrapText || '') : (el.textContent || ''),
})))()`;
const FRAMES_JS = `(() => Array.from(document.querySelectorAll('.ac-dat-frame')).map((el) => ({
  desc: el.dataset.frameDesc, rect: [el.style.left, el.style.top, el.style.width, el.style.height].join(' '),
  pieces: Array.from(el.querySelectorAll('[data-frame-piece]')).map((p) => p.dataset.tex + (p.style.backgroundImage ? '' : ' (no image)')),
  fill: el.style.backgroundImage ? 'media' : el.style.background, scrollbar: !!el.querySelector('.ac-dat-frame-scrollbar'),
})))()`;
const RADIOS_JS = `(() => Array.from(document.querySelectorAll('.chargen-row-radio')).map((el) => ({ tex: el.dataset.tex, state: el.dataset.state, image: !!el.style.backgroundImage, row: el.parentElement && (el.parentElement.dataset.profession || el.parentElement.dataset.mode) })))()`;

async function runs(page: Page): Promise<Run[]> {
  return page.evaluate(RUNS_JS) as Promise<Run[]>;
}

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbab] still waiting — reloading');
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
  const screens = state.screens as Record<string, { file: string; runs: Run[]; frames: unknown; radios: unknown; extra?: unknown }>;
  const shoot = async (name: string, extra?: unknown): Promise<void> => {
    const file = `ours-${name}.png`;
    await page.screenshot({ path: join(OUT, file) });
    screens[name] = { file, runs: await runs(page), frames: await page.evaluate(FRAMES_JS), radios: await page.evaluate(RADIOS_JS), extra };
    console.log(`[core17kbbab] ${file}: ${screens[name].runs.length} desc runs, ${(screens[name].frames as unknown[]).length} frames`);
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const clickById = (id: string): Promise<boolean> => clickSel(`#${id}`);
  const currentStep = async (): Promise<number> => page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as Promise<number>;
  const wizardState = async (): Promise<unknown> => page.evaluate(`(() => { const ui = window.__ac && window.__ac.gameUI; return ui && ui.wizard ? { startArea: ui.wizard.startArea, profession: ui.selectedProfession } : null; })()`);

  console.log('[core17kbbab] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=kbbab`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickById('btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  for (let i = 0; i < PAGES.length; i++) {
    await page.waitForTimeout(1800);
    await shoot(`char-create-${PAGES[i]}`, { step: await currentStep(), wizard: await wizardState() });
    if (PAGES[i] === 'profession') {
      if (await clickSel('.template-btn[data-profession="Bow Hunter"]')) {
        await page.waitForTimeout(900);
        await shoot('char-create-profession-bowhunter', { wizard: await wizardState() });
        await clickSel('.template-btn[data-profession="Custom"]');
        await page.waitForTimeout(600);
      }
    }
    if (PAGES[i] === 'town') {
      for (const [area, name] of [['1', 'shoushi'], ['2', 'yaraq']]) {
        if (await clickSel(`.map-pin[data-area="${area}"]`)) {
          await page.waitForTimeout(900);
          await shoot(`char-create-town-${name}`, { wizard: await wizardState() });
        }
      }
      await clickSel('.map-pin[data-area="0"]');
      await page.waitForTimeout(600);
    }
    if (i === PAGES.length - 1) break;
    const before = await currentStep();
    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      clicked = await clickById('btn-next').catch(() => false);
      if (!clicked) await page.waitForTimeout(1000);
    }
    if (!clicked) {
      console.warn('[core17kbbab] #btn-next missing after 3 tries — advancing through the wizard API');
      await page.evaluate(`(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.wizard) { ui.wizard.nextStep(); ui.renderCharacterCreate(); } })()`).catch(() => {});
    }
    const advanced = await page.waitForFunction((prev) =>
      parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev, before, { timeout: 15_000 })
      .then(() => true).catch(() => false);
    if (!advanced) { console.warn(`[core17kbbab] wizard did not advance past step ${before}`); break; }
  }
  await clickById('btn-cancel');
  await page.waitForTimeout(500);
  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : file.endsWith('.webp') ? 'webp' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
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
/** The retail ref is 600x450 = the 800x600 frame at 0.75. */
function cropRef(dat: Rect, label: string, zoom: number): string {
  const r = { x: dat.x * 0.75, y: dat.y * 0.75, width: dat.width * 0.75, height: dat.height * 0.75 };
  return cropOf(REF_HERITAGE, r, 600, 450, label, zoom / 0.75);
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
  const before = (n: string) => join(BEFORE_DIR, `ours-${n}.png`);
  const ours = (n: string) => join(OUT, `ours-${n}.png`);

  const pageRows = PAGES.map((p) => `<div class="row">${frame(before(`char-create-${p}`), `before — ${p} (CORE.17.k.b.b.a close capture)`)}${frame(ours(`char-create-${p}`), `after — ${p}`)}</div>`).join('');
  // Layout rects in 800x600 (content y = layout y): the lore panel, its
  // corners, the town panels, the profession rows + description.
  const LORE: Rect = { x: 530, y: 70, width: 265, height: 450 };
  const LORE_TL: Rect = { x: 520, y: 60, width: 80, height: 70 };
  const LORE_BR: Rect = { x: 725, y: 470, width: 80, height: 65 };
  const TOWN_DESC: Rect = { x: 0, y: 130, width: 275, height: 425 };
  const TOWN_MAP_TL: Rect = { x: 280, y: 57, width: 120, height: 100 };
  const PROF_ROWS: Rect = { x: 10, y: 95, width: 260, height: 280 };
  const PROF_DESC: Rect = { x: 15, y: 365, width: 265, height: 185 };
  const PROF_STRIP: Rect = { x: 20, y: 62, width: 770, height: 58 };
  const APPEAR_LEFT: Rect = { x: 0, y: 130, width: 300, height: 380 };
  const APPEAR_VIEW: Rect = { x: 520, y: 70, width: 275, height: 400 };
  const SKILLS_LEFT: Rect = { x: 0, y: 90, width: 460, height: 460 };
  const SUMMARY_MID: Rect = { x: 300, y: 75, width: 500, height: 470 };
  const crops = `
    <h2>heritage lore panel 0x100003c4 — the 0x2100004c:0x100002e6 frame (fill 0x06004cc2, corners 0x06004cc3–c6, edges 0x06004cc7 / 0x06004cb8) + the 0x100002e7 scrollbar; retail | before (CSS border) | after — 1.5x</h2>
    <div class="row">${cropRef(LORE, 'retail char-create-ref1.png', 1.5)}${cropOurs(before('char-create-heritage'), LORE, 'before', 1.5)}${cropOurs(ours('char-create-heritage'), LORE, 'after', 1.5)}</div>
    <h2>lore panel corners — 4x</h2>
    <div class="row">${cropRef(LORE_TL, 'retail top-left', 4)}${cropOurs(before('char-create-heritage'), LORE_TL, 'before', 4)}${cropOurs(ours('char-create-heritage'), LORE_TL, 'after', 4)}</div>
    <div class="row">${cropRef(LORE_BR, 'retail bottom-right (the down arrow + the 3 px overhang)', 4)}${cropOurs(before('char-create-heritage'), LORE_BR, 'before', 4)}${cropOurs(ours('char-create-heritage'), LORE_BR, 'after', 4)}</div>
    <h2>town page 0x2100004a — description 0x10000409 (0x100002e4 frame; ID_CharGen_TownHowTo + "\\n\\n" + ID_CharGen_HoltText) and the map frame corner; before | after Holtburg | after Shoushi (pin 1) | after Yaraq (pin 2) — 1.5x</h2>
    <div class="row">${cropOurs(before('char-create-town'), TOWN_DESC, 'before (invented one-liner)', 1.5)}${cropOurs(ours('char-create-town'), TOWN_DESC, 'after — Holtburg', 1.5)}${cropOurs(ours('char-create-town-shoushi'), TOWN_DESC, 'after — Shoushi (startArea 1)', 1.5)}${cropOurs(ours('char-create-town-yaraq'), TOWN_DESC, 'after — Yaraq (startArea 2)', 1.5)}</div>
    <div class="row">${cropOurs(before('char-create-town'), TOWN_MAP_TL, 'before — map corner (1 px CSS border)', 4)}${cropOurs(ours('char-create-town'), TOWN_MAP_TL, 'after — 0x100002dd corner 0x06004cc3', 4)}</div>
    <h2>profession page 0x21000047 — rows with the 0x100002e9 radio (0x06004d37 / lit 0x06004d38), the framed instruction strip 0x100003ec, the description 0x100003e0 = ID_CharGen_*Text; before | after Custom | after Bow Hunter — 2x</h2>
    <div class="row">${cropOurs(before('char-create-profession'), PROF_ROWS, 'before', 2)}${cropOurs(ours('char-create-profession'), PROF_ROWS, 'after — Custom', 2)}${cropOurs(ours('char-create-profession-bowhunter'), PROF_ROWS, 'after — Bow Hunter', 2)}</div>
    <div class="row">${cropOurs(before('char-create-profession'), PROF_DESC, 'before (attribute p73 help)', 2)}${cropOurs(ours('char-create-profession'), PROF_DESC, 'after — CustomText', 2)}${cropOurs(ours('char-create-profession-bowhunter'), PROF_DESC, 'after — BowText', 2)}</div>
    <div class="row">${cropOurs(before('char-create-profession'), PROF_STRIP, 'before', 1.5)}</div>
    <div class="row">${cropOurs(ours('char-create-profession'), PROF_STRIP, 'after — 0x100003ec framed (margins 8 / 8 / 5 / 5, DAT font)', 1.5)}</div>
    <h2>skills 0x21000048 (0x100003f6 / fa / fd), appearance 0x21000049 (0x100003ab + scrollbar, 0x100003ba viewport frame), summary 0x2100004b (0x100003ff / 402 / 404 / 405) — 1.5x</h2>
    <div class="row">${cropOurs(before('char-create-skills'), SKILLS_LEFT, 'before — skills', 1.2)}${cropOurs(ours('char-create-skills'), SKILLS_LEFT, 'after — skills', 1.2)}</div>
    <div class="row">${cropOurs(before('char-create-appearance'), APPEAR_LEFT, 'before — appearance options panel', 1.5)}${cropOurs(ours('char-create-appearance'), APPEAR_LEFT, 'after — Face lit 0x06004d38, Clothes 0x06004d37, 0x100002e6 frame + scrollbar', 1.5)}${cropOurs(before('char-create-appearance'), APPEAR_VIEW, 'before — preview', 1.2)}${cropOurs(ours('char-create-appearance'), APPEAR_VIEW, 'after — 0x100003ba frame', 1.2)}</div>
    <div class="row">${cropOurs(before('char-create-summary'), SUMMARY_MID, 'before — summary (name area, detail 55 px low)', 1.2)}${cropOurs(ours('char-create-summary'), SUMMARY_MID, 'after — 0x10000402 name field frame, 0x10000404 at DAT y, 0x10000405 viewport frame', 1.2)}</div>`;
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.a.b — chargen 0x21000046–4b: the DAT frame template 0x2100004c:0x100002dd on every text panel / map / viewport, the retail town strings + StarterAreas indices, the 0x100002e9 row radio, the profession description. Retail heritage frame | before | after; whole pages then crops.</h1>
    <div class="row">${frame(REF_HERITAGE, 'reference char-create-ref1.png (600x450, retail heritage page — the lore panel frame + scrollbar)', 600)}</div>
    ${pageRows}${crops}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbab-chargen-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbab] wrote ${join(OUT, 'core17kbbab-chargen-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
