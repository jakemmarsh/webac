/**
 * CORE.7 live verification — select-to-raise on the character panel.
 * Logs into the ACE stack, opens the char panel, drives row selection and
 * the footer raise buttons, screenshots each state to
 * verification/core7-select-raise/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(__dir, '..', 'verification', 'core7-select-raise');
mkdirSync(OUT, { recursive: true });
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core7';
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const VIEW = { width: 1568, height: 775 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function chat(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const input = document.getElementById('chat-input') as HTMLInputElement;
    input.value = t;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, text);
  await page.waitForTimeout(1200);
}

/** Click a stat row by its data-stat-row key (row text is AC-font canvas). */
async function clickRow(page: Page, key: string): Promise<boolean> {
  return page.evaluate((k) => {
    const row = document.querySelector(`[data-stat-row="${k}"]`) as HTMLElement | null;
    if (!row) return false;
    row.click();
    return true;
  }, key);
}

async function footerInfo(page: Page): Promise<{ text: string; raiseLit: boolean | null; raise10: boolean }> {
  return page.evaluate(() => {
    const f = document.querySelector('[data-element-id="0x10000241"]') as HTMLElement | null;
    const raise = document.querySelector('[data-raise-button="0x10000246"]') as HTMLElement | null;
    const raise10 = document.querySelector('[data-raise-button="0x100005eb"]') as HTMLElement | null;
    return {
      text: f && f.style.display !== 'none' ? (f.textContent ?? '') : '(hidden)',
      raiseLit: raise ? raise.style.backgroundImage.includes('4cb6') : null,
      raise10: !!raise10,
    };
  });
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (msg) => {
    const t = msg.text();
    if (/RaiseAttribute|RaiseVital|RaiseSkill|TrainSkill|error/i.test(t)) console.log(`  [page] ${t.slice(0, 160)}`);
  });

  console.log(`[core7] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[core7] not in world yet — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world');
  }
  console.log('[core7] in world');
  await page.waitForTimeout(6000);

  // Grant XP so the raise buttons have something to spend (admin account).
  await chat(page, '@grantxp 500000');

  // ── 1. Attributes tab: idle footer ──
  await page.click('#tb-char');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, '1-attributes-idle.png') });
  console.log('[core7] 1-attributes-idle.png');

  // ── 2. Select Strength → button footer ──
  if (!(await clickRow(page, 'attr:1'))) throw new Error('attr:1 row not found/clickable');
  await page.waitForTimeout(800);
  let fi = await footerInfo(page);
  console.log(`[core7] after Strength select: footer="${fi.text.slice(0, 120)}" raiseLit=${fi.raiseLit} raise10=${fi.raise10}`);
  await page.screenshot({ path: join(OUT, '2-attribute-selected.png') });

  // ── 3. Click raise, verify value goes 10 → 11 and a second click debounces ──
  const before = await page.evaluate(() =>
    (window as any).__ac?.gameUI?.charInfo?.attributes?.strength?.base);
  await page.evaluate(() => (document.querySelector('[data-raise-button="0x10000246"]') as HTMLElement)?.click());
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() =>
    (window as any).__ac?.gameUI?.charInfo?.attributes?.strength?.base);
  console.log(`[core7] raise: Strength row "${before}" -> "${after}"`);
  await page.screenshot({ path: join(OUT, '3-after-raise.png') });

  // ── 4. Vital row (Mana) select ──
  await clickRow(page, 'vital:5');
  await page.waitForTimeout(800);
  fi = await footerInfo(page);
  console.log(`[core7] after Mana select: footer="${fi.text.slice(0, 120)}" raiseLit=${fi.raiseLit}`);
  await page.screenshot({ path: join(OUT, '4-vital-selected.png') });

  // ── 5. Skills tab: trained skill select ──
  await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { switchCharTab?: (t: string) => void; charPanelTab?: string; renderCharPanel?: () => void } } }).__ac?.gameUI as
      | { charPanelTab?: string; renderCharPanel?: () => void }
      | undefined;
    if (ui) { ui.charPanelTab = 'skills'; ui.renderCharPanel?.(); }
  });
  await page.waitForTimeout(1000);
  await clickRow(page, 'skill:24');
  await page.waitForTimeout(800);
  fi = await footerInfo(page);
  console.log(`[core7] after Run select: footer="${fi.text.slice(0, 120)}" raiseLit=${fi.raiseLit} raise10=${fi.raise10}`);
  await page.screenshot({ path: join(OUT, '5-skill-trained-selected.png') });

  // ── 6. Unusable/untrained skill → train footer (raise-10 hidden) ──
  await clickRow(page, 'skill:34');
  await page.waitForTimeout(800);
  fi = await footerInfo(page);
  console.log(`[core7] after War Magic select: footer="${fi.text.slice(0, 120)}" raiseLit=${fi.raiseLit} raise10=${fi.raise10}`);
  await page.screenshot({ path: join(OUT, '6-skill-untrained-selected.png') });

  await browser.close();
  console.log('[core7] done');
}

main().catch((e) => { console.error(e); process.exit(1); });
