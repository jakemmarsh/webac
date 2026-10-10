/**
 * CORE.17.k.b.b.a.d — live capture + side-by-side for the chargen pages'
 * hover tooltips (layout 0x21000041, UIElementManager::CheckTooltip →
 * UIElement::StartTooltipAtMouse): the p73 help strings the DAT hangs on the
 * heritage rows, the profession rows, the attribute names / credits /
 * vitals, the skill credits / section headers / arrows, the appearance
 * gender plates / mode + category rows / colour spots / shade disk and the
 * summary name field.
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character; on each page the real mouse
 * rests on an element for > the 0.25 s Misc.TooltipDelay default and the
 * page is shot with the tooltip up; the heritage page also shows the
 * tooltip following the mouse to another row and expiring after the 10 s
 * m_tooltipDuration. Composition: before (the CORE.17.k.b.b.a.b /
 * CORE.17.k.b.b.a.c close captures — no tooltip surface at all) | after,
 * crops of every tooltip at 2x, and the one retail tooltip on file
 * (reference/images/hud/item-stack-tooltip.jpg — the in-game item tooltip,
 * the same 0x21000041 chrome family) for the chrome. No retail chargen
 * tooltip screenshot is on file; the DAT + decompiled client are the
 * reference.
 *
 *   npx tsx tools/capture-core17kbbad-chargen-tooltips-sidebyside.ts [--compose-only] [--quick]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbad');
const BEFORE = {
  heritage: join(REPO, 'verification', 'core17kbbab', 'ours-char-create-heritage.png'),
  profession: join(REPO, 'verification', 'core17kbbab', 'ours-char-create-profession.png'),
  skills: join(REPO, 'verification', 'core17kbbab', 'ours-char-create-skills.png'),
  appearance: join(REPO, 'verification', 'core17kbbab', 'ours-char-create-appearance.png'),
  summary: join(REPO, 'verification', 'core17kbbac', 'ours-char-create-summary.png'),
};
const RETAIL_ITEM_TOOLTIP = join(REPO, 'reference', 'images', 'hud', 'item-stack-tooltip.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;
const QUICK = process.argv.includes('--quick');

interface Rect { x: number; y: number; width: number; height: number }
interface TipState { text: string; for: string; root: string; rect: number[]; pieces: string[]; fill: string; font: string | undefined; textRect: number[]; canvas: number[] | null }
interface ShotState { step: number; tooltip: TipState | null; hovered: string | null; tooltipElements: number; titles: number }

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const STATE_JS = `(() => {
  const px = (s) => parseFloat(s) || 0;
  const tip = document.querySelector('.ac-dat-tooltip');
  const text = tip && tip.querySelector('.ac-dat-tooltip-text');
  const run = text && text.firstElementChild;
  const ui = window.__ac && window.__ac.gameUI;
  const hov = ui && ui.chargenTooltipHover;
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    tooltip: tip ? {
      text: tip.dataset.acText, for: tip.dataset.acTooltipFor, root: tip.dataset.element,
      rect: [px(tip.style.left), px(tip.style.top), px(tip.style.width), px(tip.style.height)],
      pieces: Array.from(tip.querySelectorAll('[data-frame-piece]')).map((p) => p.dataset.framePiece + ':' + p.dataset.tex),
      fill: tip.dataset.tex, font: run ? run.dataset.acFont : undefined,
      textRect: text ? [px(text.style.left), px(text.style.top), px(text.style.width), px(text.style.height)] : [],
      canvas: run && run.tagName === 'CANVAS' ? [run.width, run.height] : null,
    } : null,
    hovered: hov && hov.entered ? (hov.entered.dataset.acTooltip || null) : null,
    tooltipElements: document.querySelectorAll('[data-ac-tooltip]').length,
    titles: document.querySelectorAll('#chargen-root [title]').length,
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbad] still waiting — reloading');
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
  const state: Record<string, unknown> = { capturedAt: new Date().toISOString(), viewport: VIEW, scale: SCALE, screens: {} };
  const screens = state.screens as Record<string, { file: string; state: ShotState }>;
  const shoot = async (name: string): Promise<ShotState> => {
    const file = `ours-${name}.png`;
    // Headless SwiftShader occasionally stalls frame production for 25–50 s
    // while a hover tooltip is up (the JS path measures < 10 ms; idle frames
    // < 40 ms) — give the capture the time rather than lose the screen.
    await page.screenshot({ path: join(OUT, file), timeout: 150_000 });
    const st = await page.evaluate(STATE_JS) as ShotState;
    screens[name] = { file, state: st };
    console.log(`[core17kbbad] ${file}: step ${st.step}, ${st.tooltipElements} tooltip elements, tip ${st.tooltip ? `"${st.tooltip.text.slice(0, 50)}…" @ ${st.tooltip.rect.join(',')}` : 'none'}`);
    return st;
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const clickById = (id: string): Promise<boolean> => clickSel(`#${id}`);
  const currentStep = async (): Promise<number> => page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as Promise<number>;
  /** Rest the real mouse on the centre of `sel` (the tooltip needs > 0.25 s without movement). */
  const hover = async (sel: string, settleMs = 700): Promise<boolean> => {
    const c = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`) as [number, number] | null;
    if (!c) { console.log(`[core17kbbad] no element for ${sel}`); return false; }
    await page.mouse.move(c[0] - 6, c[1] + 3, { steps: 4 });
    await page.mouse.move(c[0], c[1], { steps: 3 });
    await page.waitForTimeout(settleMs);
    return true;
  };
  const next = async (): Promise<void> => {
    const before = await currentStep();
    // The mouse off every tooltip element first (retail: StopHover on leaving).
    await page.mouse.move(OFF_X + 400 * SCALE, OFF_Y + 590 * SCALE);
    await page.waitForTimeout(300);
    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      clicked = await clickById('btn-next').catch(() => false);
      if (!clicked) await page.waitForTimeout(1000);
    }
    if (!clicked) await page.evaluate(`(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.wizard) { ui.wizard.nextStep(); ui.renderCharacterCreate(); } })()`).catch(() => {});
    const advanced = await page.waitForFunction((prev) =>
      parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev, before, { timeout: 15_000 })
      .then(() => true).catch(() => false);
    if (!advanced) throw new Error(`wizard did not advance past step ${before}`);
    await page.waitForTimeout(1500);
  };

  console.log('[core17kbbad] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=kbbad`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickById('btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(2000);

  // Heritage page: the Aluvian row, then the mouse crossing to Sho (the
  // tooltip follows), then the 10 s duration expiry, then the mouse off.
  await shoot('heritage-idle');
  await hover('.heritage-btn[data-heritage="1"]');
  await shoot('heritage-aluvian-tooltip');
  await hover('.heritage-btn[data-heritage="3"]');
  await shoot('heritage-sho-tooltip');
  if (!QUICK) {
    await page.waitForTimeout(10_500);
    await shoot('heritage-sho-expired');
  }
  await page.mouse.move(OFF_X + 400 * SCALE, OFF_Y + 300 * SCALE, { steps: 3 });
  await page.waitForTimeout(400);
  await shoot('heritage-mouse-off');
  // Headless SwiftShader stalls frame production for 25–50 s once a tooltip
  // overlaps the profession watermark art (the hover machine measures intact:
  // show < 10 ms, the tooltip is up before the screenshot starts) — long
  // enough for retail's 10 s m_tooltipDuration to expire mid-screenshot. The
  // expiry itself is demonstrated above; from here the duration is parked so
  // the later pages capture with their tooltip up.
  await page.evaluate(`window.__ac.gameUI.tooltipDurationSeconds = 600`);

  await next();
  await hover('.template-btn[data-profession="Bow Hunter"]');
  await shoot('profession-bowhunter-tooltip');
  await hover('[data-ac-tooltip="106505496"]');
  await shoot('profession-strength-tooltip');
  await hover('[data-ac-tooltip="18811971"]');
  await shoot('profession-credits-tooltip');
  await hover('[data-ac-tooltip="217493704"]');
  await shoot('profession-health-tooltip');

  await next();
  await hover('[data-ac-tooltip="95740915"]');
  await shoot('skills-credits-tooltip');
  // A fresh Custom character trains nothing: the Useable Untrained section is the one on screen.
  await hover('.chargen-skill-section[data-section="useableUntrained"]');
  await shoot('skills-useable-header-tooltip');
  await hover('.skill-arrow[data-action="train"]');
  await shoot('skills-up-arrow-tooltip');

  await next();
  await hover('.gender-btn[data-gender="2"]');
  await shoot('appearance-female-tooltip');
  await hover('.appear-cat-btn[data-cat="eyes"]');
  await shoot('appearance-eyes-row-tooltip');
  await hover('.appear-spot');
  await shoot('appearance-spot-tooltip');
  await hover('.appear-mode-btn[data-mode="clothes"]');
  await shoot('appearance-clothes-tooltip');

  await next();
  await next();
  await hover('#char-name-input');
  await shoot('summary-name-tooltip');

  await clickById('btn-cancel');
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
  const live = existsSync(join(OUT, 'live-state.json'))
    ? JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) as { screens: Record<string, { file: string; state: ShotState }> }
    : { screens: {} };
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2300, height: 900 } });
  const ours = (n: string) => join(OUT, `ours-${n}.png`);
  /** The tooltip's layout rect (800x600 px; the pages sit 55 px under the tab bar → the frame is the whole screen, so no offset) padded by 40 px. */
  const tipCrop = (name: string, pad = 40): Rect | null => {
    const st = live.screens[name]?.state;
    if (!st?.tooltip) return null;
    const [x, y, w, h] = st.tooltip.rect;
    return { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: w + 2 * pad, height: h + 2 * pad };
  };
  const tipCell = (name: string, label: string, zoom = 2): string => {
    const r = tipCrop(name);
    return r ? cropOurs(ours(name), r, label, zoom) : `<div class="cell"><div class="lbl">${label}: (no tooltip captured)</div></div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.d — chargen hover tooltips: layout 0x21000041 root 0x10000487 (fill 0x06004cc2, 1-px edges 0x06004cc8, text child 0x10000396 in font 0x40000002 white, margins 2, wrapped at MaxWidth 256) shown by UIElementManager::CheckTooltip after the 0.25 s Misc.TooltipDelay at mouse + 32, gone after the 10 s m_tooltipDuration or on leaving the element. Before (CORE.17.k.b.b.a.b / .c close captures — no tooltip surface) | after. No retail chargen tooltip screenshot is on file; the DAT + decompiled client are the reference, and the in-game item tooltip on file shows the chrome family.</h1>
    <div class="row">${frame(BEFORE.heritage, 'before — heritage page (the p73 strings had no surface)')}${frame(ours('heritage-aluvian-tooltip'), 'after — the mouse resting on the Aluvian row 0x100003bf: its p73 245875454')}</div>
    <div class="row">${frame(ours('heritage-sho-tooltip'), 'after — the mouse crossed to the Sho row 0x100003c2: the Aluvian tooltip went (SwitchMouseOver → StopHover), Sho\'s came after the delay')}${frame(ours('heritage-sho-expired'), 'after — 10.5 s later, the mouse still on Sho: m_tooltipDuration expired, nothing shown')}</div>
    <h2>the tooltip at 2x — heritage rows | the retail item tooltip on file (reference/images/hud/item-stack-tooltip.jpg, 3x) for the chrome</h2>
    <div class="row">${tipCell('heritage-aluvian-tooltip', 'Aluvian (0x100003bf p73)')}${tipCell('heritage-sho-tooltip', 'Sho (0x100003c2 p73)')}${existsSync(RETAIL_ITEM_TOOLTIP) ? `<div class="cell"><div class="lbl">retail — in-game item tooltip (same 0x21000041 chrome family)</div><img src="${dataUrl(RETAIL_ITEM_TOOLTIP)}" style="width:${140 * 3}px;image-rendering:pixelated;border:1px solid #444"/></div>` : ''}</div>
    <h2>profession page 0x21000047 — the row 0x100003da, the attribute name 0x100002ed (106505496 Strength), Attribute Credits 0x100003e2, Health 0x100003e3 — 2x</h2>
    <div class="row">${tipCell('profession-bowhunter-tooltip', 'Bow Hunter row')}${tipCell('profession-strength-tooltip', 'Strength name')}${tipCell('profession-credits-tooltip', 'Attribute Credits')}${tipCell('profession-health-tooltip', 'Health')}</div>
    <div class="row">${frame(BEFORE.profession, 'before — profession page')}${frame(ours('profession-strength-tooltip'), 'after — the Strength name\'s tooltip (the string CORE.17.k.b.b.a.b moved out of the profession text box)')}</div>
    <h2>skills page 0x21000048 — Available Skill Credits 0x100003f9, the Useable Untrained Skills header (gmCGSkillsPage::SetTooltip ID_CharGen_UseableUntrained_Tooltip), the up arrow 0x10000304 — 2x</h2>
    <div class="row">${tipCell('skills-credits-tooltip', 'skill credits')}${tipCell('skills-useable-header-tooltip', 'Useable Untrained Skills header')}${tipCell('skills-up-arrow-tooltip', 'up arrow')}</div>
    <div class="row">${frame(BEFORE.skills, 'before — skills page')}${frame(ours('skills-useable-header-tooltip'), 'after — the section header tooltip')}</div>
    <h2>appearance page 0x21000049 — the female plate 0x100003a7, the Eyes row 0x100003b0, a colour spot (0x1000030f…), the Clothes button 0x100003aa — 2x</h2>
    <div class="row">${tipCell('appearance-female-tooltip', 'female plate')}${tipCell('appearance-eyes-row-tooltip', 'Eyes row')}${tipCell('appearance-spot-tooltip', 'colour spot')}${tipCell('appearance-clothes-tooltip', 'Clothes')}</div>
    <div class="row">${frame(BEFORE.appearance, 'before — appearance page (the spots carried a browser title=)')}${frame(ours('appearance-spot-tooltip'), 'after — a colour spot\'s DAT tooltip')}</div>
    <h2>summary page 0x2100004b — the name field 0x10000402 (42102661) — 2x, and the whole page</h2>
    <div class="row">${tipCell('summary-name-tooltip', 'name field')}${frame(BEFORE.summary, 'before — summary page')}${frame(ours('summary-name-tooltip'), 'after — the name field\'s tooltip')}</div>
    <h2>nothing shown: the mouse off every tooltip element (the portrait)</h2>
    <div class="row">${frame(ours('heritage-mouse-off'), 'mouse on the portrait — none', 500)}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbad-tooltips-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbad] wrote ${join(OUT, 'core17kbbad-tooltips-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
