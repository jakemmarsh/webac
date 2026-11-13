/**
 * probe-beforeunload-chargen — does a `beforeunload` that doesn't unload the page leave chargen on a dead session?
 * (BUG.beforeunload-silent-disconnect, 2026-11-12 22:05Z: an AC1999 player's socket closed on the chargen skills
 * step with no reconnect; FINISH then timed out.) Opens character select on a characterless account, opens Create
 * Character, fires a `beforeunload` the page survives (as an extension's "Leave site?" answered Stay does), waits,
 * and reports whether the connection is up / a resume ran, plus the reporter's screen sample.
 * Usage: AC_BASE=http://localhost:5391/ AC_BRIDGE=ws://localhost:9312 AC_ACCOUNT=bupr99a \
 *   AC_EXTRA=era=ac1999-retail npx tsx tools/probe-beforeunload-chargen.ts
 */
import { openSession, gameUrl, sessionArgs, waitForCharSelect } from './lib/game-session.js';

const OUT = process.env.OUT ?? '/tmp/beforeunload-chargen';

async function main(): Promise<void> {
  const { browser, page } = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  try {
    const extra = process.env.AC_EXTRA ? `&${process.env.AC_EXTRA}` : '';
    await page.goto(`${gameUrl({ autoenter: false, cb: 'beforeunload' })}${extra}`, { waitUntil: 'domcontentloaded' });
    await waitForCharSelect(page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
    await page.waitForTimeout(2000);
    await page.evaluate(`window.__ac.gameUI.showCharacterCreate()`);
    await page.waitForTimeout(4000);
    const state = `(() => { const c = window.__aceConnection; return {
      connected: c ? (c.isConnected ?? null) : 'no handle',
      screen: document.body.dataset.screen ?? null,
      resuming: window.__ac.sessionLifecycle?.resuming ?? null,
    }; })()`;
    console.log('before:', JSON.stringify(await page.evaluate(state)));
    await page.evaluate(`window.dispatchEvent(new Event('beforeunload', { cancelable: true }))`);
    await page.waitForTimeout(12_000);
    console.log('after 12 s:', JSON.stringify(await page.evaluate(state)));
    await page.screenshot({ path: `${OUT}.png` });
    console.log(`screenshot ${OUT}.png`);
    // A real tab close must still end the session cleanly (pagehide → disconnect: the bridge logs browserQuietMs ≈ 1).
    console.log(`closing the tab at ${new Date().toISOString()}`);
    await page.close();
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
