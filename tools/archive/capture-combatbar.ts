// Capture the live melee combat bar for CORE.11 verification.
// Usage: npx tsx capture-combatbar.ts <outPrefix>
import { chromium, Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] || '/tmp/combatbar';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 882 };

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(`(() => {
      const ac = window.__ac;
      return !!(ac && ac.gameUI && ac.gameUI.ui && ac.gameUI.ui.currentScreen === 'game');
    })()`) as boolean;
  } catch { return false; }
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

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log('create:', created); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('reload retry');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch {}
      lastReload = Date.now();
    }
    await page.waitForTimeout(2000);
  }
  if (!(await inWorld(page))) { console.log('FAILED: never entered world'); await browser.close(); process.exit(1); }
  console.log('in world');
  await page.waitForTimeout(8000); // let world stream in

  // Enter melee combat mode via debug hook
  await page.evaluate(`window.acDebug && window.acDebug.combatMode ? window.acDebug.combatMode('melee') : (window.__ac && window.__ac.debug && window.__ac.debug.combatMode('melee'))`);
  await page.waitForTimeout(4000);

  const mode = await page.evaluate(`(() => { const ui = window.__ac && window.__ac.gameUI; return ui && ui.hudState ? ui.hudState.combatMode : -1 })()`);
  console.log('combatMode now:', mode);

  await page.screenshot({ path: OUT + '-full.png' });
  console.log('saved', OUT + '-full.png');
  await browser.close();
}
main();
