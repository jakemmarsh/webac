/**
 * CORE.17.k.b.b.a — live evidence for the p33/p34 OUTLINE (with the p26 font
 * and p27 colour) on the pre-world labels GameUI draws itself:
 *
 *   char-select 0x21000004   Create Character / ENTER / DELETE / CREDITS /
 *                            EXIT (instances of the 0x21000040 templates
 *                            0x100002d2 / d9 / d1) + the World box text.
 *   chargen 0x21000038 bar   Help / Exit / Random (0x100002c5), FINISH
 *                            (0x100002c8), the Back / Next chevron media.
 *   chargen pages 0x21000046–4a  heritage rows, profession rows, attribute
 *                            names, credits + vitals, skills header, Face /
 *                            Clothes, town heading + pin names.
 *
 * The live pass drives the running stack (Vite + bridge + ACE) through the
 * connect cycle to char select, selects the first character, then walks the
 * six wizard pages; it writes ours-*.png full frames + ours-live-state.json
 * (every [data-ac-desc] run: desc / state / font / outline / colour / text).
 * `before-*.png` are the pre-change captures (capture-preworld-screens.ts run
 * on the previous build, copied in). The compose step writes
 *   core17kbba-charselect-sidebyside.png   retail Wine frame | before | after
 *                                          + 3x crops per button
 *   core17kbba-chargen-sidebyside.png      ref | before | after per page +
 *                                          3x crops (rows, bar, FINISH)
 *   core17kbba-halo-pixels.json            dark-rim pixel counts, before/after
 * under verification/core17kbba/.
 *
 * Usage: npx tsx tools/capture-core17kbba-preworld-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbba');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
/** The pre-world 800x600 frame is letterboxed into the viewport (GameUI.attachPreworldScale). */
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;
const WINE_CHARSEL = join(REPO, 'docs', 'images', 'retail-client-wine-charselect.png');
const REF_RACE = join(REPO, 'reference', 'images', 'preworld', 'char-create-race-ref1.webp');

interface Rect { x: number; y: number; width: number; height: number }
interface Run { desc: string; state?: string; font?: string; outline?: string; color: string; text: string }

const PAGES = ['heritage', 'profession', 'skills', 'appearance', 'town', 'summary'];

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const RUNS_JS = `(() => Array.from(document.querySelectorAll('[data-ac-desc]')).map((el) => ({
  desc: el.dataset.acDesc, state: el.dataset.acState, font: el.dataset.acFont, outline: el.dataset.acOutline,
  color: el.style.color, text: el.tagName === 'CANVAS' ? (el.dataset.acWrapText || '') : (el.textContent || ''),
})))()`;

async function runs(page: Page): Promise<Run[]> {
  return page.evaluate(RUNS_JS) as Promise<Run[]>;
}

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbba] not up yet — reloading (phantom retry)');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
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
  const screens = state.screens as Record<string, { file: string; runs: Run[]; extra?: unknown }>;
  const shoot = async (name: string, extra?: unknown): Promise<void> => {
    const file = `ours-${name}.png`;
    await page.screenshot({ path: join(OUT, file) });
    screens[name] = { file, runs: await runs(page), extra };
    console.log(`[core17kbba] ${file}: ${screens[name].runs.length} desc runs`);
  };

  console.log('[core17kbba] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=kbba`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  await shoot('char-select-noselect');
  const selected = await page.evaluate(`(() => { const s = document.querySelector('.char-slot'); if (!s) return false; s.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await page.waitForTimeout(800);
  await shoot('char-select', { selected });

  // ── chargen: walk the six pages ──
  const clickById = async (id: string): Promise<boolean> => page.evaluate(`(() => { const el = document.getElementById('${id}'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const currentStep = async (): Promise<number> => page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as Promise<number>;
  if (!(await clickById('btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  for (let i = 0; i < PAGES.length; i++) {
    await page.waitForTimeout(1800);
    const barMedia = await page.evaluate(`(() => ({ back: document.getElementById('btn-back')?.dataset.acMedia, next: document.getElementById('btn-next')?.dataset.acMedia }))()`);
    await shoot(`char-create-${PAGES[i]}`, { step: await currentStep(), barMedia });
    if (i === PAGES.length - 1) break;
    const before = await currentStep();
    // The Next click is the player's path; under SwiftShader contention a
    // single evaluate has been seen to miss the button, so retry, and fall
    // back to the wizard API (window.__ac.gameUI) rather than lose the page.
    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      clicked = await clickById('btn-next').catch(() => false);
      if (!clicked) await page.waitForTimeout(1000);
    }
    if (!clicked) {
      console.warn('[core17kbba] #btn-next missing after 3 tries — advancing through the wizard API');
      await page.evaluate(`(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.wizard) { ui.wizard.nextStep(); ui.renderCharacterCreate(); } })()`).catch(() => {});
    }
    const advanced = await page.waitForFunction((prev) =>
      parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev, before, { timeout: 15_000 })
      .then(() => true).catch(() => false);
    if (!advanced) { console.warn(`[core17kbba] wizard did not advance past step ${before}`); break; }
  }
  await clickById('btn-cancel');
  await page.waitForTimeout(500);
  writeFileSync(join(OUT, 'ours-live-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : file.endsWith('.webp') ? 'webp' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

/** A CSS crop of a frame file at `zoom` (pixelated). */
function cropOf(file: string, rect: Rect, frameW: number, frameH: number, label: string, zoom: number): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><div class="crop" style="width:${Math.round(rect.width * zoom)}px;height:${Math.round(rect.height * zoom)}px"><img src="${dataUrl(file)}" style="left:${-rect.x * zoom}px;top:${-rect.y * zoom}px;width:${frameW * zoom}px;height:${frameH * zoom}px"/></div></div>`;
}
/** A DAT 800x600 rect → our letterboxed 1568x775 frame. */
function frameRect(dat: Rect): Rect {
  return { x: OFF_X + dat.x * SCALE, y: OFF_Y + dat.y * SCALE, width: dat.width * SCALE, height: dat.height * SCALE };
}
function cropOurs(file: string, dat: Rect, label: string, zoom: number): string {
  return cropOf(file, frameRect(dat), VIEW.width, VIEW.height, label, zoom / SCALE);
}
function cropWine(dat: Rect, label: string, zoom: number): string {
  return cropOf(WINE_CHARSEL, dat, 800, 600, label, zoom);
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

/** Char-select button rects (layout 0x21000004, 800x600). */
const CHARSEL_RECTS: Array<[string, Rect]> = [
  ['0x100003a0 Create Character (font 0x4000000c, 0xffffb219)', { x: 216, y: 185, width: 254, height: 113 }],
  ['0x100003a2 ENTER (font 0x40000012, 0xfffff27f)', { x: 239, y: 289, width: 211, height: 211 }],
  ['0x1000039f DELETE (font 0x4000000b, 0xffffb219)', { x: 36, y: 522, width: 170, height: 99 }],
  ['0x100003a3 CREDITS', { x: 465, y: 522, width: 170, height: 99 }],
  ['0x100003a4 EXIT', { x: 615, y: 522, width: 170, height: 99 }],
  ['0x1000039b World box text (font 0x4000000b, 0xffd8af5b — no outline)', { x: 21, y: 44, width: 193, height: 110 }],
];

async function haloMetrics(page: Page): Promise<Record<string, unknown>> {
  // Count near-black pixels (the rim) and label-coloured pixels inside each
  // button rect, before vs after, on our frames; and the same on the Wine frame.
  const specs = [
    { name: 'delete', dat: { x: 36, y: 522, width: 170, height: 99 } },
    { name: 'enter', dat: { x: 239, y: 289, width: 211, height: 211 } },
    { name: 'create', dat: { x: 216, y: 185, width: 254, height: 113 } },
  ];
  const files: Record<string, string> = {};
  for (const f of ['before-char-select', 'ours-char-select']) if (existsSync(join(OUT, `${f}.png`))) files[f] = dataUrl(join(OUT, `${f}.png`));
  if (existsSync(WINE_CHARSEL)) files.wine = dataUrl(WINE_CHARSEL);
  const rects = specs.map((s) => ({ name: s.name, ours: frameRect(s.dat), wine: s.dat }));
  const js = `(async () => {
    const files = ${JSON.stringify(files)}; const rects = ${JSON.stringify(rects)};
    const out = {};
    for (const [key, url] of Object.entries(files)) {
      const img = new Image(); img.src = url; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      out[key] = {};
      for (const r of rects) {
        const rc = key === 'wine' ? r.wine : r.ours;
        const x0 = Math.round(rc.x), y0 = Math.round(rc.y), w = Math.round(rc.width), h = Math.round(rc.height);
        const d = ctx.getImageData(x0, y0, w, h).data;
        let dark = 0, glyph = 0, darkNextToGlyph = 0;
        const isGlyph = (i) => d[i] > 200 && d[i + 1] > 150 && d[i + 2] < 160 && (d[i] + d[i + 1] + d[i + 2]) > 450;
        const isDark = (i) => (d[i] + d[i + 1] + d[i + 2]) < 90;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (isGlyph(i)) glyph++;
          if (isDark(i)) { dark++;
            const n = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) return false; return isGlyph((yy * w + xx) * 4); });
            if (n) darkNextToGlyph++; }
        }
        out[key][r.name] = { glyphPixels: glyph, darkPixels: dark, darkNextToGlyph };
      }
    }
    return out;
  })()`;
  return page.evaluate(js) as Promise<Record<string, unknown>>;
}

async function compose(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2200, height: 900 } });
  const before = (n: string) => join(OUT, `before-${n}.png`);
  const ours = (n: string) => join(OUT, `ours-${n}.png`);

  // ── char select ──
  const charselRows = CHARSEL_RECTS.map(([label, dat]) => `<div class="row">
      ${cropWine(dat, `retail EoL client (Wine) — ${label}`, 3)}
      ${cropOurs(before('char-select'), dat, 'before (UI font 0x40000000, no outline)', 3)}
      ${cropOurs(ours('char-select'), dat, 'after (DAT font, p27 colour, p33 black halo)', 3)}
    </div>`).join('');
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.a — char select 0x21000004: the button labels are their DAT text elements (font p26, colour p27, p33 outline). Retail EoL client under Wine | before | after; crops at 3x.</h1>
    <div class="row">${frame(WINE_CHARSEL, 'retail EoL client (Wine, 800x600, one character selected)')}${frame(before('char-select'), 'before — capture-preworld-screens.ts on the previous build (no selection)')}${frame(ours('char-select'), 'after — a character selected (ENTER / DELETE enabled)')}</div>
    <div class="row">${frame(ours('char-select-noselect'), 'after — no selection: ENTER 0xff4c472d / DELETE 0xffa8966d (state 0xd)')}</div>
    ${charselRows}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17kbba-charselect-sidebyside.png'), fullPage: true });
  const halo = await haloMetrics(page);
  writeFileSync(join(OUT, 'core17kbba-halo-pixels.json'), JSON.stringify({ note: 'per button rect: label-coloured pixels, near-black pixels, near-black pixels 4-adjacent to a label pixel (the rim)', halo }, null, 2));
  console.log('[core17kbba] halo', JSON.stringify(halo));

  // ── chargen ──
  const pageRows = PAGES.map((p, i) => {
    const beforeFile = i === 0 ? before('char-create-race') : i === 1 ? before('char-create-step2') : i === 2 ? before('char-create-step3') : '';
    return `<div class="row">${beforeFile ? frame(beforeFile, `before — ${p}`) : `<div class="cell"><div class="lbl">before — ${p}: (the previous capture set stops at skills)</div></div>`}${frame(ours(`char-create-${p}`), `after — ${p}`)}</div>`;
  }).join('');
  const crops = `
    <h2>heritage rows 0x21000046 (template 0x2100004c:0x100002db — font 0x4000000f, label 64 px in, tan 0xffb1a177 / gold 0xffffce6c selected, outlined) — 2.5x</h2>
    <div class="row">${cropOf(REF_RACE, { x: 15, y: 50, width: 190, height: 130 }, 600, 450, 'ref char-create-race-ref1.webp (600x450, ToD-era art, same rows)', 2.5)}${cropOurs(before('char-create-race'), { x: 21, y: 70, width: 305, height: 140 }, 'before', 2.5)}${cropOurs(ours('char-create-heritage'), { x: 21, y: 70, width: 305, height: 140 }, 'after', 2.5)}</div>
    <h2>menu bar 0x2100003a — Back / Next chevron media 0x06004c8f / 0x06004c92, Help / Exit / Random (font 0x4000000b, 0xfffff287, outlined) — 2x</h2>
    <div class="row">${cropOf(REF_RACE, { x: 0, y: 405, width: 600, height: 45 }, 600, 450, 'ref (ToD-era)', 2)}</div>
    <div class="row">${cropOurs(before('char-create-race'), { x: 0, y: 540, width: 800, height: 60 }, 'before', 2)}</div>
    <div class="row">${cropOurs(ours('char-create-heritage'), { x: 0, y: 540, width: 800, height: 60 }, 'after', 2)}</div>
    <h2>profession page 0x21000047 — rows (font 0x40000010), attribute rows: name (33,8) / slider (148,0) / value (440,0), credits + vitals label/value — 2x</h2>
    <div class="row">${cropOurs(before('char-create-step2'), { x: 0, y: 55, width: 800, height: 485 }, 'before', 1.5)}${cropOurs(ours('char-create-profession'), { x: 0, y: 55, width: 800, height: 485 }, 'after', 1.5)}</div>
    <h2>summary page — the confirm button is the template string FINISH (0x21000040:0x100002c8: font 0x40000024, 0xff66ff00, outlined) — 3x</h2>
    <div class="row">${cropOurs(ours('char-create-summary'), { x: 640, y: 540, width: 160, height: 60 }, 'after', 3)}</div>
    <h2>town page 0x2100004a — heading 0x10000408 (font 0x40000014) + pin names 0x10000409 (font 0x4000000f) at the DAT slots — 1.5x</h2>
    <div class="row">${cropOurs(ours('char-create-town'), { x: 0, y: 55, width: 800, height: 485 }, 'after', 1.5)}</div>`;
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.a — chargen 0x21000038 / 0x21000046–4a: whole pages before | after, then crops.</h1>
    <div class="row">${frame(REF_RACE, 'reference char-create-race-ref1.webp (600x450; ToD-era art — layout chain identical: rows / portrait / lore / bar)', 600)}</div>
    ${pageRows}${crops}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17kbba-chargen-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbba] wrote ${join(OUT, 'core17kbba-charselect-sidebyside.png')} + core17kbba-chargen-sidebyside.png`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
