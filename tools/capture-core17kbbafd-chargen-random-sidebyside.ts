/**
 * CORE.17.k.b.b.a.f.d — live capture + side-by-side for the chargen Random
 * button 0x100003cb as gmCharGenMainUI::DoRandom @ 004e7d70 dispatches it
 * PER PAGE: heritage → CharGenState::RandomizeHeritageGroup (RollDice(1, 4)
 * with Throne of Destiny, via SetHeritageGroup — which also rolls the
 * heritage's primary start area); profession → RandomizeTemplate (a
 * template other than the current one, then ApplyTemplate) +
 * UpdateToDefaultAttributes; skills → RandomizeSkills; appearance →
 * RandomizeAppearance(0) in Face mode / RandomizeClothing(1) in Clothes
 * mode; town → RandInt(4) → SetStartArea; summary → the
 * ID_CharGen_RandomizeWarning Yes / No dialog, Yes → RandomizeCharacter
 * (Reset + every roll). The gender is rolled ONLY by the summary's
 * RandomizeCharacter.
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character; on every page: idle, Random,
 * Random again (the appearance page: Random in Face mode, then Clothes mode
 * and Random); the summary: a name typed, Random (the warning dialog), No,
 * Random, Yes. Every shot records the wizard's state.
 *
 * `--before` captures the same beats against the pre-fix code (the caller
 * checks the old code out first) into ours-before-*.png. `--compose-only`
 * rebuilds the sheet from the frames on disk.
 *
 *   npx tsx tools/capture-core17kbbafd-chargen-random-sidebyside.ts [--before] [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbafd');
const RETAIL = join(REPO, 'reference', 'images', 'preworld');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

interface ShotState {
  step: number; heritage: number; gender: number; name: string; templateIndex: number; startArea: number;
  attributes: Record<string, number>; remaining: number; locks: Record<string, boolean>;
  skills: Record<string, number>; skillCreditsRemaining: number;
  appearance: Record<string, number>; appearMode: string; dialog: string | null; litRow: string | null; litHeritage: string | null;
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
  const skills = {};
  if (w) for (const [k, v] of w.skills) skills[k] = v;
  const lit = document.querySelector('.template-btn[data-ac-state="10000017"]');
  const litH = document.querySelector('.heritage-btn[data-ac-state="10000017"]');
  const dlg = document.querySelector('.ac-dialog-text');
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    heritage: w ? w.heritage : -1, gender: w ? w.gender : -1, name: w ? w.name : '',
    templateIndex: w ? w.templateIndex : -1, startArea: w ? w.startArea : -1,
    attributes: w ? Object.assign({}, w.attributes) : {}, remaining: w ? w.attributesRemaining : -1,
    locks: w ? Object.assign({}, w.attributeLocks) : {},
    skills, skillCreditsRemaining: w ? w.skillCreditsRemaining : -1,
    appearance: w ? Object.assign({}, w.appearance) : {}, appearMode: ui ? ui.appearMode : '',
    dialog: dlg ? (dlg.textContent || '').trim() : null,
    litRow: lit ? (lit.dataset.profession || lit.dataset.template || null) : null,
    litHeritage: litH ? (litH.dataset.heritage || null) : null,
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbafd] still waiting — reloading');
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
  const state: Record<string, unknown> = { capturedAt: new Date().toISOString(), before: BEFORE, viewport: VIEW, screens: {} };
  const screens = state.screens as Record<string, { file: string; state: ShotState }>;
  const shoot = async (name: string): Promise<ShotState> => {
    const file = `${PREFIX}${name}.png`;
    await page.screenshot({ path: join(OUT, file), timeout: 150_000 });
    const st = await page.evaluate(STATE_JS) as ShotState;
    screens[name] = { file, state: st };
    const a = st.attributes;
    console.log(`[core17kbbafd] ${file}: step ${st.step}, heritage ${st.heritage} (lit ${st.litHeritage}) gender ${st.gender} template ${st.templateIndex} (lit ${st.litRow}) town ${st.startArea} name "${st.name}" attrs ${a.strength}/${a.endurance}/${a.coordination}/${a.quickness}/${a.focus}/${a.self} rem ${st.remaining} skills ${JSON.stringify(st.skills)} credits ${st.skillCreditsRemaining} mode ${st.appearMode} dialog ${st.dialog === null ? 'none' : JSON.stringify(st.dialog)} appearance ${JSON.stringify(st.appearance)}`);
    return st;
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const stepTo = async (btn: string): Promise<void> => {
    const before = await page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as number;
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
  const random = async (): Promise<void> => { await clickSel('#btn-random'); await page.waitForTimeout(1500); };
  // The dialog's buttons are drawn in the DAT font (no text content): Yes is the first (x=80), No the second (x=240).
  const dialogButton = async (label: 'Yes' | 'No'): Promise<boolean> => page.evaluate(`(() => {
    const b = document.querySelectorAll('.ac-dialog-button')[${label === 'Yes' ? 0 : 1}];
    if (!b) return false; b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;

  console.log(`[core17kbbafd] navigating (autoenter=false)${BEFORE ? ' — BEFORE capture' : ''}`);
  await page.goto(`${BASE}&autoenter=false&cb=kbbafd${BEFORE ? 'b' : ''}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickSel('#btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(2000);

  // Heritage page: idle, Random, Random.
  await shoot('heritage-idle');
  await random(); await shoot('heritage-random-1');
  await random(); await shoot('heritage-random-2');

  // Profession page: idle (the heritage's template in force), Random, Random (never the same template twice).
  await stepTo('#btn-next');
  await shoot('profession-idle');
  await random(); await shoot('profession-random-1');
  await random(); await shoot('profession-random-2');

  // Skills page: idle (the template's skills), Random, Random.
  await stepTo('#btn-next');
  await shoot('skills-idle');
  await random(); await shoot('skills-random-1');
  await random(); await shoot('skills-random-2');

  // Appearance page: idle, Random in Face mode, Clothes mode, Random.
  await stepTo('#btn-next');
  await shoot('appearance-idle');
  await random(); await shoot('appearance-face-random');
  await clickSel('.appear-mode-btn[data-mode="clothes"]'); await page.waitForTimeout(1200);
  await shoot('appearance-clothes-idle');
  await random(); await shoot('appearance-clothes-random');

  // Town page: idle (the heritage's primary start area), Random, Random.
  await stepTo('#btn-next');
  await shoot('town-idle');
  await random(); await shoot('town-random-1');
  await random(); await shoot('town-random-2');

  // Summary page: a name typed, Random → the warning dialog; No; Random; Yes.
  await stepTo('#btn-next');
  await page.evaluate(`(() => { const i = document.getElementById('char-name-input'); if (i) { i.focus(); i.value = ''; } })()`);
  await page.keyboard.type('Randomtest', { delay: 30 });
  await page.evaluate(`(() => { const i = document.getElementById('char-name-input'); if (i) i.blur(); })()`);
  await page.waitForTimeout(800);
  await shoot('summary-idle');
  await random(); await shoot('summary-random-dialog');
  await dialogButton('No'); await page.waitForTimeout(800);
  await shoot('summary-after-no');
  await random(); await page.waitForTimeout(300);
  await dialogButton('Yes'); await page.waitForTimeout(2500);
  await shoot('summary-after-yes');

  await clickSel('#btn-cancel');
  await page.waitForTimeout(500);
  writeFileSync(join(OUT, BEFORE ? 'live-state-before.json' : 'live-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.webp') ? 'webp' : file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function frame(file: string, label: string, width = 520): string {
  return existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${width}px;border:1px solid #444"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:520px}
  h1{font-size:14px;margin:0 0 8px}
  h2{font-size:13px;margin:14px 0 0;color:#9cf}
  table{border-collapse:collapse;margin-top:8px} td,th{border:1px solid #444;padding:2px 6px;text-align:left;vertical-align:top;max-width:420px;word-break:break-all} th{color:#9cf}
</style>`;

async function compose(): Promise<void> {
  const load = (f: string) => existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), 'utf8')) as { screens: Record<string, { file: string; state: ShotState }> } : { screens: {} };
  const live = load('live-state.json');
  const before = load('live-state-before.json');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2300, height: 900 } });
  const ours = (n: string) => join(OUT, `ours-${n}.png`);
  const ourBefore = (n: string) => join(OUT, `ours-before-${n}.png`);
  const table = (src: { screens: Record<string, { file: string; state: ShotState }> }, title: string): string => {
    const names = Object.keys(src.screens);
    if (!names.length) return '';
    const head = `<tr><th>shot</th><th>heritage / gender</th><th>template (lit)</th><th>town</th><th>attributes (rem)</th><th>skills (credits left)</th><th>appearance</th><th>name / dialog</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state; const a = s.attributes; const ap = s.appearance;
      const skills = Object.entries(s.skills).map(([k, v]) => `${k}:${v}`).join(' ');
      const app = `hair ${ap.hairStyle}/${ap.hairColor} hue ${Number(ap.hairHue).toFixed(2)} eyes ${ap.eyesStrip}/${ap.eyeColor} nose ${ap.noseStyle} mouth ${ap.mouthStyle} skin ${Number(ap.skinHue).toFixed(2)} | head ${ap.headgearStyle}/${ap.headgearColor} shirt ${ap.shirtStyle}/${ap.shirtColor} pants ${ap.pantsStyle}/${ap.pantsColor} foot ${ap.footwearStyle}/${ap.footwearColor}`;
      return `<tr><td>${n}</td><td>${s.heritage} (lit ${s.litHeritage}) / ${s.gender}</td><td>${s.templateIndex} (${s.litRow})</td><td>${s.startArea}</td><td>${a.strength}/${a.endurance}/${a.coordination}/${a.quickness}/${a.focus}/${a.self} (${s.remaining})</td><td>${skills} (${s.skillCreditsRemaining})</td><td>${app}</td><td>"${s.name}" ${s.appearMode} ${s.dialog === null ? '' : `dialog: ${s.dialog}`}</td></tr>`;
    }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  const pageRow = (title: string, retail: string | null, retailLabel: string, beats: Array<[string, string]>): string => {
    const cells = [retail ? frame(join(RETAIL, retail), retailLabel, 440) : ''];
    for (const [n, label] of beats) cells.push(frame(ourBefore(n), `before — ${label}`, 440), frame(ours(n), `after — ${label}`, 440));
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.f.d — the chargen Random button 0x100003cb per page (gmCharGenMainUI::DoRandom @ 004e7d70 switching on m_eProgressState): heritage → RandomizeHeritageGroup (RollDice(1, 4); SetHeritageGroup also rolls the heritage's primary start area) + the heritage page's Update; profession → RandomizeTemplate (RandInt(templates − 1, template_ − 1) + 1: never the current template; ApplyTemplate) + UpdateToDefaultAttributes; skills → RandomizeSkills + the skills page's Update; appearance → RandomizeAppearance(0) in Face mode / RandomizeClothing(1) in Clothes mode + the page's Update (the camera back on the face); town → RandInt(4) → SetStartArea; summary → MakeRandomizeWarningDialog (ID_CharGen_RandomizeWarning, Yes / No), Yes → RandomizeCharacter (Reset; heritage, gender, appearance, clothing, template, start area; the name cleared). Before: every page rolled the gender and every appearance value. Retail (the EoL chargen references on file) | before | after.</h1>
    ${pageRow('heritage page — idle | Random | Random (a heritage in 1..4; the gender untouched)', 'char-create-ref1.png', 'retail — EoL heritage page (char-create-ref1.png)', [['heritage-idle', 'idle'], ['heritage-random-1', 'Random'], ['heritage-random-2', 'Random again']])}
    ${pageRow('profession page — idle | Random | Random (a different template each time; its attributes and skills applied; the row lit by the fit)', 'char-create-step2-ref1.webp', 'retail — EoL profession page (char-create-step2-ref1.webp)', [['profession-idle', 'idle'], ['profession-random-1', 'Random'], ['profession-random-2', 'Random again']])}
    ${pageRow('skills page — idle | Random | Random (RandomizeSkills: the credits spent on random skills)', 'char-create-step3-ref1.webp', 'retail — EoL skills page (char-create-step3-ref1.webp)', [['skills-idle', 'idle'], ['skills-random-1', 'Random'], ['skills-random-2', 'Random again']])}
    ${pageRow('appearance page — idle | Random in Face mode (the face rolled, the clothes and the gender untouched) | Clothes mode | Random in Clothes mode (the clothes rolled, the face untouched)', null, '', [['appearance-idle', 'idle'], ['appearance-face-random', 'Random (Face)'], ['appearance-clothes-idle', 'Clothes mode'], ['appearance-clothes-random', 'Random (Clothes)']])}
    ${pageRow("town page — idle (the heritage's primary start area) | Random | Random (any of the four towns)", null, '', [['town-idle', 'idle'], ['town-random-1', 'Random'], ['town-random-2', 'Random again']])}
    ${pageRow('summary page — a name typed | Random → the ID_CharGen_RandomizeWarning dialog | No (nothing changes) | Yes → RandomizeCharacter (every page rerolled, the name cleared)', null, '', [['summary-idle', 'name typed'], ['summary-random-dialog', 'Random → dialog'], ['summary-after-no', 'No'], ['summary-after-yes', 'Random → Yes']])}
    ${table(live, 'the wizard state per shot (after, live-state.json)')}
    ${table(before, 'the wizard state per shot (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbafd-chargen-random-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbafd] wrote ${join(OUT, 'core17kbbafd-chargen-random-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
