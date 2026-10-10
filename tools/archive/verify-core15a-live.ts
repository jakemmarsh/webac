/** CORE.15.a live verification — contracts + page-list header sort buttons. */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core15a';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core15a';

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 200)}`));

  console.log('[core15a] navigating');
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
    const created = await page.evaluate(`(() => {
      const ui = window.__ac && window.__ac.gameUI;
      if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
      if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
      ui.wizard.name = 'Perf Tester';
      ui.callbacks.onCharacterCreated(ui.wizard);
      return 'sent';
    })()`).catch(() => 'eval-failed');
    if (created === 'sent') console.log('[core15a] drove character creation');
    if (Date.now() - lastReload > 60_000) {
      console.log('[core15a] not in world — reload (phantom retry)');
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
  console.log('[core15a] in world');
  await page.waitForTimeout(6000);

  await page.keyboard.press('q');
  await page.waitForTimeout(1200);

  // Seed sortable contracts through the real setContractData path.
  await page.evaluate(() => {
    const w = window as unknown as { __ac?: { gameUI?: { setContractData?: (d: unknown) => void } } };
    w.__ac?.gameUI?.setContractData?.({
      contracts: [
        { id: 1, name: 'Zury Errand', description: 'd', timer: '', status: 'In Progress', stage: 2, repeatsSec: 0 },
        { id: 2, name: 'apple Run', description: 'd', timer: 'Repeats in 8m 20s', status: 'Pending Repeat', stage: 3, repeatsSec: 500 },
        { id: 3, name: 'Mule Duty', description: 'd', timer: 'Repeats in 1m 40s', status: 'Pending Repeat', stage: 3, repeatsSec: 100 },
      ],
      journal: [],
    });
  });
  await page.waitForTimeout(600);

  const rowNames = async (): Promise<string[]> => page.evaluate(() =>
    [...document.querySelectorAll('[data-element-id="0x100005cf"] [data-row-name]')]
      .map(r => (r as HTMLElement).dataset.rowName ?? ''));

  console.log('[core15a] default (name asc):', await rowNames());
  await page.screenshot({ path: `${OUT}/01-contracts-name-asc.png` });

  const clickHeader = async (id: string): Promise<void> => {
    await page.evaluate((eid) => (document.querySelector(`[data-element-id="${eid}"]`) as HTMLElement | null)?.click(), id);
    await page.waitForTimeout(600);
  };

  await clickHeader('0x100005d6');
  console.log('[core15a] status asc:', await rowNames());
  await page.screenshot({ path: `${OUT}/02-contracts-status-asc.png` });
  await clickHeader('0x100005d6');
  console.log('[core15a] status desc:', await rowNames());
  await page.screenshot({ path: `${OUT}/03-contracts-status-desc.png` });
  await clickHeader('0x100005ce');
  console.log('[core15a] back to name asc:', await rowNames());

  // Page List tab with seeded journal pages.
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui = (window as any).__ac?.gameUI;
    if (!ui) return;
    ui.journalLoaded = true;
    ui.journalPages = [
      { title: 'omega', label: 'b', notes: '', location: '', timerEndMs: null },
      { title: 'Acorn', label: 'C', notes: '', location: '', timerEndMs: Date.now() + 90 * 60_000 },
      { title: 'mid', label: 'a', notes: '', location: '', timerEndMs: null },
    ];
    (document.querySelector('[data-contract-tab="page_list"]') as HTMLElement | null)?.click();
  });
  await page.waitForTimeout(800);

  const pageIdxs = async (): Promise<string[]> => page.evaluate(() =>
    [...document.querySelectorAll('.page-list-row')].map(r => (r as HTMLElement).dataset.pageIdx ?? ''));

  console.log('[core15a] pages default (# asc):', await pageIdxs());
  await page.screenshot({ path: `${OUT}/04-pages-number-asc.png` });
  await clickHeader('0x10000580');
  console.log('[core15a] pages title asc:', await pageIdxs());
  await page.screenshot({ path: `${OUT}/05-pages-title-asc.png` });
  await clickHeader('0x10000581');
  console.log('[core15a] pages timer (running first):', await pageIdxs());
  await page.screenshot({ path: `${OUT}/06-pages-timer.png` });

  await browser.close();
  console.log('[core15a] done');
}

run().catch((err) => { console.error(err); process.exit(1); });
