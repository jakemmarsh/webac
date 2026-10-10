/**
 * CORE.5.c.a close verification: exact filed scenario — server-persisted
 * magicPanelTab=components at login, open panel, click [data-magic-tab=spells].
 * Also checks for a late server-options-echo reverting the tab, and captures
 * both page states.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=c5ca';
const VIEW = { width: 1568, height: 775 };
const OUT = join(REPO, 'verification', 'playtest', 'core5ca-magic-tab');

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function enterWorld(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[verify] create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[verify] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* loop */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  console.log(`[verify] session 1: navigating`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await enterWorld(page);
  console.log('[verify] in world');
  await page.waitForTimeout(8000);

  // Session 1: open panel, switch to components, wait for any server echo.
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(2500);
  const t0 = await page.evaluate(`window.__ac.gameUI.magicPanelTab`);
  if (t0 !== 'components') {
    await page.click('[data-magic-tab=components]');
    await page.waitForTimeout(1000);
  }
  const t1 = await page.evaluate(`window.__ac.gameUI.magicPanelTab`);
  await page.waitForTimeout(8000); // late server options echo window
  const t1b = await page.evaluate(`window.__ac.gameUI.magicPanelTab`);
  console.log(`[verify] session1: start=${t0} afterClick=${t1} after8s=${t1b} (echo-revert check: ${t1 === t1b ? 'PASS' : 'FAIL'})`);
  await page.screenshot({ path: join(OUT, 'session1-components.png') });

  // Session 2: fresh login — persisted tab must be components; click spells.
  console.log('[verify] session 2: reload for persisted-tab scenario');
  await page.goto(URL.replace('cb=c5ca', 'cb=c5ca2'), { waitUntil: 'domcontentloaded' });
  await enterWorld(page);
  await page.waitForTimeout(8000);
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(2500);
  const t2 = await page.evaluate(`window.__ac.gameUI.magicPanelTab`);
  console.log(`[verify] session2: persisted tab at open = ${t2} (expect components)`);
  await page.screenshot({ path: join(OUT, 'session2-persisted-components.png') });

  await page.click('[data-magic-tab=spells]');
  await page.waitForTimeout(1500);
  const t3 = await page.evaluate(`window.__ac.gameUI.magicPanelTab`);
  await page.waitForTimeout(6000);
  const t3b = await page.evaluate(`window.__ac.gameUI.magicPanelTab`);
  console.log(`[verify] session2: after clicking spells = ${t3}, after 6s = ${t3b}`);
  await page.screenshot({ path: join(OUT, 'session2-clicked-spells.png') });

  const pass = t1 === 'components' && t1b === 'components' && t2 === 'components' && t3 === 'spells' && t3b === 'spells';
  console.log(`[verify] VERDICT: ${pass ? 'PASS — filed scenario works end-to-end' : 'FAIL — see states above'}`);
  await browser.close();
  if (!pass) process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
