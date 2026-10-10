/**
 * Live verification for VISUAL.spellbook-rows-show-mana-cost:
 * login → @addspell x3 → open spellbook (P) → screenshot + dump row DOM text.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=vrows';
const VIEW = { width: 1568, height: 775 };
const OUT = join(REPO, 'verification', 'playtest', 'spellbook-rows-2026-08-21');

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

  console.log(`[verify] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
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
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[verify] in world');
  await page.waitForTimeout(8000);

  // grant spells (admin account): Heal Self I (6), Armor Self I (24), Flame Bolt I (27)
  for (const id of [6, 24, 27]) {
    await page.evaluate(`window.acDebug.sendTalk("@addspell ${id}")`);
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
  const spells = await page.evaluate(`(window.__ac.gameUI.knownSpells || []).map(s => ({ id: s.id, name: s.name, manaCost: s.manaCost }))`);
  console.log('[verify] known spells:', JSON.stringify(spells));

  await page.keyboard.press('KeyP');
  await page.waitForTimeout(2500);

  // dump the live spell-list rows exactly as the behavioral test finds them
  const rows = await page.evaluate(`(() => {
    const panel = window.__ac.gameUI.magicPanel;
    if (!panel) return 'no-panel';
    const all = [...panel.querySelectorAll('div')];
    return all.filter(d => d.style.minHeight === '34px' && d.style.cursor === 'pointer')
      .map(d => ({
        text: (d.textContent || '').trim(),
        children: d.children.length,
        childTags: [...d.children].map(c => c.tagName),
        hasMarginLeftAuto: [...d.children].some(c => c.style && c.style.marginLeft === 'auto'),
      }));
  })()`);
  console.log('[verify] live row texts:', JSON.stringify(rows));

  await page.screenshot({ path: join(OUT, 'spellbook-rows-no-mana-cost.png') });
  console.log('[verify] wrote verification/playtest/spellbook-rows-2026-08-21/spellbook-rows-no-mana-cost.png');
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
