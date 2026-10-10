/**
 * playtest-fellowship-full-update-tail — live check for
 * RECON.wire-full-consumption: a real ACE FellowshipFullUpdate (0x02BE) is
 * parsed through its DepartedMembers + FellowshipLocks tables with nothing
 * left over, and the fellowship panel still fills.
 *
 * Beats: enter world → open the social panel → create a fellowship through
 * the Create button's callback → read gameUI.fellowshipData (departedMembers and
 * fellowshipLocks present, no parser warnings) → screenshot → /fellow quit.
 *
 * Output: verification/playtest/<utc>-fellowship-full-update-tail/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, enterWorld, readAc, waitFor, chatLine } from '../lib/game-session.ts';

const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-fellowship-full-update-tail`);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'fellowtail', settleMs: 8_000 });
  const parserLines: string[] = [];
  page.on('console', m => { const t = m.text(); if (/parseFellowship|Fellowship:/.test(t)) parserLines.push(`${m.type()}: ${t}`); });
  try {
    await readAc(page, `ac.gameUI.fellowshipData ? ac.gameUI.callbacks.onChatSend('/fellow quit') : null`);
    await page.waitForTimeout(2_000);
    await readAc(page, `ac.gameUI.toggleSocialPanel()`);
    await page.waitForTimeout(1_000);
    // The fellowship pane's Create button fires this callback
    // (gmFellowshipUI::CreateFellowship → CM_Fellowship::Event_Create).
    const clicked = await readAc<string>(page, `(ac.gameUI.callbacks.onCreateFellowship ? (ac.gameUI.callbacks.onCreateFellowship('TailCheck'), 'clicked') : 'no-callback')`);
    const got = await waitFor(page, '!!(window.__ac.gameUI.fellowshipData)', { timeoutMs: 20_000 });
    const data = await readAc<Record<string, unknown>>(page, `(() => {
      const d = ac.gameUI.fellowshipData;
      if (!d) return null;
      return {
        name: d.fellowshipName, fellows: d.fellows.map(f => f.name), tableSize: d.tableSize,
        departedIsMap: d.departedMembers instanceof Map, departed: d.departedMembers ? [...d.departedMembers] : null,
        locksIsMap: d.fellowshipLocks instanceof Map, locks: d.fellowshipLocks ? [...d.fellowshipLocks.keys()] : null,
      };
    })()`);
    await page.screenshot({ path: join(OUT, 'fellowship-panel.png') });
    const warnings = parserLines.filter(l => /trailing byte|malformed|Parse error/.test(l));
    const ok = clicked === 'clicked' && got && !!data && data.departedIsMap === true && data.locksIsMap === true && warnings.length === 0;
    const report = { ok, clicked, got, data, parserLines, warnings };
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await chatLine(page, '/fellow quit');
    await page.waitForTimeout(2_000);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(e => { console.error(e); process.exit(1); });
