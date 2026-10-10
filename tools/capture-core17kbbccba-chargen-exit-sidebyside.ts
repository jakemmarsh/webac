/**
 * CORE.17.k.b.b.c.c.b.a — live capture + side-by-side for the chargen exit:
 * `gmCharGenMainUI::ListenToElementMessage @ 004e9450` — Back (0x100003c6)
 * on the Heritage page and Exit (0x100003ca) both run `DoExit @ 004e8650`,
 * the ID_CharGen_ExitWarning Yes / No dialog; `RecvNotice_CloseDialog @
 * 004e9780` on Yes → `UIFramework::QueueUIMode(0x1000000a)`, the
 * character-select screen.
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character; the Heritage page (Back drawn
 * with the normal chevron); Back → the warning dialog; No → still the page;
 * Exit → the dialog; Yes → character select; Create Character again → a
 * fresh wizard. Every shot records the screen, the wizard step, the dialog
 * text and the Back chevron's media.
 *
 * `--before` captures the same beats against the pre-fix code (the caller
 * checks the old code out first) into ours-before-*.png. `--compose-only`
 * rebuilds the sheet from the frames on disk.
 *
 *   npx tsx tools/capture-core17kbbccba-chargen-exit-sidebyside.ts [--before] [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccba');
const RETAIL = join(REPO, 'reference', 'images', 'preworld');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

interface ShotState {
  screen: string; step: number; heritage: number; dialog: string | null; buttons: string[];
  plates: number; back: string | null; backPointer: string | null; exitOpen: boolean | null; characters: string[];
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
  const back = document.getElementById('btn-back');
  const dlg = document.querySelector('.ac-dialog-text');
  const inner = document.getElementById('charsel-inner');
  return {
    screen: document.getElementById('chargen-root') ? 'character-create' : (inner ? 'character-select:' + (inner.dataset.mode || '') : 'other'),
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    heritage: w ? w.heritage : -1,
    // the live dialog draws its text and labels with the AC bitmap fonts (canvas runs): record the run text they were built from
    dialog: dlg ? ((dlg.textContent || '').replace(/\\s+/g, ' ').trim() || Array.from(dlg.querySelectorAll('[data-ac-run-text]')).map((r) => r.dataset.acRunText).join(' ') || '(bitmap text)') : null,
    buttons: Array.from(document.querySelectorAll('.ac-dialog-button')).map((b) => (b.textContent || '').trim() || Array.from(b.querySelectorAll('[data-ac-run-text]')).map((r) => r.dataset.acRunText).join('') || '(bitmap)'),
    plates: document.querySelectorAll('.ac-dialog-plate').length,
    back: back ? (back.dataset.acMedia || 'shown') : null,
    backPointer: back ? back.style.pointerEvents : null,
    exitOpen: ui && typeof ui.isChargenExitDialogOpen === 'boolean' ? ui.isChargenExitDialogOpen : null,
    characters: Array.from(document.querySelectorAll('.char-slot')).map((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim()),
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbccba] still waiting — reloading');
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
    console.log(`[core17kbbccba] ${file}: ${st.screen} step ${st.step} heritage ${st.heritage} back ${st.back}/${st.backPointer} exitOpen ${st.exitOpen} plates ${st.plates} dialog ${st.dialog ? JSON.stringify(st.dialog.slice(0, 60)) : 'none'} buttons [${st.buttons.join(', ')}]`);
    return st;
  };
  const clickSel = async (sel: string, index = 0): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}]; if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const settle = () => page.waitForTimeout(1500);

  console.log(`[core17kbbccba] navigating (autoenter=false)${BEFORE ? ' — BEFORE capture' : ''}`);
  await page.goto(`${BASE}&autoenter=false&cb=kbbccba${BEFORE ? 'b' : ''}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  await shoot('charselect');
  if (!(await clickSel('#btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(2000);

  await shoot('heritage-page');
  await clickSel('#btn-back'); await settle();
  await shoot('back-on-heritage');
  await clickSel('.ac-dialog-button', 1); await settle();          // No
  await shoot('back-no');
  await clickSel('#btn-cancel'); await settle();
  await shoot('exit');
  await clickSel('#btn-cancel'); await settle();                    // a second DoExit while open — refused
  await shoot('exit-again');
  await clickSel('.ac-dialog-button', 0); await settle();          // Yes
  await shoot('exit-yes');
  await clickSel('#btn-create-character'); await page.waitForTimeout(2500);
  await shoot('reenter');

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
    const head = `<tr><th>shot</th><th>screen</th><th>step</th><th>heritage</th><th>Back media / pointer</th><th>exit context</th><th>plates</th><th>dialog</th><th>buttons</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state;
      return `<tr><td>${n}</td><td>${s.screen}</td><td>${s.step}</td><td>${s.heritage}</td><td>${s.back} / ${s.backPointer}</td><td>${s.exitOpen}</td><td>${s.plates}</td><td>${s.dialog ?? '—'}</td><td>${s.buttons.join(' | ')}</td></tr>`;
    }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  const beatRow = (title: string, retail: string | null, retailLabel: string, beats: Array<[string, string]>): string => {
    const cells = [retail ? frame(join(RETAIL, retail), retailLabel, 440) : ''];
    for (const [n, label] of beats) cells.push(frame(ourBefore(n), `before — ${label}`, 440), frame(ours(n), `after — ${label}`, 440));
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.c.c.b.a — Back on the Heritage page is DoExit and Exit is real: gmCharGenMainUI::ListenToElementMessage @ 004e9450 case 0x100003c6 is \`1 &lt; m_eProgressState ? SetProgressState(state − 1) : DoExit\` and case 0x100003ca (Exit) shares the DoExit jump; DoExit @ 004e8650 raises the DialogFactory type-1 ID_CharGen_ExitWarning Yes / No dialog once (m_uiExitContext); RecvNotice_CloseDialog @ 004e9780 on Yes → UIFramework::QueueUIMode(0x1000000a), gmCharacterManagementUI. Before: Back drawn disabled (0x06004c91) on the first page, Exit a no-op in ACE mode. Retail (the EoL heritage-page reference; no retail footage of the exit dialog exists — it is anchored on the decomp + the DialogFactory template) | before | after.</h1>
    ${beatRow('the Heritage page — Back with the normal chevron | Back clicked: the ID_CharGen_ExitWarning dialog (before: nothing — the chevron was disabled)', 'char-create-race-ref1.webp', 'retail — EoL heritage page (char-create-race-ref1.webp)', [['heritage-page', 'Heritage page'], ['back-on-heritage', 'Back clicked']])}
    ${beatRow('No — the page stays | Exit clicked: the same dialog (before: nothing)', null, '', [['back-no', 'No'], ['exit', 'Exit clicked']])}
    ${beatRow('Exit clicked again while the dialog is up — refused (one dialog) | Yes — the character-select screen (before: still chargen)', null, '', [['exit-again', 'Exit again'], ['exit-yes', 'Yes']])}
    ${beatRow('the character select the session started on | Create Character again — a fresh wizard on the Heritage page', null, '', [['charselect', 'char select at start'], ['reenter', 'Create Character again']])}
    ${table(live, 'the screen state per shot (after, live-state.json)')}
    ${table(before, 'the screen state per shot (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbccba-chargen-exit-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbccba] wrote ${join(OUT, 'core17kbbccba-chargen-exit-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
