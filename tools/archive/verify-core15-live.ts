/** CORE.15 live verification — contracts panel docked, tabs, close X. */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core15';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core15';

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('console', (msg) => {
    const t = msg.text();
    if (/\[AC\]|error|Error/.test(t)) console.log(`  [page] ${t.slice(0, 140)}`);
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 200)}`));

  console.log('[core15] navigating');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const inWorld = async (): Promise<boolean> => page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  }).catch(() => false);

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld()) break;
    // Virgin account parks at char-create — drive the wizard's submit path
    // (same recipe as tools/measure-perf.ts driveCharacterCreate).
    const created = await page.evaluate(`(() => {
      const ui = window.__ac && window.__ac.gameUI;
      if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
      if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
      ui.wizard.name = 'Perf Tester';
      ui.callbacks.onCharacterCreated(ui.wizard);
      return 'sent';
    })()`).catch(() => 'eval-failed');
    if (created === 'sent') console.log('[core15] drove character creation');
    if (Date.now() - lastReload > 60_000) {
      console.log('[core15] not in world — reload (phantom retry)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld())) {
    await page.screenshot({ path: `${OUT}/_login-failed.png` });
    await browser.close();
    throw new Error('never entered world — see _login-failed.png');
  }
  console.log('[core15] in world');
  await page.waitForTimeout(8000);

  // 1. Press Q → contracts panel docked (live server data, likely empty).
  await page.keyboard.press('q');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/01-contracts-empty.png` });
  const dockInfo = await page.evaluate(() => {
    const tab = document.querySelector('[data-contract-tab="contracts"]') as HTMLElement | null;
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    const tabs = [...document.querySelectorAll('[data-contract-tab]')].map(e => (e as HTMLElement).dataset.contractTab);
    return { x: r.x, y: r.y, tabs };
  });
  console.log('[core15] dock info:', JSON.stringify(dockInfo));

  // 2. Seed sample contract data through the real setContractData path.
  await page.evaluate(() => {
    const w = window as unknown as { __ac?: { gameUI?: { setContractData?: (d: unknown) => void } } };
    w.__ac?.gameUI?.setContractData?.({
      contracts: [
        { id: 100, name: 'The Reign of Terror', description: 'Speak to Fiun Luuk.\nRecover the stolen idol.', timer: 'Done in 2h 10m', status: 'In Progress', contact: 'Fiun Luuk', contactLoc: '61.9N, 12.4E', questLoc: '13.9S, 51.9E' },
        { id: 101, name: 'Glenden Wood Rescue', description: 'd', timer: '', status: 'Done', contact: 'Bela iv Chorbas', contactLoc: '31.0N, 26.4E', questLoc: '' },
      ],
      journal: [],
    });
  });
  await page.waitForTimeout(600);
  // select the first row
  await page.evaluate(() => (document.querySelector('.contract-row') as HTMLElement | null)?.click());
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/02-contracts-selected.png` });

  // 3. Journal tab.
  await page.evaluate(() => (document.querySelector('[data-contract-tab="journal"]') as HTMLElement | null)?.click());
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/03-journal.png` });

  // 4. Page List tab.
  await page.evaluate(() => (document.querySelector('[data-contract-tab="page_list"]') as HTMLElement | null)?.click());
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/04-page-list.png` });

  // 5. Close X — panel must disappear.
  const closed = await page.evaluate(() => {
    const el = document.querySelector('[data-element-id="0x10000562"]') as HTMLElement | null;
    if (!el) return 'close button not found';
    el.click();
    return 'clicked';
  });
  await page.waitForTimeout(800);
  const panelGone = await page.evaluate(() => !document.querySelector('[data-contract-tab]'));
  console.log(`[core15] close: ${closed}, panel gone: ${panelGone}`);
  await page.screenshot({ path: `${OUT}/05-closed.png` });

  // 6. Q again reopens.
  await page.keyboard.press('q');
  await page.waitForTimeout(1000);
  const reopened = await page.evaluate(() => !!document.querySelector('[data-contract-tab]'));
  console.log(`[core15] reopened via Q: ${reopened}`);

  await browser.close();
  console.log('[core15] done');
}

run().catch((e) => { console.error(e); process.exit(1); });
