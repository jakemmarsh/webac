/**
 * CORE.17.k.b.b.a.f.b — live capture + side-by-side for the chargen
 * profession page's lit row following the character: gmCGProfessionPage::
 * UpdateAttributeValues ends with CharGenState::FitTemplateToCharacter +
 * UpdateProfession, so every slider move / value commit / skill change
 * re-lights the template the attributes AND skills fit best (Custom below
 * the 0.75 cutoff), and a profession row's ApplyTemplate sets the
 * template's skills as well as its attributes.
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character → Next → the profession page:
 * idle (Custom); Bow Hunter clicked (lit; its skills applied); Strength
 * pressed to 10 (still Bow Hunter — 0.85); Coordination to 10 (still —
 * 0.774); Quickness to 50 (Custom — 0.72: the row, the watermark and the
 * text follow); Quickness back to 100 (Bow Hunter again); Coordination
 * typed "100" + Enter (Bow Hunter, 0.85); Soldier clicked; Next → the
 * skills page: Heavy Weapons and Shield unspecialized + untrained; Back →
 * the profession page lights Custom (Soldier's primary term 4/8 → 0.03).
 * Every shot records the wizard's template_, attributes, skills, the lit
 * row, the watermark's template and the description's template.
 *
 * Composition: the retail heritage-page frame (the only EoL chargen screen
 * on file; the DAT + decompiled client are the reference for this page) |
 * before (the CORE.17.k.b.b.a.f.a close: the clicked row stays lit
 * whatever the values) | after, with row-column crops per step, the state
 * table and the whole pages.
 *
 *   npx tsx tools/capture-core17kbbafb-chargen-template-fit-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbafb');
const BEFORE = join(REPO, 'verification', 'core17kbbafa', 'ours-profession-bowhunter-str-tab-90.png');
const BEFORE_IDLE = join(REPO, 'verification', 'core17kbbafa', 'ours-profession-idle.png');
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
const VALUE_X = 440; const VALUE_W = 40;
/** The profession rows' column: (17,45) 220x54 at a 35 px pitch, seven rows. */
const PROF_X = 17; const PROF_Y0 = 45; const PROF_PITCH = 35; const PROF_W = 220; const PROF_H = 54;

interface Rect { x: number; y: number; width: number; height: number }
interface ShotState {
  step: number; template: number; profession: string | null; lit: string[]; artTemplate: string | null; artShown: boolean;
  descTemplate: string | null; attributes: Record<string, number>; remaining: number; skills: Array<[number, number]>; skillCreditsRemaining: number;
  litRowState: string | null;
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
  const lit = Array.from(document.querySelectorAll('.template-btn[data-ac-state="10000017"]')).map((b) => b.dataset.profession);
  const art = document.querySelector('[data-element-id="0x100003d8"]');
  const desc = document.querySelector('.profession-description');
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    template: w ? w.templateIndex : -1,
    profession: lit.length ? lit[0] : null, lit,
    artTemplate: art ? (art.style.backgroundImage ? art.style.backgroundImage.slice(0, 40) : 'none') : null, artShown: !!(art && art.style.backgroundImage && art.style.display !== 'none'),
    descTemplate: desc ? (desc.dataset.template ?? null) : null,
    attributes: w ? Object.assign({}, w.attributes) : {}, remaining: w ? w.attributesRemaining : -1,
    skills: w ? Array.from(w.skills.entries()) : [], skillCreditsRemaining: w ? w.skillCreditsRemaining : -1,
    litRowState: (document.querySelector('.template-btn[data-ac-state="10000017"] [data-ac-state]') || {}).dataset ? (document.querySelector('.template-btn[data-ac-state="10000017"] [data-ac-state]') || { dataset: {} }).dataset.acState : null,
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbafb] still waiting — reloading');
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
/** The track x whose PointToPosition gives `value` (the widget centred there). */
function sliderPoint(attr: string, value: number): [number, number] {
  const x = ROW_X + SLIDER_X + Math.trunc(WIDGET_W / 2) + Math.round(value * 0.01 * (ACTIVE - 1));
  return screen(x, ROW_Y0 + rowIndex[attr] * ROW_PITCH + ROW_H / 2);
}
function valuePoint(attr: string): [number, number] {
  return screen(ROW_X + VALUE_X + VALUE_W - 8, ROW_Y0 + rowIndex[attr] * ROW_PITCH + ROW_H / 2);
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
    console.log(`[core17kbbafb] ${file}: step ${st.step}, template ${st.template} lit=${JSON.stringify(st.lit)} art=${st.artTemplate}/${st.artShown ? 'shown' : 'hidden'} desc=${st.descTemplate}, str ${a.strength} end ${a.endurance} coord ${a.coordination} quick ${a.quickness} focus ${a.focus} self ${a.self}, remaining ${st.remaining}, skills ${JSON.stringify(st.skills)} (credits ${st.skillCreditsRemaining})`);
    return st;
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const parkMouse = async (): Promise<void> => { await page.mouse.move(OFF_X + 400 * SCALE, OFF_Y + 590 * SCALE, { steps: 2 }); await page.waitForTimeout(300); };
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
  /** A real press on `attr`'s slider track at the x for `value` (p124 move-to-touched), then release. */
  const pressSlider = async (attr: string, value: number): Promise<void> => {
    const [x, y] = sliderPoint(attr, value);
    await page.mouse.move(x, y - 4, { steps: 3 });
    await page.mouse.down();
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(900);
    await parkMouse();
  };
  const clickValue = async (attr: string): Promise<void> => {
    const [x, y] = valuePoint(attr);
    await page.mouse.move(x - 3, y + 1, { steps: 3 });
    await page.mouse.click(x, y);
    await page.waitForTimeout(500);
  };

  console.log('[core17kbbafb] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=kbbafb`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickSel('#btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(2000);
  await stepTo('#btn-next');

  await shoot('profession-idle');

  // Bow Hunter: SetTemplate(1) → ApplyTemplate (40/30/100/100/50/10 + the skills) → the fit lights Bow Hunter.
  await clickSel('.template-btn[data-profession="Bow Hunter"]');
  await page.waitForTimeout(1200);
  await shoot('bowhunter-clicked');

  // Strength to 10: min-sum 300/330 → attr term 0.184 + skills 0.667 = 0.85 → still Bow Hunter.
  await pressSlider('strength', 10);
  await shoot('bowhunter-str-10');

  // Coordination to 10: 210/330 → 0.108 + 0.667 = 0.774 → still Bow Hunter (just).
  await pressSlider('coordination', 10);
  await shoot('bowhunter-coord-10');

  // Quickness to 50: 160/330 → 0.055 + 0.667 = 0.722 < 0.75 → Custom: row, watermark, text.
  await pressSlider('quickness', 50);
  await shoot('custom-quick-50');

  // Quickness back to 100: 210/330 → Bow Hunter again.
  await pressSlider('quickness', 100);
  await shoot('bowhunter-quick-100');

  // Coordination typed "100" + Enter: the value box commit runs UpdateAttributeValues too → 300/330 → Bow Hunter.
  await clickValue('coordination');
  await page.keyboard.type('100', { delay: 60 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  await parkMouse();
  await shoot('bowhunter-coord-typed-100');

  // Soldier: its template + skills → Soldier lit.
  await clickSel('.template-btn[data-profession="Soldier"]');
  await page.waitForTimeout(1200);
  await shoot('soldier-clicked');

  // The skills page: Heavy Weapons (44) and Shield (48) — Soldier primaries — unspecialized + untrained
  // through the rows' down arrows (.skill-arrow[data-skill][data-action]).
  await stepTo('#btn-next');
  await shoot('soldier-skills-page');
  const dropSkill = async (id: number, name: string): Promise<void> => {
    for (const action of ['unspecialize', 'untrain']) {
      const ok = await clickSel(`.skill-arrow[data-skill="${id}"][data-action="${action}"]`);
      console.log(`[core17kbbafb] ${action} ${name} (${id}): ${ok}`);
      await page.waitForTimeout(700);
    }
  };
  await dropSkill(44, 'Heavy Weapons');
  await dropSkill(48, 'Shield');
  await shoot('soldier-skills-dropped');

  // Back to the profession page: Update runs the fit — Soldier's primary term (4/8)^3.5 → 0.03; total 0.696 → Custom.
  await stepTo('#btn-back');
  await shoot('custom-after-skills-dropped');

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
  /** The seven profession rows + the description panel below them. */
  const profRect: Rect = { x: PROF_X - 4, y: PROF_Y0 - 4, width: PROF_W + 8 + 40, height: PROF_PITCH * 6 + PROF_H + 8 + (485 - (PROF_Y0 + PROF_PITCH * 6 + PROF_H)) };
  const rowsRect: Rect = { x: ROW_X - 6, y: ROW_Y0 - 6, width: ROW_W + 12, height: ROW_PITCH * 5 + ROW_H + 12 };
  const profCrop = (name: string, label: string, zoom = 1.6): string => cropOurs(ours(name), profRect, label, zoom);
  const rowsCrop = (name: string, label: string, zoom = 1.3): string => cropOurs(ours(name), rowsRect, label, zoom);
  const table = (): string => {
    const names = Object.keys(live.screens);
    if (!names.length) return '';
    const head = `<tr><th>shot</th><th>template_</th><th>lit row</th><th>art</th><th>text</th><th>str</th><th>end</th><th>coord</th><th>quick</th><th>focus</th><th>self</th><th>remaining</th><th>skills (id:level)</th><th>skill credits</th></tr>`;
    const rows = names.map((n) => { const s = live.screens[n].state; const a = s.attributes; return `<tr><td style="text-align:left">${n}</td><td>${s.template}</td><td style="text-align:left">${s.lit.join(', ') || '—'}</td><td>${s.artTemplate ?? '—'}${s.artShown ? '' : ' (none)'}</td><td>${s.descTemplate ?? '—'}</td><td>${a.strength}</td><td>${a.endurance}</td><td>${a.coordination}</td><td>${a.quickness}</td><td>${a.focus}</td><td>${a.self}</td><td>${s.remaining}</td><td style="text-align:left">${s.skills.map(([id, l]) => `${id}:${l}`).join(' ') || '—'}</td><td>${s.skillCreditsRemaining}</td></tr>`; }).join('');
    return `<table>${head}${rows}</table>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.f.b — the profession page's lit row follows the character: gmCGProfessionPage::UpdateAttributeValues ends with CharGenState::FitTemplateToCharacter (attributes pow(Σmin/Σtemplate, 2.5)/3 + normal skills pow(trained/list, 3)/3 + primary skills pow((trained + 2·specialized)/(2·list), 3.5)/3; Custom below 0.75) + UpdateProfession (the row, the 0x100003d8 watermark, the 0x100003e0 text). A profession row's ApplyTemplate sets the template's skills too. Retail (the EoL heritage page — no EoL profession-page screenshot is on file; the DAT + decompiled client are the reference) | before (CORE.17.k.b.b.a.f.a close: the clicked row stays lit whatever the values) | after.</h1>
    <div class="row">${frame(RETAIL_HERITAGE, 'retail — EoL chargen (heritage page, char-create-ref1.png): the chrome family', 600)}${frame(BEFORE, 'before — Bow Hunter after Strength 90 / a drain: the clicked row stays lit (nothing re-derives it)', 700)}${frame(ours('custom-quick-50'), 'after — Bow Hunter with Str 10 / Coord 10 / Quick 50: the fit falls to 0.72 → Custom lit, the watermark gone, the Custom text', 700)}</div>
    <h2>the profession column per step — idle | Bow Hunter clicked | Strength 10 (0.85, still lit) | Coordination 10 (0.774, still lit) | Quickness 50 (0.72 → Custom) | Quickness 100 (Bow Hunter again)</h2>
    <div class="row">${profCrop('profession-idle', 'idle — Custom')}${profCrop('bowhunter-clicked', 'Bow Hunter clicked')}${profCrop('bowhunter-str-10', 'Strength → 10')}${profCrop('bowhunter-coord-10', 'Coordination → 10')}${profCrop('custom-quick-50', 'Quickness → 50: Custom')}${profCrop('bowhunter-quick-100', 'Quickness → 100: Bow Hunter')}</div>
    <h2>the attribute rows at the same steps</h2>
    <div class="row">${rowsCrop('bowhunter-clicked', 'Bow Hunter: 40/30/100/100/50/10')}${rowsCrop('bowhunter-coord-10', 'Str 10, Coord 10')}${rowsCrop('custom-quick-50', 'Quick 50 — Custom lit')}${rowsCrop('bowhunter-coord-typed-100', 'Coordination typed 100 + Enter — Bow Hunter')}</div>
    <h2>Soldier clicked → the skills page (Heavy Weapons + Shield dropped) → Back: the fit runs on the page's Update and lights Custom (Soldier's primary term (4/8)^3.5 → 0.03; total 0.696)</h2>
    <div class="row">${profCrop('soldier-clicked', 'Soldier clicked')}${frame(ours('soldier-skills-page'), 'the skills page after Soldier (its skills applied)', 520)}${frame(ours('soldier-skills-dropped'), 'Heavy Weapons + Shield dropped', 520)}${profCrop('custom-after-skills-dropped', 'Back — Custom lit')}</div>
    <h2>the wizard state per shot (live-state.json)</h2>
    ${table()}
    <h2>whole pages — before (idle) | after: idle, Bow Hunter, Custom (Quick 50), Soldier, Custom (skills dropped)</h2>
    <div class="row">${frame(BEFORE_IDLE, 'before — idle', 560)}${frame(ours('profession-idle'), 'after — idle', 560)}${frame(ours('bowhunter-clicked'), 'Bow Hunter', 560)}${frame(ours('custom-quick-50'), 'Custom (Quick 50)', 560)}</div>
    <div class="row">${frame(ours('soldier-clicked'), 'Soldier', 560)}${frame(ours('custom-after-skills-dropped'), 'Custom (skills dropped)', 560)}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbafb-template-fit-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbafb] wrote ${join(OUT, 'core17kbbafb-template-fit-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
