/** CORE.15.b live verification — journal timer states (Start/Reset labels,
 *  DeltaTimeToString countdown, "Ready" at expiry, page-list "None"). */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core15b';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core15b';

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

  console.log('[core15b] navigating');
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
    if (created === 'sent') console.log('[core15b] drove character creation');
    if (Date.now() - lastReload > 60_000) {
      console.log('[core15b] not in world — reload (phantom retry)');
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
  console.log('[core15b] in world');
  await page.waitForTimeout(6000);

  await page.keyboard.press('q');
  await page.waitForTimeout(1200);
  await page.evaluate(() => (document.querySelector('[data-contract-tab="journal"]') as HTMLElement | null)?.click());
  await page.waitForTimeout(800);

  const timerState = async (): Promise<Record<string, string>> => page.evaluate(`(() => {
    const countdown = document.querySelector('[data-element-id="0x1000057c"]');
    const btn = document.querySelector('[data-element-id="0x1000057d"]');
    const dBox = document.querySelector('[data-element-id="0x10000576"]');
    return {
      countdownText: countdown ? countdown.textContent : '',
      countdownVisible: String(!!countdown && countdown.style.display !== 'none'),
      buttonLabel: btn ? btn.textContent : '',
      editRowVisible: String(!!dBox && dBox.style.display !== 'none'),
    };
  })()`) as Promise<Record<string, string>>;

  // 1) editable (idle) state
  console.log('[core15b] idle state:', await timerState());
  await page.screenshot({ path: `${OUT}/01-idle-start.png` });

  // 2) type 1 into the minutes box, click Start → running countdown
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.journal-timer-input')] as HTMLInputElement[];
    if (inputs[2]) { inputs[2].value = '1'; inputs[2].dispatchEvent(new Event('input', { bubbles: true })); }
    (document.querySelector('[data-element-id="0x1000057d"]') as HTMLElement | null)?.click();
  });
  await page.waitForTimeout(2500);
  console.log('[core15b] running state:', await timerState());
  await page.screenshot({ path: `${OUT}/02-running-countdown.png` });

  // 3) page-list Timer column while running + a second idle page → "None"
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui = (window as any).__ac?.gameUI;
    if (ui) {
      ui.journalPages.push({ title: 'second page', label: '', notes: '', location: '', timerEndMs: null });
      ui.saveJournalPages();
    }
    (document.querySelector('[data-contract-tab="page_list"]') as HTMLElement | null)?.click();
  });
  await page.waitForTimeout(800);
  const listTimers = async (): Promise<string[]> => page.evaluate(() =>
    [...document.querySelectorAll('.page-list-row')].map(r => (r as HTMLElement).textContent ?? ''));
  console.log('[core15b] page-list rows (running + None):', await listTimers());
  await page.screenshot({ path: `${OUT}/03-pagelist-running-and-none.png` });

  // 4) wait out the timer → back to journal tab: "Ready" + Reset (stays running)
  console.log('[core15b] waiting for expiry (~65s)…');
  await page.waitForTimeout(65_000);
  await page.evaluate(() => (document.querySelector('[data-contract-tab="journal"]') as HTMLElement | null)?.click());
  await page.waitForTimeout(800);
  console.log('[core15b] expired state (expect Ready/Reset):', await timerState());
  await page.screenshot({ path: `${OUT}/04-expired-ready.png` });

  // 5) Reset → editable again
  await page.evaluate(() => (document.querySelector('[data-element-id="0x1000057d"]') as HTMLElement | null)?.click());
  await page.waitForTimeout(600);
  console.log('[core15b] after Reset:', await timerState());
  await page.screenshot({ path: `${OUT}/05-after-reset-idle.png` });

  // 6) Start with zeros → immediate "Ready" running state
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.journal-timer-input')] as HTMLInputElement[];
    for (const i of inputs) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }
    (document.querySelector('[data-element-id="0x1000057d"]') as HTMLElement | null)?.click();
  });
  await page.waitForTimeout(1500);
  console.log('[core15b] zero-start (expect Ready/Reset):', await timerState());
  await page.screenshot({ path: `${OUT}/06-zero-start-ready.png` });

  await browser.close();
  console.log('[core15b] done');
}

run().catch((err) => { console.error(err); process.exit(1); });
