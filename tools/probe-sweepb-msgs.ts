/**
 * probe-sweepb-msgs — live checks for the SWEEP1006B message-reaction and
 * after-sky fixes, two clients (A fxprobe1 / B fxprobe2) in Holtburg:
 *  fellowship  A creates "Sweepb", recruits B, dismisses B, recruits again,
 *              B quits, recruits again, A disbands. Each side's chat must
 *              carry retail's gmFellowshipUI lines (type 0):
 *              A "You have created the Fellowship of Sweepb.",
 *                "<B> is now a member of your Fellowship.",
 *                "You dismiss <B> from your Fellowship.",
 *                "<B> has left your Fellowship.",
 *                "You have disbanded your Fellowship."
 *              B "You have been recruited into the Sweepb fellowship, a fellowship led by <A>.",
 *                "<A> has dismissed you from the Fellowship.",
 *                "You are no longer a member of the Sweepb Fellowship.",
 *                "<A> has disbanded your Fellowship."
 *  combat      during a @teleloc's portal space, the combat key (Backquote)
 *              changes nothing, sends no ChangeCombatMode and puts "You can't
 *              enter combat mode while in portal space" in the spew box
 *              (ClientCombatSystem::SetCombatMode @ 0056be30)
 *  sky         Rainy day group pinned: outdoors the after-sky (props&0x1)
 *              objects draw; inside a Holtburg building cell (0xA9B4016A) they
 *              are hidden while the before-sky ones still draw; back outside
 *              they return (GameSky::Draw @ 00506ff0 is_player_outside gate)
 *  vitals      A sets mana to 1 (@setvital), logs out, logs back in: the HUD's
 *              mana right after entry is the PlayerDescription's value, not
 *              max (SmartBox::HandleCreateObject @ 00454c80 never writes vitals)
 *  ban         B's account is banned 5 min with a reason; a fresh login of it
 *              lands on the Disconnected screen with retail's "You have been
 *              banned until <asctime> - <reason>. For ban appeals, please
 *              visit support.turbine.com" (Handle_AccountBanned @ 00562bd0).
 *              The account is always unbanned afterwards.
 * Writes verification/sweepb-msgs/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-sweepb-msgs.ts [--only a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, enterWorld, gameUrl, openSession, shot } from './lib/game-session.ts';
import { openTwoClients, chatLines, waitChat, waitDialog, answerDialog, MEET_LOC } from './lib/two-client.ts';

const OUT = 'verification/sweepb-msgs';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);
const FELLOWSHIP = 'Sweepb';
/** A Holtburg building cell at ground level (capture-…-salvage-drag-accept's spot). */
const INTERIOR_LOC = '0xA9B4016A [77.4 36.2 94.01] 1 0 0 0';
const PORTAL_SPACE_LINE = "You can't enter combat mode while in portal space";

const ev = <T>(p: Page, js: string): Promise<T> => p.evaluate(js) as Promise<T>;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spew = (p: Page) => ev<string[]>(p, 'window.__ac.gameUI.spewBox.items.map((i) => i.text)');

const SKY_STATE_JS = `(() => { const s = window.__ac.skybox;
  const entries = s.skyObjectEntries || [], setups = s.setupSkyEntries || [];
  return { outside: s.isPlayerOutside, group: s.dayGroupName,
    after: entries.filter((e) => (e.skyObj.properties & 1) !== 0).map((e) => e.mesh.visible),
    before: entries.filter((e) => (e.skyObj.properties & 1) === 0).map((e) => e.mesh.visible),
    afterSetups: setups.filter((e) => e.anchor.userData.skyPass && e.anchor.userData.skyPass.afterWorld).map((e) => e.anchor.visible) }; })()`;
interface SkyState { outside: boolean; group: string; after: boolean[]; before: boolean[]; afterSetups: boolean[] }

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 600)}`); };
  const { a, b, close } = await openTwoClients('sweepb-msgs');
  let A = a.page;
  const extraBrowsers: Array<{ close: () => Promise<void> }> = [];
  let banned = false;
  try {
    if (want('fellowship')) {
      await ev(b.page, `(() => { const ui = window.__ac.gameUI; ui.optionsSettings.ignoreFellowshipRequests = false;
        ui.callbacks.onCharacterOptionToggle?.(0x02, false); })()`);
      await b.page.waitForTimeout(1500);
      const recruitB = async (): Promise<boolean> => {
        await ev(A, `window.acDebug.select(${b.guid})`);
        await A.waitForTimeout(600);
        await ev(A, 'window.__ac.gameUI.callbacks.onFellowshipRecruitSelected()');
        const ask = await waitDialog(b.page, 10_000);
        if (ask === null) return false;
        await answerDialog(b.page, true);
        await A.waitForTimeout(3500);
        return true;
      };
      await ev(A, `window.__ac.gameUI.callbacks.onCreateFellowship(${JSON.stringify(FELLOWSHIP)})`);
      const created = await waitChat(A, new RegExp(`^You have created the Fellowship of ${FELLOWSHIP}\\.$`), 8000);
      const r1 = await recruitB();
      const joinedA = await waitChat(A, new RegExp(`^${esc(b.name)} is now a member of your Fellowship\\.$`), 6000);
      const recruitedB = await waitChat(b.page, new RegExp(`^You have been recruited into the ${FELLOWSHIP} fellowship, a fellowship led by ${esc(a.name)}\\.$`), 6000);
      await shot(b.page, `${OUT}/fellowship-recruited.png`);
      await ev(A, `window.__ac.gameUI.callbacks.onFellowshipSteps([{ kind: 'dismiss', guid: ${b.guid} }])`);
      const dismissA = await waitChat(A, new RegExp(`^You dismiss ${esc(b.name)} from your Fellowship\\.$`), 6000);
      const dismissB = await waitChat(b.page, new RegExp(`^${esc(a.name)} has dismissed you from the Fellowship\\.$`), 6000);
      await A.waitForTimeout(1500);
      const r2 = await recruitB();
      await ev(b.page, `window.__ac.gameUI.callbacks.onFellowshipSteps([{ kind: 'quit', disband: false }])`);
      const quitB = await waitChat(b.page, new RegExp(`^You are no longer a member of the ${FELLOWSHIP} Fellowship\\.$`), 6000);
      const quitA = await waitChat(A, new RegExp(`^${esc(b.name)} has left your Fellowship\\.$`), 6000);
      await A.waitForTimeout(1500);
      const r3 = await recruitB();
      await ev(A, `window.__ac.gameUI.callbacks.onFellowshipSteps([{ kind: 'quit', disband: true }])`);
      const disbandA = await waitChat(A, /^You have disbanded your Fellowship\.$/, 6000);
      const disbandB = await waitChat(b.page, new RegExp(`^${esc(a.name)} has disbanded your Fellowship\\.$`), 6000);
      await shot(A, `${OUT}/fellowship-leader-chat.png`);
      const detail = { created, recruitOk: [r1, r2, r3], joinedA, recruitedB, dismissA, dismissB, quitB, quitA, disbandA, disbandB,
        chatA: (await chatLines(A)).slice(-14), chatB: (await chatLines(b.page)).slice(-14) };
      record('fellowship', !!(created && r1 && r2 && r3 && joinedA && recruitedB && dismissA && dismissB && quitB && quitA && disbandA && disbandB), detail);
    }

    if (want('combat')) {
      const sentModes: string[] = [];
      const onConsole = (m: { text(): string }) => { const t = m.text(); if (/Sent ChangeCombatMode/.test(t)) sentModes.push(t); };
      A.on('console', onConsole);
      await ev(A, `(() => { const i = document.getElementById('chat-input'); if (i) i.blur(); })()`);
      const modeBefore = await ev<number>(A, 'window.__ac.gameUI.hudState.combatMode');
      const spewBefore = (await spew(A)).length;
      await adminCommand(A, `@teleloc ${MEET_LOC}`, 'talk');
      let inPortal = false;
      for (let t = 0; t < 10_000 && !inPortal; t += 50) {
        inPortal = await ev<boolean>(A, 'window.acDebug.cursorState().teleport');
        if (!inPortal) await A.waitForTimeout(50);
      }
      if (inPortal) await A.keyboard.press('Backquote');
      await A.waitForTimeout(400);
      const modeAfter = await ev<number>(A, 'window.__ac.gameUI.hudState.combatMode');
      const newSpew = (await spew(A)).slice(spewBefore);
      await shot(A, `${OUT}/combat-portal-space.png`);
      await A.waitForTimeout(10_000);
      A.off('console', onConsole);
      record('combat', inPortal && modeAfter === modeBefore && sentModes.length === 0 && newSpew.includes(PORTAL_SPACE_LINE),
        { inPortal, modeBefore, modeAfter, sentModes, newSpew });
      // Out of portal space the key works again (and is put back).
      await A.keyboard.press('Backquote');
      await A.waitForTimeout(1500);
      const toggledAfter = await ev<number>(A, 'window.__ac.gameUI.hudState.combatMode');
      if (toggledAfter !== modeBefore) { await A.keyboard.press('Backquote'); await A.waitForTimeout(1500); }
      record('combat-after-portal', toggledAfter !== modeBefore, { modeBefore, toggledAfter });
    }

    if (want('sky')) {
      const pin = await ev<unknown>(A, `window.acDebug.pinDayGroup('Rainy')`);
      await A.waitForTimeout(3000);
      const outdoors = await ev<SkyState>(A, SKY_STATE_JS);
      await adminCommand(A, `@teleloc ${INTERIOR_LOC}`, 'talk');
      await A.waitForTimeout(15_000);
      const inside = await ev<SkyState>(A, SKY_STATE_JS);
      await shot(A, `${OUT}/sky-inside-building.png`);
      await adminCommand(A, `@teleloc ${MEET_LOC}`, 'talk');
      await A.waitForTimeout(12_000);
      const back = await ev<SkyState>(A, SKY_STATE_JS);
      await shot(A, `${OUT}/sky-outdoors.png`);
      await ev(A, 'window.acDebug.pinDayGroup(null)');
      const allOn = (v: boolean[]) => v.length > 0 && v.every(Boolean);
      const allOff = (v: boolean[]) => v.every((x) => !x);
      record('sky', outdoors.outside && allOn(outdoors.after) && !inside.outside && allOff(inside.after) && allOff(inside.afterSetups)
        && inside.before.some(Boolean) && back.outside && allOn(back.after),
        { pin, outdoors, inside, back });
    }

    if (want('vitals')) {
      await adminCommand(A, '@setvital mana 1');
      await A.waitForTimeout(3000);
      const beforeLogout = await ev<{ current: number; max: number }>(A, '({ ...window.__ac.playerState.mana })');
      await a.browser.close();
      await new Promise((r) => setTimeout(r, 15_000)); // ACE's async logout save
      // The PlayerDescription's vitals line is forwarded to stdout (consoleFilter).
      const s = await enterWorld({
        url: gameUrl({ cb: 'sweepb-msgs-relog', env: { ...process.env, AC_ACCOUNT: a.account, AC_PASSWORD: a.account } }),
        consoleFilter: /^\[PlayerDesc\] Vitals/,
      } as never);
      extraBrowsers.push(s.browser);
      A = s.page;
      const atEntry = await ev<{ current: number; max: number }>(A, '({ ...window.__ac.playerState.mana })');
      await shot(A, `${OUT}/vitals-after-relog.png`);
      record('vitals', atEntry.current < atEntry.max && beforeLogout.current < beforeLogout.max,
        { beforeLogout, atEntry });
    }

    if (want('ban')) {
      const reason = 'sweepb probe';
      await b.browser.close();
      await new Promise((r) => setTimeout(r, 10_000));
      await adminCommand(A, `@ban ${b.account} 0 0 5 ${reason}`);
      banned = true;
      await A.waitForTimeout(3000);
      const lines: string[] = [];
      const s = await openSession({ consoleFilter: /AccountBanned|ServerDied/ });
      extraBrowsers.push(s.browser);
      s.page.on('console', (m) => { const t = m.text(); if (/AccountBanned|ServerDied/.test(t)) lines.push(t); });
      await s.page.goto(gameUrl({ cb: 'sweepb-msgs-ban', env: { ...process.env, AC_ACCOUNT: b.account, AC_PASSWORD: b.account } }), { waitUntil: 'domcontentloaded' });
      for (let t = 0; t < 60_000 && !lines.some((l) => /ServerDied/.test(l)); t += 500) await s.page.waitForTimeout(500);
      await s.page.waitForTimeout(1500);
      await shot(s.page, `${OUT}/ban-disconnected.png`);
      const shown = await ev<boolean>(s.page, '!!window.__ac && !!window.__ac.gameUI.disconnectedScreenShown');
      const died = lines.find((l) => /ServerDied/.test(l)) ?? '';
      // The seconds are free: the minute-rounded clock plus ACE's remaining seconds.
      const re = new RegExp(`You have been banned until (Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} [ \\d]\\d \\d{2}:\\d{2}:\\d{2} \\d{4} - ${reason}\\. For ban appeals, please visit support\\.turbine\\.com`);
      record('ban', shown && re.test(died) && !/connection to the server has been lost/i.test(died), { shown, lines });
    }
  } finally {
    if (banned) {
      try { await adminCommand(A, `@unban ${b.account}`); await A.waitForTimeout(2000); console.log(`unbanned ${b.account}`); } catch (e) { console.error(`UNBAN FAILED for ${b.account}: run @unban ${b.account} by hand`, e); }
    }
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    for (const br of extraBrowsers) await br.close().catch(() => {});
    await close();
  }
  if (fails.length) { console.log(`FAILED: ${fails.join(', ')}`); process.exit(1); }
  console.log('ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
