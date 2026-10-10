/**
 * GAP.calendar-date-vs-retail live probe: enter the world, open the World
 * panel (Map tab) and check its Date/Time block against retail GameTime on
 * the server-synced clock, recomputed here from the DAT GameTime the client
 * holds. Prints both readings and saves a panel screenshot.
 *
 *   npx tsx tools/probe-calendar-date.ts [--out verification/calendar-date]
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { enterWorld, sessionArgs, REPO } from './lib/game-session.js';
import { calendarFromClock, formatCalendarDate, formatCalendarTime } from '../packages/renderer/src/derethTime.js';
import { RegionDesc, DatReader, DatDatabase } from '../packages/dat-parser/src/index.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';

const outArg = process.argv.indexOf('--out');
const OUT = resolve(REPO, outArg > -1 ? process.argv[outArg + 1] : 'verification/calendar-date');
mkdirSync(OUT, { recursive: true });

const gameTime = new RegionDesc(new DatReader(new DatDatabase(new FileDatBytes(resolve(REPO, 'dat/client_portal.dat'))).getFileData(0x13000000)!)).gameTime;
const { browser, page } = await enterWorld({ ...sessionArgs(), cb: 'calendar-date', settleMs: 25_000 } as never);
try {
  const read = (): Promise<{ text: string; clock: number | null; at: string }> => page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.mapPanelVisible) ui.toggleMapPanel();
    const block = [...ui.mapPanel.querySelectorAll('div')].find(d =>
      d.style.left === '21px' && d.style.top === '4px' && d.style.width === '227px' && d.style.height === '30px' && d.style.display === 'flex');
    const label = (el) => [...el.querySelectorAll('[data-ac-run-text]')].map(c => c.dataset.acRunText).join(' | ') || ('(html) ' + el.outerHTML.slice(0, 300));
    return { text: block ? label(block) : '(no block)', clock: window.acDebug.timeOfDay().gameClock, at: new Date().toISOString() };
  })()`);
  const r = await read();
  const cal = r.clock === null ? null : calendarFromClock(r.clock, gameTime);
  const expected = cal ? `${formatCalendarDate(cal, gameTime)} | ${formatCalendarTime(cal, gameTime)}` : '(no server clock yet)';
  console.log(`[calendar] at ${r.at} server clock ${r.clock}`);
  console.log(`[calendar] panel:    ${r.text}`);
  console.log(`[calendar] expected: ${expected}`);
  const ok = r.text === expected;
  console.log(`[calendar] ${ok ? 'MATCH' : 'MISMATCH'}`);
  const box = await page.evaluate(`(() => { const r = window.__ac.gameUI.mapPanel.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`) as { x: number; y: number; width: number; height: number };
  await page.screenshot({ path: resolve(OUT, 'map-panel-ours.png'), clip: box });
  await page.screenshot({ path: resolve(OUT, 'scene-ours.png') });
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
