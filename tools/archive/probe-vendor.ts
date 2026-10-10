/** Vendor beats via acDebug.useObject (the world context menu is dead — BUG filed). */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=vprobe';
const OUT = '/home/user/acjs/verification/playtest/2026-08-20-vendor';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const cs = (window as any).acDebug?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true, args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  const chat: string[] = [];
  page.on('console', m => { if (/\[AC\]/.test(m.text())) chat.push(m.text().slice(0, 250)); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline && !(await inWorld(page))) await page.waitForTimeout(3000);
  if (!(await inWorld(page))) throw new Error('no world');
  await page.waitForTimeout(8000);

  await page.evaluate(`window.acDebug.tele('0xA9B40100', 84, 127, 66.005)`);
  await page.waitForTimeout(9000);
  const guid = await page.evaluate(`window.acDebug.getObjects().find(o => /Blacksmith/i.test(o.name))?.guid`) as number;
  console.log('blacksmith guid:', guid && '0x' + guid.toString(16));

  await page.evaluate(`window.__ac.useObject(${guid})`);
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    if (await page.evaluate(`window.__ac.gameUI.vendorVisible`)) break;
  }
  const vs = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.vendorVisible) return null;
    const d = ui.vendorData;
    return { name: d.name, buyRate: d.buyRate, sellRate: d.sellRate, alt: d.altCurrencyName,
      buyItems: d.buyItems.slice(0, 30).map(i => ({ n: i.name, p: i.price, w: i.weenieClassId })),
      sellItems: d.sellItems.map(i => ({ n: i.n || i.name, p: i.price })) };
  })()`);
  console.log('vendor:', JSON.stringify(vs, null, 1).slice(0, 1500));
  await page.screenshot({ path: join(OUT, '01-buy-tab.png') });
  if (!vs) { await browser.close(); throw new Error('vendor never opened'); }

  // coins, then buy first item via real DOM clicks
  await page.evaluate(`window.acDebug.sendTalk('@ci 273 5000')`);
  await page.waitForTimeout(4000);
  const coins0 = await page.evaluate(`window.__ac.playerState.inventory.getAll().filter(i => /pyreal/i.test(i.name)).reduce((s, i) => s + (i.stackSize || 1), 0)`);
  const rowClick = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('div')].filter(d => d.style.borderBottom === '1px solid rgba(60, 50, 40, 0.3)');
    if (!rows.length) return 'no-rows';
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked/' + rows.length;
  })()`);
  await page.waitForTimeout(900);
  const buyClick = await page.evaluate(`(() => {
    const btns = [...document.querySelectorAll('div')].filter(d => d.style.width === '64px' && d.style.height === '22px');
    if (!btns.length) return 'no-btn';
    btns[btns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await page.waitForTimeout(4000);
  const coins1 = await page.evaluate(`window.__ac.playerState.inventory.getAll().filter(i => /pyreal/i.test(i.name)).reduce((s, i) => s + (i.stackSize || 1), 0)`);
  const inv1 = await page.evaluate(`window.__ac.playerState.inventory.getAll().map(i => i.name + (i.stackSize > 1 ? ' x' + i.stackSize : ''))`);
  console.log('buy:', rowClick, buyClick, 'coins', coins0, '->', coins1);
  console.log('inv:', JSON.stringify(inv1));
  await page.screenshot({ path: join(OUT, '02-after-buy.png') });

  // sell tab: sell the item we just bought
  const tabClick = await page.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('div')].filter(d => d.style.width === '92px' && d.style.height === '20px');
    if (tabs.length < 2) return 'no-tabs/' + tabs.length;
    tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, '03-sell-tab.png') });
  const sellState = await page.evaluate(`(() => {
    const d = window.__ac.gameUI.vendorData;
    return { tab: d.tab, sellItems: d.sellItems.map(i => ({ n: i.name, p: i.price })) };
  })()`);
  console.log('sell tab:', tabClick, JSON.stringify(sellState).slice(0, 600));
  const sellRow = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('div')].filter(d => d.style.borderBottom === '1px solid rgba(60, 50, 40, 0.3)');
    if (!rows.length) return 'no-rows';
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked/' + rows.length;
  })()`);
  await page.waitForTimeout(900);
  const sellBtn = await page.evaluate(`(() => {
    const btns = [...document.querySelectorAll('div')].filter(d => d.style.width === '64px' && d.style.height === '22px');
    if (!btns.length) return 'no-btn';
    btns[btns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await page.waitForTimeout(4000);
  const coins2 = await page.evaluate(`window.__ac.playerState.inventory.getAll().filter(i => /pyreal/i.test(i.name)).reduce((s, i) => s + (i.stackSize || 1), 0)`);
  console.log('sell:', sellRow, sellBtn, 'coins ->', coins2);
  await page.screenshot({ path: join(OUT, '04-after-sell.png') });
  writeFileSync(join(OUT, 'chat.json'), JSON.stringify(chat.slice(-120), null, 1));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
