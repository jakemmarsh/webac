/**
 * BUG.second-tab-login-refusal, live (docs/verification-workflows.md, "A second tab and 'Player already
 * logged on'"). Two tabs of ONE browser profile against the local GDLE (tools/gdle/start-gdle.sh + a bridge
 * on GDLE_BRIDGE): tab A enters the world on ACCOUNT (which must already have a character: probe-flow.ts
 * `login create:<Name>` first), then tab B logs in to the same account. GDLE refuses B with
 * STR_LOGIN_ACCOUNT_ONLINE; B must offer to log out A, A must stay in until the answer, and on Yes A logs
 * out and B gets the character list. ANSWER=no checks the No path (A stays, B back at the launcher).
 * Headless SwiftShader, one browser, deleted at exit.
 *
 *   GDLE_BASE=http://localhost:<vite>/ ACCOUNT=<acct> [ANSWER=yes|no] npx tsx tools/gdle/probe-second-tab-login.ts
 */
import { launchBrowser, waitFor, IN_WORLD_JS, AT_CHAR_SELECT_JS, DEFAULT_VIEWPORT } from '../lib/game-session.js';
import { dialogText, answerDialog } from '../lib/two-client.js';

const account = process.env.ACCOUNT!;
const answerYes = (process.env.ANSWER ?? 'yes') !== 'no';
const base = `${process.env.GDLE_BASE ?? 'http://localhost:3000/'}?ace&bridge=${process.env.GDLE_BRIDGE ?? 'ws://localhost:9092'}&account=${account}&password=${account}`;
const t0 = Date.now();
const log = (s: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: DEFAULT_VIEWPORT }); // one profile: the tabs share BroadcastChannel
const a = await ctx.newPage();
const b = await ctx.newPage();
for (const p of [a, b]) { p.setDefaultTimeout(60_000); p.on('dialog', (d) => void d.dismiss()); }
const lines: Record<'A' | 'B', string[]> = { A: [], B: [] };
for (const [label, p] of [['A', a], ['B', b]] as const) {
  p.on('console', (m) => {
    const t = m.text();
    lines[label].push(t);
    if (/logged|already|holder|login_held|another tab|Got character list|PlayerCreate|Disconnected|LoginHolder/i.test(t)) log(`${label} | ${t.slice(0, 220)}`);
  });
}
let ok = true;
const check = (cond: boolean, what: string) => { log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) ok = false; };
try {
  await a.goto(`${base}&cb=a${Date.now()}`, { waitUntil: 'commit' });
  check(await waitFor(a, IN_WORLD_JS, { timeoutMs: 150_000, reloadEveryMs: 0 }), 'tab A in the world');
  await a.waitForTimeout(3000);

  await b.bringToFront();
  await b.goto(`${base}&autoenter=false&cb=b${Date.now()}`, { waitUntil: 'commit' });
  let offer: string | null = null;
  for (let i = 0; i < 300 && offer === null; i++) { offer = await dialogText(b).catch(() => null); if (offer === null) await b.waitForTimeout(400); }
  log(`B dialog: ${JSON.stringify(offer)}`);
  check(!!offer && /another tab of this browser/i.test(offer), 'B offers to log out the other tab');
  check(await a.evaluate(IN_WORLD_JS) as boolean, 'A still in the world while B asks');
  await b.bringToFront();
  check(await answerDialog(b, answerYes), `B answered ${answerYes ? 'Yes' : 'No'}`);

  if (answerYes) {
    check(await waitFor(b, AT_CHAR_SELECT_JS, { timeoutMs: 60_000, reloadEveryMs: 0 }), 'B reached character select');
    const aText = await a.evaluate(`document.body.innerText`) as string;
    const aLines = lines.A.join('\n');
    check(!(await a.evaluate(IN_WORLD_JS) as boolean) || /logged out/i.test(aText + aLines), 'A logged out');
    log(`A screen text: ${aText.replace(/\s+/g, ' ').slice(0, 300)}`);
  } else {
    await b.waitForTimeout(4000);
    check(await a.evaluate(IN_WORLD_JS) as boolean, 'A still in the world after No');
    log(`B screen text: ${(await b.evaluate(`document.body.innerText`) as string).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
} catch (e) {
  log(`ERROR ${e}`); ok = false;
} finally {
  await browser.close().catch(() => {});
}
if (!ok) for (const l of ['A', 'B'] as const) { log(`--- last ${l} console lines`); for (const t of lines[l].slice(-25)) console.log(`  ${l} ${t.slice(0, 200)}`); }
log(ok ? 'RESULT PASS' : 'RESULT FAIL');
process.exit(ok ? 0 : 1);
