/**
 * probe-gdle-trade — RELEASE.gdle-untested-surfaces.a: B opens secure trade
 * with A on GDLE; both pages' trade traffic (game events 0x1FD RegisterTrade,
 * 0x1FE OpenTrade, 0x1FF CloseTrade + reason, 0x200 AddToTrade, …) and chat
 * are recorded, then one item is offered and both accept.
 *
 * Usage: AC_BRIDGE=ws://localhost:9092 npx tsx tools/probe-gdle-trade.ts <accountA> <accountB>
 *   (password = account name; both characters should stand together)
 */
import { enterWorld, gameUrl } from './lib/game-session.js';
import type { Page } from 'playwright';

const [accA = 'agentgdagd', accB = 'agentgdbgd'] = process.argv.slice(2);
const urlFor = (acc: string) => `${gameUrl({ cb: `trade-${acc}`, env: { ...process.env, AC_ACCOUNT: acc, AC_PASSWORD: acc } })}&agent`;
const TAP = `(() => { const c = window.__aceConnection || (window.__ac && window.__ac.__aceConnection); window.__tradeLog = [];
  c.on((e) => { if (e.type !== 'message') return; const d = e.data || {}; const ev = d.eventType ?? (d.type === 'direct' ? d.opcode : undefined);
    const b = d.payload ? Array.from(d.payload) : [];
    let item = false; for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0x98 && b[i+1] === 0x09 && b[i+2] === 0x00 && b[i+3] === 0x90) { item = true; break; }
    if (!item && (ev === undefined || ev < 0x1fd || ev > 0x22b)) return;
    if (item) { window.__tradeLog.push({ item: true, type: d.type, op: (d.opcode ?? 0).toString(16), ev: ev !== undefined ? ev.toString(16) : '', hex: b.slice(0, 48).map((x) => x.toString(16).padStart(2, '0')).join(' ') }); return; }
    window.__tradeLog.push({ ev: ev.toString(16), hex: b.slice(0, 32).map((x) => x.toString(16).padStart(2, '0')).join(' ') }); }); return 'tapped'; })()`;
const call = (p: Page, js: string) => p.evaluate(js);

async function main(): Promise<void> {
  const a = await enterWorld({ url: urlFor(accA) } as never);
  const b = await enterWorld({ url: urlFor(accB) } as never);
  await Promise.all([a.page.waitForTimeout(5000), b.page.waitForTimeout(5000)]);
  console.log(await call(a.page, TAP), await call(b.page, TAP));
  const lines: string[] = [];
  for (const [n, p] of [['A', a.page], ['B', b.page]] as const) p.on('console', (m) => { if (/trade|Trade|90000994|Inventory|Contain|Pickup|InstanceID|Unhandled/i.test(m.text())) lines.push(`${n} ${m.text().slice(0, 240)}`); });
  console.log('B use A:', JSON.stringify(await call(b.page, `window.__acAgent.use('Claude Gda')`)));
  await b.page.waitForTimeout(8000);
  console.log('A trade view:', JSON.stringify(await call(a.page, `window.__acAgent.trade('view')`)));
  console.log('B trade view:', JSON.stringify(await call(b.page, `window.__acAgent.trade('view')`)));
  const has = (p: Page, name: string) => call(p, `JSON.stringify(window.__acAgent.inventory()).split(${JSON.stringify(name)}).length - 1`);
  console.log('before: A Gems', await has(a.page, 'Gem Template'), '| B Gems', await has(b.page, 'Gem Template'));
  console.log('B add:', JSON.stringify(await call(b.page, `window.__acAgent.trade('add', 'Gem Template')`)));
  await b.page.waitForTimeout(2000);
  console.log('A view:', JSON.stringify(await call(a.page, `window.__acAgent.trade('view')`)));
  console.log('A accept:', JSON.stringify(await call(a.page, `window.__acAgent.trade('accept')`)));
  await a.page.waitForTimeout(1500);
  console.log('B accept:', JSON.stringify(await call(b.page, `window.__acAgent.trade('accept')`)));
  await b.page.waitForTimeout(5000);
  console.log('after: A Gems', await has(a.page, 'Gem Template'), '| B Gems', await has(b.page, 'Gem Template'));
  console.log('A view:', JSON.stringify(await call(a.page, `window.__acAgent.trade('view')`)));
  await a.page.screenshot({ path: process.env.TRADE_SHOT ?? 'verification/gdle-trade/after.png' }).catch(() => {});
  console.log('A events:', JSON.stringify(await call(a.page, 'window.__tradeLog')));
  console.log('B events:', JSON.stringify(await call(b.page, 'window.__tradeLog')));
  console.log('B chat:', JSON.stringify(await call(b.page, `window.__acAgent.observe({}).chat ?? null`)));
  for (const l of lines) console.log(' ', l);
  await b.browser.close();
  await a.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
