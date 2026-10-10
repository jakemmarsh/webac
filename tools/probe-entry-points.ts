/**
 * probe-entry-points — live checks for the panel entry points the
 * 2026-10-06 entry-point audit put back on retail's path (two clients,
 * A fxprobe1 / B fxprobe2, Holtburg):
 *  chest     open a chest, run the panel's close box handler: the
 *            close is a Use of the chest (gmExternalContainerUI::
 *            CloseCurrentContainer → ItemHolder::UseObject), never
 *            NoLongerViewingContents, and ACE closes it (panel gone, the
 *            chest re-opens on the next use)
 *  vendor    a queued buy + the vendor close box (0x100000d6) asks
 *            "You have not completed all transactions…"; No keeps it open,
 *            Yes closes it
 *  kick      A swears to B; B's allegiance panel Kick asks "Are you sure you
 *            wish to kick <A> from your allegiance?" and Yes releases A
 *            (Event_BreakAllegiance, not BreakAllegianceBoot)
 *  ping      no PingRequest goes out over 40 s with the Link Status panel
 *            closed (gmLinkStatusUI::Update is retail's only ping sender)
 * Writes verification/entry-points/{results.json,*.png}; exits 1 on a failure.
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/probe-entry-points.ts [--only a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot, deleteSpawnsNear } from './lib/game-session.ts';
import { openTwoClients, waitDialog, answerDialog, MEET_LOC } from './lib/two-client.ts';

const OUT = 'verification/entry-points';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const want = (k: string) => !ONLY || ONLY.has(k);
const CHEST_WCID = 143;
const VENDOR = 'Shopkeeper Renald the Elder';
const VENDOR_SPOT = '0xA9B40019 84.3 1.5 94 0.9969 0 0 -0.0785'; // probe-vendor-flow's A/B spot

const ev = <T>(p: Page, js: string): Promise<T> => p.evaluate(js) as Promise<T>;
const findByName = (p: Page, name: string) => ev<number | null>(p, `(() => { for (const o of window.__ac.serverObjectManager.objects.values()) if (o.name === ${JSON.stringify(name)}) return o.guid; return null; })()`);
const findDynamic = (p: Page, wcid: number) => ev<number>(p, `(() => { let g = 0; for (const [k, o] of window.__ac.serverObjectManager.getAllObjects()) if (o.weenieClassId === ${wcid} && (k >>> 0) >= 0x80000000) g = k; return g; })()`);
const click = async (p: Page, id: number) => p.locator(`[data-element-id="0x${id.toString(16)}"]`).first().click({ force: true });

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  const record = (k: string, ok: boolean, detail: unknown) => { results[k] = { ok, detail }; if (!ok) fails.push(k); console.log(`${ok ? 'PASS' : 'FAIL'} ${k}: ${JSON.stringify(detail).slice(0, 500)}`); };
  const { a, b, close } = await openTwoClients('entrypoints');
  const A = a.page;
  const sentA: string[] = [];
  A.on('console', (m) => { const t = m.text(); if (/Sent Use|NoLongerViewing|Ping round-trip|PingRequest/i.test(t)) sentA.push(t.slice(0, 160)); });
  try {
    if (want('ping')) {
      sentA.length = 0;
      await A.waitForTimeout(40_000);
      record('ping', !sentA.some((t) => /Ping/i.test(t)), { lines: sentA.slice() });
    }

    if (want('chest')) {
      await adminCommand(A, `@create ${CHEST_WCID}`);
      await A.waitForTimeout(3500);
      const chest = await findDynamic(A, CHEST_WCID);
      await ev(A, `window.acDebug.useObject(${chest})`);
      for (let t = 0; t < 15_000 && !(await ev<number>(A, 'window.__ac.gameUI.openContainerGuid || 0')); t += 500) await A.waitForTimeout(500);
      const opened = await ev<number>(A, 'window.__ac.gameUI.openContainerGuid || 0');
      await shot(A, `${OUT}/chest-open.png`);
      await A.waitForTimeout(800);
      sentA.length = 0;
      // The close box's handler (the panel sits in the transaction dock).
      await ev(A, 'window.__ac.gameUI.closeContainerPanelFromUi()');
      await A.waitForTimeout(3000);
      const closedSends = sentA.slice();
      const panelGone = !(await ev<number>(A, 'window.__ac.gameUI.openContainerGuid || 0'));
      await ev(A, `window.acDebug.useObject(${chest})`);
      for (let t = 0; t < 10_000 && !(await ev<number>(A, 'window.__ac.gameUI.openContainerGuid || 0')); t += 500) await A.waitForTimeout(500);
      const reopened = !!(await ev<number>(A, 'window.__ac.gameUI.openContainerGuid || 0'));
      if (reopened) await ev(A, 'window.__ac.gameUI.closeContainerPanelFromUi()');
      record('chest', opened === chest && panelGone && reopened && !closedSends.some((t) => /NoLongerViewing/.test(t)),
        { chest: chest.toString(16), opened: opened.toString(16), panelGone, reopened, closedSends });
      await A.waitForTimeout(2000);
    }

    if (want('vendor')) {
      await adminCommand(A, `@teleloc ${VENDOR_SPOT}`, 'talk');
      await A.waitForTimeout(15_000);
      const vendor = await findByName(A, VENDOR);
      if (!vendor) throw new Error(`${VENDOR} not found`);
      await ev(A, `window.acDebug.useObject(${vendor})`);
      for (let t = 0; t < 25_000 && !(await ev<boolean>(A, '!!window.__ac.gameUI.isVendorVisible')); t += 500) await A.waitForTimeout(500);
      await A.waitForTimeout(2000);
      await ev(A, `(() => { const ui = window.__ac.gameUI, d = ui.vendorData, it = d.buyItems.find((i) => i.guid !== undefined);
        d.buyList = [{ guid: it.guid, qty: 1 }]; d.tab = 1; ui.renderVendorPanel(); })()`);
      await A.waitForTimeout(1200);
      await click(A, 0x100000d6);
      const text = await waitDialog(A, 5000);
      await shot(A, `${OUT}/vendor-close-confirm.png`);
      await answerDialog(A, false);
      await A.waitForTimeout(800);
      const stillOpen = await ev<boolean>(A, '!!window.__ac.gameUI.isVendorVisible');
      await click(A, 0x100000d6);
      await waitDialog(A, 5000);
      await answerDialog(A, true);
      await A.waitForTimeout(1200);
      const closedAfterYes = !(await ev<boolean>(A, '!!window.__ac.gameUI.isVendorVisible'));
      record('vendor', text === 'You have not completed all transactions. Are you sure you want to leave this vendor?' && stillOpen && closedAfterYes, { text, stillOpen, closedAfterYes });
      await adminCommand(A, `@teleloc ${MEET_LOC}`);
      await A.waitForTimeout(8000);
      await adminCommand(A, `@teletome ${b.name}`);
      await A.waitForTimeout(8000);
    }

    if (want('kick')) {
      // A swears to B (the panel's Swear on B, answered Yes on B).
      await ev(A, `window.__ac.gameUI.callbacks.onAllegianceSwear(${b.guid})`);
      const swearAsk = await waitDialog(b.page, 10_000);
      await answerDialog(b.page, true);
      await A.waitForTimeout(5000);
      // B opens its allegiance pane, selects A's vassal row, presses Kick.
      await ev(b.page, `(() => { const ui = window.__ac.gameUI; ui.socialTab = 'allegiance'; if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel(); })()`);
      await b.page.waitForTimeout(2500);
      const paneState = await ev(b.page, `(() => { const ui = window.__ac.gameUI, i = ui.allegianceInfo;
        return { visible: ui.socialPanelVisible, tab: ui.socialTab, members: i ? i.members.map((m) => m.name + '@' + (m.parentGuid >>> 0).toString(16)) : null,
          self: i ? (i.selfGuid >>> 0).toString(16) : null, rows: [...document.querySelectorAll('.vassal-row')].map((e) => e.textContent) }; })()`);
      console.log('PANE', JSON.stringify(paneState));
      // The rows draw their names to a canvas; A is B's only vassal, so the first row.
      const rowClicked = await ev<boolean>(b.page, `(() => { const r = document.querySelector('.vassal-row');
        if (!r) return false; r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
      await b.page.waitForTimeout(600);
      await click(b.page, 0x10000265);
      const kickAsk = await waitDialog(b.page, 5000);
      await shot(b.page, `${OUT}/kick-confirm.png`);
      await answerDialog(b.page, true);
      await A.waitForTimeout(5000);
      // B's own allegiance data no longer lists A under B.
      const bVassals = () => ev<string[]>(b.page, `(() => { const i = window.__ac.gameUI.allegianceInfo; return i ? i.members.filter((m) => m.parentGuid === i.selfGuid).map((m) => m.name) : []; })()`);
      let after = await bVassals();
      for (let t = 0; t < 10_000 && after.length; t += 1000) { await b.page.waitForTimeout(1000); after = await bVassals(); }
      if (after.length) await ev(A, `window.__ac.gameUI.callbacks.onAllegianceBreak(${b.guid})`); // leave no allegiance behind
      record('kick', !!rowClicked && !!kickAsk && kickAsk.includes(' from your allegiance?') && after.length === 0,
        { swearAsk, paneState, rowClicked, kickAsk, vassalsAfter: after });
    }
  } finally {
    // Probe hygiene: remove what this probe spawned (it would show up in other sessions' captures).
    await deleteSpawnsNear(A, [CHEST_WCID]).catch(() => 0);
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    await close();
  }
  if (fails.length) { console.log(`FAILED: ${fails.join(', ')}`); process.exit(1); }
  console.log('ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
