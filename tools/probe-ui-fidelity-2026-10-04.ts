/**
 * probe-ui-fidelity-2026-10-04 — live check of the 2026-10-04 UI-fidelity
 * batch (RECON.dialogs-via-layoutrenderer, RECON.charselect-delete-dialog,
 * RECON.craft-confirmations-and-gesture, gmAbuseUI / gmUrgentAssistanceUI /
 * gmBookUI ports, VISUAL.chargen-appearance-stepper-rows,
 * VISUAL.info-panel-text-justify).
 *
 * Nothing is deleted, reported or broadcast: the delete dialog gets the
 * wrong word, Report Abuse / Urgent Assistance are cancelled, the mana stone
 * and salvage confirmations are answered No.
 *
 *   npx tsx tools/probe-ui-fidelity-2026-10-04.ts            (AC_ACCOUNT, default testacjs)
 *
 * Screenshots + a JSON of every beat to verification/ui-fidelity-2026-10-04/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterCharSelect, enterWorld, adminCommand, gameUrl } from './lib/game-session.js';

const OUT = 'verification/ui-fidelity-2026-10-04';
const ACCOUNT = process.env.AC_ACCOUNT ?? 'testacjs';
const env = { ...process.env, AC_ACCOUNT: ACCOUNT, AC_PASSWORD: process.env.AC_PASSWORD ?? ACCOUNT };
const beats: Array<{ beat: string; ok: boolean; detail: unknown }> = [];
const beat = (name: string, ok: boolean, detail: unknown = null): void => {
  beats.push({ beat: name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail === null ? '' : JSON.stringify(detail)}`);
};
const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: `${OUT}/${name}.png` });
const ev = <T>(page: Page, js: string): Promise<T> => page.evaluate(js) as Promise<T>;
const clickEl = (page: Page, scope: string, id: number): Promise<boolean> => ev(page, `(() => {
  const s = document.querySelector(${JSON.stringify(scope)}); const n = s && s.querySelector('[data-element-id="0x${id.toString(16)}"]');
  if (!n) return false; for (const t of ['mousedown','mouseup','click']) n.dispatchEvent(new MouseEvent(t, { bubbles: true })); return true; })()`);
const shown = (page: Page, scope: string, id: number): Promise<boolean> => ev(page, `(() => {
  const n = document.querySelector(${JSON.stringify(scope)} + ' [data-element-id="0x${id.toString(16)}"]'); return !!n && n.style.display !== 'none'; })()`);
const dialogText = (page: Page, el: number): Promise<string> => ev(page, `(() => {
  const d = document.querySelector('.ac-dat-dialog[data-dialog-element="0x${el.toString(16)}"]'); if (!d) return '';
  return [...d.querySelectorAll('[data-ac-line]')].map((l) => l.dataset.acLine).join(' ') || (d.textContent || ''); })()`);

async function charSelect(): Promise<void> {
  const { browser, page } = await enterCharSelect({ url: gameUrl({ cb: 'uifid-cs', autoenter: false, env }), settleMs: 3000 });
  try {
    await shot(page, 'cs-0-select');
    // EXIT → the DAT Yes/No dialog (element 0x15); answer No.
    await ev(page, `window.__ac.gameUI.confirmExitGame()`);
    await page.waitForTimeout(800);
    const exitDlg = await ev<boolean>(page, `!!document.querySelector('.ac-dat-dialog[data-dialog-element="0x15"] [data-element-id="0x3d"]')`);
    await shot(page, 'cs-1-exit-confirm');
    beat('char-select EXIT confirm is the DAT 0x15 plate', exitDlg, await dialogText(page, 0x15));
    await clickEl(page, '.ac-dat-dialog[data-dialog-element="0x15"]', 0x19);
    await page.waitForTimeout(500);
    // DELETE → the type-5 entry dialog (0x2c) with the DAT warning; the wrong word deletes nothing.
    const before = await ev<number>(page, `window.__ac.gameUI.selectScreen.characters.length`);
    const selected = await ev<boolean>(page, `(() => { const ui = window.__ac.gameUI; if (!ui.selectScreen.characters.length) return false; ui.selectScreen.selectCharacter(0); ui.renderCharacterSelect(); return true; })()`);
    if (!selected) { beat('char-select has a character to open DELETE on', false); return; }
    // The DELETE button (0x1000039f; its label is a DAT-font canvas, so no textContent).
    await ev(page, `(() => { const b = document.querySelector('button[data-ac-press="21000004:1000039f"]'); b && b.click(); })()`);
    await page.waitForTimeout(800);
    const delText = await dialogText(page, 0x2c);
    await shot(page, 'cs-2-delete-dialog');
    beat('DELETE opens the type-5 dialog with the DAT warning', /WARNING!.*type 'DELETE'/.test(delText), delText.slice(0, 120));
    await ev(page, `(() => { const i = document.querySelector('.ac-dialog-entry'); i.value = 'not delete'; })()`);
    await clickEl(page, '.ac-dat-dialog[data-dialog-element="0x2c"]', 0x2e);
    await page.waitForTimeout(3000);
    const after = await ev<number>(page, `window.__ac.gameUI.selectScreen.characters.length`);
    beat('a wrong word + Done deletes nothing', after === before, { before, after });
    // Create Character → Appearance: no invented stepper rows.
    await ev(page, `window.__ac.gameUI.showCharacterCreate()`);
    await page.waitForTimeout(2500);
    await ev(page, `(() => { const ui = window.__ac.gameUI; ui.wizard.currentStep = 3; ui.renderCharacterCreate(); })()`);
    await page.waitForTimeout(2000);
    await shot(page, 'cs-3-chargen-appearance');
    const steppers = await ev<number>(page, `document.querySelectorAll('.appear-inc, .appear-dec').length`);
    beat('chargen Appearance has no stepper rows', steppers === 0, { steppers });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function world(): Promise<void> {
  const { browser, page } = await enterWorld({ url: gameUrl({ cb: 'uifid-w', env }), settleMs: 6000 });
  try {
    await adminCommand(page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
    await page.waitForTimeout(8000);
    // Report Abuse + Urgent Assistance from Options → Gameplay; cancelled.
    await ev(page, `window.__ac.gameUI.showReportAbuseDialog()`);
    await page.waitForTimeout(800);
    beat('Report Abuse opens gmAbuseUI on its intro page', await shown(page, '.ac-report-abuse', 0x100000ff));
    await shot(page, 'w-1-abuse-intro');
    await clickEl(page, '.ac-report-abuse [data-element-id="0x100000ff"]', 0x10000102);
    await page.waitForTimeout(500);
    const sendState = await ev<string>(page, `document.querySelector('.ac-report-abuse [data-element-id="0x10000109"]')?.dataset.acState ?? ''`);
    beat('Continue → the form, Send ghosted', await shown(page, '.ac-report-abuse', 0x10000103) && sendState === 'd', { sendState });
    await shot(page, 'w-2-abuse-form');
    await clickEl(page, '.ac-report-abuse [data-element-id="0x10000103"]', 0x10000101);
    await ev(page, `window.__ac.gameUI.toggleUrgentAssistancePanel()`);
    await page.waitForTimeout(800);
    beat('Urgent Assistance opens gmUrgentAssistanceUI', await shown(page, '.ac-urgent-assistance', 0x100001b4));
    await shot(page, 'w-3-urgent');
    await ev(page, `window.__ac.gameUI.toggleUrgentAssistancePanel()`);
    // Link Status: body text centred from its DAT element.
    await ev(page, `window.__ac.gameUI.toggleLinkStatusPanel()`);
    await page.waitForTimeout(1500);
    const linkCentered = await ev<boolean>(page, `(() => { const c = document.querySelector('[data-link-status-text]'); return !!c && !c.querySelector('[style*="padding: 6px 8px"]'); })()`);
    await shot(page, 'w-4-link-status');
    beat('Link Status body drawn from its DAT element', linkCentered);
    await ev(page, `window.__ac.gameUI.toggleLinkStatusPanel()`);
    // A real book: the pages arrive by BookPageData.
    await adminCommand(page, '@ci 20955');
    await page.waitForTimeout(3000);
    // The pack has to be open for its item cells to exist (F12).
    await ev(page, `(() => { const ui = window.__ac.gameUI; if (!ui.inventoryVisible) ui.toggleInventory(); })()`);
    await page.waitForTimeout(1500);
    await ev(page, `(() => { const ui = window.__ac.gameUI; const i = ui.inventoryItems.findIndex((x) => x.weenieClassId === 20955);
      const cell = document.querySelector('[data-inv-slot="' + i + '"]'); if (cell) cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
    let pageText = '';
    for (let t = 0; t < 12 && !pageText; t++) {
      await page.waitForTimeout(500);
      pageText = await ev<string>(page, `(() => { const c = document.querySelector('.ac-book .ac-book-page-text, .ac-book textarea'); return c ? ([...c.querySelectorAll('[data-ac-line]')].map((l) => l.dataset.acLine).join(' ') || c.value || '') : ''; })()`);
    }
    await shot(page, 'w-5-book-page-1');
    beat('a book opens in gmBookUI and page 1\'s text arrives', pageText.trim().length > 0, pageText.slice(0, 80));
    await clickEl(page, '.ac-book', 0x10000115);
    await page.waitForTimeout(2500);
    await shot(page, 'w-6-book-page-2');
    const page2 = await ev<number>(page, `window.__ac.gameUI.book.curPage`);
    beat('Next turns to page 2', page2 === 1, { curPage: page2 });
    await ev(page, `window.__ac.gameUI.hideBookPanel()`);
    // Targeted use: an empty mana stone onto a pack item → the drain confirm (No).
    await adminCommand(page, '@ci 2435');
    await adminCommand(page, '@ci 29581');
    // A dagger (mana-stone target) and a leather vest (steel salvage's live targetType is 6: armor / clothing).
    await adminCommand(page, '@ci 314');
    await adminCommand(page, '@ci 43828');
    await page.waitForTimeout(3000);
    await ev(page, `(() => { const ui = window.__ac.gameUI; if (!ui.inventoryVisible) ui.toggleInventory(); else ui.renderInventoryPanel?.(); })()`);
    await page.waitForTimeout(1500);
    const useOn = async (srcWcid: number, label: string, shotName: string): Promise<void> => {
      await ev(page, `(() => { const ui = window.__ac.gameUI; const items = ui.inventoryItems;
        const s = items.findIndex((x) => x.weenieClassId === ${srcWcid});
        // A target the source's targetType accepts (TargetCompatibleWithObject), else the gate refuses first.
        const tt = (items[s] && items[s].targetType) || 0;
        const t = items.findIndex((x) => x.weenieClassId !== ${srcWcid} && x.weenieClassId !== 2435 && x.weenieClassId !== 29581 && !(x.itemType & 0x200) && (tt === 0 || (x.itemType & tt) !== 0));
        window.__probeTarget = items[t] && items[t].name;
        const sc = document.querySelector('[data-inv-slot="' + s + '"]'); sc && sc.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const tc = document.querySelector('[data-inv-slot="' + t + '"]'); tc && tc.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
      await page.waitForTimeout(1200);
      const text = await dialogText(page, 0x15);
      await shot(page, shotName);
      beat(label, text.length > 0, { text: text.slice(0, 140), target: await ev(page, 'window.__probeTarget') });
      await clickEl(page, '.ac-dat-dialog[data-dialog-element="0x15"]', 0x19);
      await page.waitForTimeout(500);
    };
    await useOn(2435, 'empty mana stone → TargetedUsageConfirmation_ManaStone', 'w-7-manastone-confirm');
    await useOn(29581, 'salvage → TargetedUsageConfirmation_Salvage', 'w-8-salvage-confirm');
    // @allegiance with no subcommand: retail's help hint in the spew box, no chat send.
    await ev(page, `window.acDebug.sendChat('@allegiance')`).catch(() => adminCommand(page, '@allegiance'));
    await page.waitForTimeout(1500);
    // The spew box draws DAT-font canvases: read their run text.
    const spew = await ev<string>(page, `[...document.querySelectorAll('[data-ac-run-text]')].map((e) => e.dataset.acRunText).join(' | ')`);
    beat('@allegiance alone prints the retail help hint', spew.includes('Please see @help Allegiance'), null);
    await shot(page, 'w-9-allegiance-hint');
    // The Components page from 0x21000033: template rows + headers, an editable desired level.
    await ev(page, `(() => { const ui = window.__ac.gameUI; ui.magicPanelTab = 'components'; if (!ui.magicVisible) ui.toggleMagicPanel(); else ui.renderMagicPanel(); })()`);
    await page.waitForTimeout(1500);
    const comps = await ev<{ headers: number; rows: number; inputs: number }>(page, `(() => { const l = document.querySelector('.ac-components-list');
      return { headers: l ? l.querySelectorAll('.ac-components-header').length : -1, rows: l ? l.querySelectorAll('[data-comp-wcid]').length : -1, inputs: l ? l.querySelectorAll('input.ac-comp-desired').length : -1 }; })()`);
    await shot(page, 'w-10-components');
    beat('Components page renders DAT template rows with category headers and desired-level fields', comps.rows > 0 && comps.headers > 0 && comps.inputs === comps.rows, comps);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await charSelect();
  await world();
  writeFileSync(`${OUT}/beats.json`, JSON.stringify(beats, null, 2) + '\n');
  const failed = beats.filter((b) => !b.ok);
  console.log(`${beats.length - failed.length}/${beats.length} beats passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
