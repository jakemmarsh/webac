/**
 * CORE.17.k.b.b.c.c.b — live capture + side-by-side for the Olthoi
 * heritages' skipped pages: `gmCharGenMainUI::SetProgressState @ 004e7a10`
 * SetVisible(0)s the Profession / Skills / Town tabs for CharGenState
 * heritage 0xc / 0xd and remaps the requested page (back onto Profession /
 * Skills → Heritage, forward → Appearance; back onto Town → Appearance,
 * forward → Summary); the heritage rows toggle the same three
 * (ListenToElementMessage @ 004e9450); the ECG_SUMMARY case hides the Next
 * chevron and shows Finish.
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character; the Aluvian heritage page
 * (every tab); Olthoi Soldier selected (three tabs gone, the lair as the
 * start area); Next (Appearance, not Profession); Next (Summary, Next
 * hidden); Back (Appearance); Back (Heritage); Olthoi Spitter; the
 * Summary tab; Aluvian again (the tabs back); Next (Profession). Every
 * shot records the wizard's state and the tabs' visibility.
 *
 * `--before` captures the same beats against the pre-fix code (the caller
 * checks the old code out first) into ours-before-*.png. `--compose-only`
 * rebuilds the sheet from the frames on disk.
 *
 *   npx tsx tools/capture-core17kbbccb-olthoi-steps-sidebyside.ts [--before] [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccb');
const RETAIL = join(REPO, 'reference', 'images', 'preworld');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

interface ShotState {
  step: number; heritage: number; startArea: number; skillCredits: number;
  tabs: Array<{ step: string; visible: boolean; state: string; label: string }>;
  next: string | null; back: string | null; finish: boolean;
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
  const tabs = Array.from(document.querySelectorAll('.step-tab')).map((t) => ({
    step: t.dataset.step, visible: t.style.display !== 'none' && t.offsetParent !== null,
    state: t.dataset.acProgressState || '', label: (t.textContent || '').trim(),
  }));
  const next = document.getElementById('btn-next');
  const back = document.getElementById('btn-back');
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    heritage: w ? w.heritage : -1, startArea: w ? w.startArea : -1, skillCredits: w ? w.skillCredits : -1,
    tabs, next: next ? (next.dataset.acMedia || 'shown') : null, back: back ? (back.dataset.acMedia || 'shown') : null,
    finish: !!document.getElementById('btn-confirm'),
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbccb] still waiting — reloading');
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
    console.log(`[core17kbbccb] ${file}: step ${st.step}, heritage ${st.heritage}, town ${st.startArea}, credits ${st.skillCredits}, tabs ${st.tabs.map((t) => `${t.label}:${t.visible ? 'v' : 'HIDDEN'}/${t.state}`).join(' ')}, next ${st.next}, back ${st.back}, finish ${st.finish}`);
    return st;
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const stepVia = async (sel: string): Promise<void> => {
    const before = await page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as number;
    if (!(await clickSel(sel))) throw new Error(`${sel} not found on step ${before}`);
    const moved = await page.waitForFunction((prev) =>
      parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev, before, { timeout: 15_000 })
      .then(() => true).catch(() => false);
    if (!moved) throw new Error(`wizard did not move from step ${before} via ${sel}`);
    await page.waitForTimeout(1500);
  };
  const pick = async (heritage: number): Promise<void> => {
    if (!(await clickSel(`.heritage-btn[data-heritage="${heritage}"]`))) throw new Error(`heritage row ${heritage} not found`);
    await page.waitForTimeout(1200);
  };

  console.log(`[core17kbbccb] navigating (autoenter=false)${BEFORE ? ' — BEFORE capture' : ''}`);
  await page.goto(`${BASE}&autoenter=false&cb=kbbccb${BEFORE ? 'b' : ''}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickSel('#btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(2000);

  await shoot('heritage-aluvian');
  await pick(12);
  await shoot('heritage-olthoi-soldier');
  await stepVia('#btn-next'); await shoot('olthoi-next-1');
  await stepVia('#btn-next'); await shoot('olthoi-next-2');
  await stepVia('#btn-back'); await shoot('olthoi-back-1');
  await stepVia('#btn-back'); await shoot('olthoi-back-2');
  await pick(13);
  await shoot('heritage-olthoi-spitter');
  await stepVia('.step-tab[data-step="5"]'); await shoot('spitter-summary-tab');
  await stepVia('.step-tab[data-step="0"]');
  await pick(1);
  await shoot('heritage-aluvian-again');
  await stepVia('#btn-next'); await shoot('aluvian-next');

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
  table{border-collapse:collapse;margin-top:8px} td,th{border:1px solid #444;padding:2px 6px;text-align:left;vertical-align:top;max-width:520px;word-break:break-all} th{color:#9cf}
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
    const head = `<tr><th>shot</th><th>step</th><th>heritage</th><th>start area</th><th>skill credits</th><th>tabs (label:visible/state)</th><th>Next</th><th>Back</th><th>Finish</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state;
      return `<tr><td>${n}</td><td>${s.step}</td><td>${s.heritage}</td><td>${s.startArea}</td><td>${s.skillCredits}</td><td>${s.tabs.map((t) => `${t.label}:${t.visible ? 'v' : 'HIDDEN'}/${t.state}`).join(' ')}</td><td>${s.next}</td><td>${s.back}</td><td>${s.finish}</td></tr>`;
    }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  const beatRow = (title: string, retail: string | null, retailLabel: string, beats: Array<[string, string]>): string => {
    const cells = [retail ? frame(join(RETAIL, retail), retailLabel, 440) : ''];
    for (const [n, label] of beats) cells.push(frame(ourBefore(n), `before — ${label}`, 440), frame(ours(n), `after — ${label}`, 440));
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.c.c.b — the Olthoi heritages skip Profession / Skills / Town: gmCharGenMainUI::SetProgressState @ 004e7a10 SetVisible(0)s the three tabs for CharGenState heritage 0xc / 0xd (SetVisible(1) for every other heritage; the heritage rows toggle the same three from ListenToElementMessage @ 004e9450) and remaps the requested page — back onto Profession / Skills → Heritage, forward → Appearance; back onto Town → Appearance, forward → Summary; the ECG_SUMMARY case hides the Next chevron (m_pRightButton) and shows Finish. Before: every heritage walked all six pages with every tab visible and Next drawn disabled on the summary. Retail (the EoL heritage-page reference; no Olthoi footage exists) | before | after.</h1>
    ${beatRow('the heritage page — Aluvian (all six tabs) | Olthoi Soldier selected (Profession / Skills / Town gone; the lair as start area 4; 68 skill credits)', 'char-create-race-ref1.webp', 'retail — EoL heritage page (char-create-race-ref1.webp)', [['heritage-aluvian', 'Aluvian'], ['heritage-olthoi-soldier', 'Olthoi Soldier']])}
    ${beatRow('Olthoi Soldier — Next (Appearance, not Profession) | Next (Summary: Next hidden, Finish shown)', null, '', [['olthoi-next-1', 'Next'], ['olthoi-next-2', 'Next again']])}
    ${beatRow('Olthoi Soldier — Back (Appearance, not Town) | Back (Heritage, not Skills)', null, '', [['olthoi-back-1', 'Back'], ['olthoi-back-2', 'Back again']])}
    ${beatRow('Olthoi Spitter — the row (the same three tabs gone) | the Summary tab', null, '', [['heritage-olthoi-spitter', 'Olthoi Spitter'], ['spitter-summary-tab', 'Summary tab']])}
    ${beatRow('Aluvian again — the tabs return (Holtburg as the start area) | Next (Profession)', null, '', [['heritage-aluvian-again', 'Aluvian'], ['aluvian-next', 'Next']])}
    ${table(live, 'the wizard state per shot (after, live-state.json)')}
    ${table(before, 'the wizard state per shot (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbccb-olthoi-steps-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbccb] wrote ${join(OUT, 'core17kbbccb-olthoi-steps-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
