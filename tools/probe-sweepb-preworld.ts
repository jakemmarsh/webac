/**
 * probe-sweepb-preworld — live checks for the SWEEP1006B pre-world fixes,
 * one client on a FRESH account (ACE auto-creates it on first login):
 *  empty-account   a zero-character account lands on character select
 *                  (autoenter=false): no chargen, empty list, ENTER and
 *                  DELETE disabled, CREATE enabled; CREATE opens chargen
 *  finish-once     DoFinish twice before the reply → ONE CharacterCreate
 *                  ("Sending CharacterCreate" logged once); the character
 *                  is created and enters the world
 *  logout-dialog   the indicator X raises "This will exit your character
 *                  from the game world. Are you sure?"; No keeps the
 *                  character in the world, one dialog at a time
 *  mid-air         End Character Session (Shift+Escape) while falling →
 *                  spew "Cannot log off while in mid-air.", still in world
 *  logout-fade     Options → Exit to Character Selection → Yes: the chat
 *                  line "Logging off...", nothing for ~3 s, then the world
 *                  fade (portalSpaceState 1 → tunnel) before character select
 *  keep-selection  a second character, played, is the one selected after
 *                  its logoff (ACE lists the first one first)
 *  logout-deferred End Character Session while the pick-up of a Dagger 20 m
 *                  off is still in flight: "Logging off..." at once, the logoff
 *                  itself (and a second line) only once the Use is answered,
 *                  then character select (LogOffCharacter @ 00563520,
 *                  CPlayerSystem::UseTime @ 00563110)
 *  char-error      ENTER on a character ACE does not own (a CharacterError
 *                  dialog code): Entering World is gone, the OK dialog is
 *                  up, the list takes input again
 * Writes verification/sweepb-preworld/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-sweepb-preworld.ts [--only a,b] [--account name]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import {
  openSession, gameUrl, waitForCharSelect, waitForWorld, shot, adminCommand, collisionState,
  PROBE_CHARGEN_REOPEN_JS, IN_WORLD_JS, AT_CHAR_SELECT_JS, isTrue,
} from './lib/game-session.ts';
import { chatLines, waitDialog, answerDialog, MEET_LOC } from './lib/two-client.ts';

const OUT = 'verification/sweepb-preworld';
const argOf = (k: string): string | null => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const ONLY = (() => { const v = argOf('--only'); return v ? new Set(v.split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);
const ACCOUNT = argOf('--account') ?? `sweepb${Date.now().toString(36)}`;
const CONFIRM_TEXT = 'This will exit your character from the game world. Are you sure?';
/** The DAT string breaks lines ("world.\n\nAre you sure?"); the dialog's text reads them as spaces. */
const isConfirmText = (t: string | null) => t !== null && t.replace(/\s+/g, ' ') === CONFIRM_TEXT;

const ev = <T>(p: Page, js: string): Promise<T> => p.evaluate(js) as Promise<T>;
const spew = (p: Page) => ev<string[]>(p, 'window.__ac.gameUI.spewBox.items.map((i) => i.text)');
const charselBtn = (p: Page, el: number) => ev<{ disabled: boolean; state: string | null } | null>(p,
  `(() => { const b = [...document.querySelectorAll('[data-ac-press]')].find((e) => /[:/](?:0x)?${el.toString(16)}$/i.test(e.dataset.acPress || ''));
    return b ? { disabled: !!b.disabled, state: b.dataset.acState || null } : null; })()`);
const clickCharselBtn = (p: Page, el: number) => ev<boolean>(p,
  `(() => { const b = [...document.querySelectorAll('[data-ac-press]')].find((e) => /[:/](?:0x)?${el.toString(16)}$/i.test(e.dataset.acPress || ''));
    if (!b) return false; b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);

/** Re-open chargen on the probe seed, name it, and press FINISH `times` times before any reply. */
async function finishChargen(p: Page, name: string, times: number): Promise<void> {
  await ev(p, `(() => { const ui = window.__ac.gameUI; ${PROBE_CHARGEN_REOPEN_JS}
    ui.chargenNameEntered = true; ui.wizard.setName(${JSON.stringify(name)});
    for (let i = 0; i < ${times}; i++) ui.doChargenFinish(false); })()`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString(), account: ACCOUNT };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 500)}`); };

  const env = { ...process.env, AC_ACCOUNT: ACCOUNT, AC_PASSWORD: ACCOUNT };
  const url = gameUrl({ cb: 'sweepb-preworld', autoenter: false, env });
  const { browser, page: P } = await openSession({});
  const createSends: string[] = [];
  P.on('console', (m) => { const t = m.text(); if (/Sending CharacterCreate/.test(t)) createSends.push(t); });
  try {
    await P.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    if (!(await waitForCharSelect(P, { url, timeoutMs: 180_000 }))) throw new Error('character select never appeared');
    await P.waitForTimeout(2500);

    // ── empty account ──
    const rows = await ev<number>(P, 'window.__ac.gameUI.selectScreen.slots.length');
    if (want('empty-account')) {
      const inChargen = await isTrue(P, "!!document.getElementById('chargen-root')");
      const enter = await charselBtn(P, 0x100003a2);
      const del = await charselBtn(P, 0x1000039f);
      const create = await charselBtn(P, 0x100003a0);
      await shot(P, `${OUT}/empty-account.png`);
      const pressed = await clickCharselBtn(P, 0x100003a0);
      await P.waitForTimeout(2500);
      const chargenAfterCreate = await isTrue(P, "!!document.getElementById('chargen-root')");
      record('empty-account', rows === 0 && !inChargen && !!enter?.disabled && !!del?.disabled && !!create && create.state === null
        && pressed && chargenAfterCreate, { rows, inChargen, enter, del, create, chargenAfterCreate });
    }

    // ── FINISH once ──
    const firstName = `Sweepb ${ACCOUNT.slice(-4)}a`;
    createSends.length = 0;
    await finishChargen(P, firstName, 3);
    const pending = await ev<boolean>(P, 'window.__ac.gameUI.charGenVerificationPending');
    const entered = await waitForWorld(P, { timeoutMs: 120_000, reloadEveryMs: 0 });
    record('finish-once', createSends.length === 1 && entered, { sends: createSends.length, pendingAfterSend: pending, entered });
    if (!entered) throw new Error('the created character never entered the world');
    await P.waitForTimeout(6000);
    const firstGuid = await ev<number>(P, 'window.__ac.charGuid');

    // ── logout dialog (indicator X), No ──
    if (want('logout-dialog')) {
      await P.locator('#hud-indicator-logout').click({ force: true });
      const text = await waitDialog(P, 5000);
      const second = await ev<boolean>(P, 'window.__ac.gameUI.requestEndCharacterSession()');
      // Open Yes/No dialogs (DAT template 0x15). A fresh character also gets
      // ACE's welcome popup (an OK dialog, 0x24) under it; that one is not ours.
      const dialogs = await ev<number>(P, "document.querySelectorAll('.ac-dat-dialog[data-dialog-element=\"0x15\"]').length");
      await shot(P, `${OUT}/logout-dialog.png`);
      await answerDialog(P, false);
      await P.waitForTimeout(4000);
      const stillIn = await isTrue(P, IN_WORLD_JS);
      const noLine = !(await chatLines(P)).some((l) => l === 'Logging off...');
      record('logout-dialog', isConfirmText(text) && second === false && dialogs === 1 && stillIn && noLine,
        { text, second, dialogs, stillIn, noLine });
    }

    // ── mid-air refusal (End Character Session key while falling) ──
    if (want('mid-air')) {
      const cs = await collisionState(P);
      await adminCommand(P, '@teleloc 0xA9B40019 [85.0 20.5 160.0] 1 0 0 0');
      let airborne = false;
      for (let t = 0; t < 15_000 && !airborne; t += 100) {
        airborne = (await collisionState(P)).onGround === false;
        if (!airborne) await P.waitForTimeout(100);
      }
      await P.keyboard.press('Shift+Escape');
      await P.waitForTimeout(600);
      const s = await spew(P);
      await shot(P, `${OUT}/mid-air.png`);
      await P.waitForTimeout(8000);
      // Not logged off. (IN_WORLD_JS is no test here: a fresh 30-HP
      // character can die of the fall and portal to its lifestone.)
      const stillIn = !(await isTrue(P, AT_CHAR_SELECT_JS));
      const noLine = !(await chatLines(P)).some((l) => l === 'Logging off...');
      record('mid-air', airborne && s.includes('Cannot log off while in mid-air.') && stillIn && noLine,
        { airborne, spew: s.slice(-3), stillIn, noLine, before: { x: cs.x, z: cs.z } });
      await P.waitForTimeout(4000);
    }

    // ── logout fade (Options → Exit to Character Selection → Yes) ──
    if (want('logout-fade')) {
      await ev(P, `(() => { const ui = window.__ac.gameUI; ui.optionsTab = 'gameplay'; if (!ui.optionsPanelVisible) ui.toggleOptionsPanel(); else ui.renderOptionsPanel(); })()`);
      await P.waitForTimeout(1500);
      const clicked = await ev<boolean>(P, `(() => { const b = [...document.querySelectorAll('.options-action-btn')].find((e) => e.dataset.optionsAction === 'Exit to Character Selection');
        if (!b) { window.__ac.gameUI.requestEndCharacterSession(); return false; } b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
      const text = await waitDialog(P, 5000);
      const t0 = Date.now();
      await answerDialog(P, true);
      let line: string | null = null;
      let fadeAt = -1;
      let tunnelSeen = false;
      for (let t = 0; t < 20_000; t += 100) {
        line ??= (await chatLines(P)).find((l) => l === 'Logging off...') ?? null;
        const st = await ev<number>(P, 'window.__ac.gameUI.portalSpaceState').catch(() => 0);
        if (st === 1 && fadeAt < 0) { fadeAt = Date.now() - t0; await shot(P, `${OUT}/logout-fade.png`); }
        if (st >= 2 && st <= 5) tunnelSeen = true;
        if (await isTrue(P, AT_CHAR_SELECT_JS)) break;
        await P.waitForTimeout(100);
      }
      const atSelect = await waitForCharSelect(P, { timeoutMs: 30_000, reloadEveryMs: 0 });
      await shot(P, `${OUT}/after-logout.png`);
      const selected = await ev<string | null>(P, 'window.__ac.gameUI.selectScreen.selectedCharacter?.id ?? null');
      record('logout-fade', clicked && isConfirmText(text) && line === 'Logging off...' && fadeAt >= 2800 && fadeAt <= 4500 && atSelect,
        { clicked, text, line, fadeAtMs: fadeAt, tunnelSeen, atSelect, selected, played: String(firstGuid) });
    }

    // ── keep the played character selected ──
    if (want('keep-selection') && (await isTrue(P, AT_CHAR_SELECT_JS))) {
      await clickCharselBtn(P, 0x100003a0);
      await P.waitForTimeout(2500);
      createSends.length = 0;
      await finishChargen(P, `Sweepb ${ACCOUNT.slice(-4)}b`, 1);
      const entered2 = await waitForWorld(P, { timeoutMs: 120_000, reloadEveryMs: 0 });
      await P.waitForTimeout(5000);
      const secondGuid = await ev<number>(P, 'window.__ac.charGuid');
      await P.keyboard.press('Shift+Escape'); // End Character Session: no dialog
      const atSelect = await waitForCharSelect(P, { timeoutMs: 40_000, reloadEveryMs: 0 });
      await P.waitForTimeout(1500);
      const order = await ev<string[]>(P, 'window.__ac.gameUI.selectScreen.slots.map((c) => c.id)');
      const selected = await ev<string | null>(P, 'window.__ac.gameUI.selectScreen.selectedCharacter?.id ?? null');
      await shot(P, `${OUT}/keep-selection.png`);
      record('keep-selection', entered2 && atSelect && selected === String(secondGuid),
        { entered2, atSelect, firstGuid, secondGuid, order, selected });
    }

    // ── CharacterError over ENTER ──
    if (want('char-error') && (await isTrue(P, AT_CHAR_SELECT_JS))) {
      const before = await ev<string | null>(P, 'window.__ac.gameUI.selectScreen.selectedCharacter?.id ?? null');
      // ENTER on an identity this account does not own (ACE: EnterGameCharacterNotOwned).
      await ev(P, `(() => { const ui = window.__ac.gameUI; ui.showEnteringWorldDialog();
        ui.callbacks.onEnterWorld({ id: '1342177279', name: 'Not Mine' }); })()`);
      let gone = false; let dialog = false;
      for (let t = 0; t < 20_000 && !(gone && dialog); t += 250) {
        gone = !(await isTrue(P, "!!document.getElementById('charsel-enteringworld')"));
        dialog = await isTrue(P, "!!document.getElementById('ac-message-dialog')");
        await P.waitForTimeout(250);
      }
      await shot(P, `${OUT}/char-error.png`);
      const after = await ev<string | null>(P, 'window.__ac.gameUI.selectScreen.selectedCharacter?.id ?? null');
      await P.locator('#ac-message-dialog-ok').click({ force: true }).catch(() => {});
      await P.waitForTimeout(500);
      const enterUsable = await charselBtn(P, 0x100003a2);
      record('char-error', gone && dialog && after === before && !!enterUsable && !enterUsable.disabled,
        { gone, dialog, before, after, enterUsable });
    }

    // ── logoff deferred behind an inventory request ──
    if (want('logout-deferred')) {
      if (await isTrue(P, AT_CHAR_SELECT_JS)) {
        await clickCharselBtn(P, 0x100003a2);
        await waitForWorld(P, { timeoutMs: 120_000, reloadEveryMs: 0 });
        await P.waitForTimeout(4000);
      }
      await adminCommand(P, `@teleloc ${MEET_LOC}`);
      await P.waitForTimeout(9000);
      // A Dagger made here, then picked up from 20 m off: the pick-up
      // (PutItemInContainer) is an inventory request that stays in flight
      // while the character walks over (ACE answers on arrival).
      await adminCommand(P, '@create 314');
      await P.waitForTimeout(3000);
      const chest = await ev<number>(P, `(() => { let g = 0; for (const [k, o] of window.__ac.serverObjectManager.getAllObjects()) if (o.weenieClassId === 314 && (k >>> 0) >= 0x80000000 && (k >>> 0) > g) g = k >>> 0; return g; })()`);
      await adminCommand(P, '@teleloc 0xA9B40019 [85.0 40.5 94.0] 1 0 0 0');
      await P.waitForTimeout(8000);
      const loggingOffCount = async () => (await chatLines(P)).filter((l) => l === 'Logging off...').length;
      const before = await loggingOffCount();
      await ev(P, `window.acDebug.useObject(${chest})`);
      await P.waitForTimeout(300);
      const pendingAtPress = await ev<boolean>(P, '!!window.acDebug.inventoryRequest()');
      await P.keyboard.press('Shift+Escape'); // End Character Session: no dialog
      await P.waitForTimeout(400);
      const linesNow = (await loggingOffCount()) - before;
      const stillInNow = !(await isTrue(P, AT_CHAR_SELECT_JS));
      let linesLater = linesNow;
      for (let t = 0; t < 30_000 && linesLater < 2; t += 250) { await P.waitForTimeout(250); linesLater = (await loggingOffCount()) - before; }
      const atSelect = await waitForCharSelect(P, { timeoutMs: 40_000, reloadEveryMs: 0 });
      record('logout-deferred', !!chest && pendingAtPress && linesNow === 1 && stillInNow && linesLater === 2 && atSelect,
        { dagger: chest.toString(16), pendingAtPress, linesNow, stillInNow, linesLater, atSelect });
    }
  } finally {
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    await browser.close().catch(() => {});
  }
  console.log(fails.length ? `FAILED: ${fails.join(', ')}` : 'ALL PASS');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
