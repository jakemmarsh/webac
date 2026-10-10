/**
 * CORE.3.e live verification — proportional chat scrollbar thumb (p130 +
 * p137=16, UIElement_Scrollbar::UpdateLayout @ 004710d0) and floaty-window
 * whole-window opacity (ChatInterface::SetOpacity @ 004f3120), driven
 * against the running ACE stack.
 *
 * Usage: npx tsx tools/verify-core3e-live.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core3e';
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'screens', 'core3e');

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
      const cs = dbg?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
  } catch { return false; }
}
function drive(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Chat Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}
async function waitForWorld(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      let created = 'not-at-create';
      try { created = await drive(page); } catch { /* nav mid-probe */ }
      if (created !== 'not-at-create') { createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world');
}

/** Probe a scrollbar column: thumb geometry + viewport metrics. */
const probeBar = `((sel) => {
  const col = document.querySelector(sel);
  if (!col) return null;
  const thumb = col.querySelector('[data-chat-thumb="1"]');
  return {
    colH: col.clientHeight,
    thumbH: thumb ? parseInt(thumb.style.height) : null,
    thumbTop: thumb ? parseInt(thumb.style.top) : null,
    midH: thumb && thumb.children[1] ? parseInt(thumb.children[1].style.height) : null,
  };
})`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[core3e] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core3e] in world — settling…');
  await page.waitForTimeout(10_000);

  // ── 1. Open floaty window 1 — empty log → thumb fills the whole track ──
  await page.evaluate(`(() => {
    const btn = document.querySelector('[data-element-id="0x10000522"]');
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await page.waitForTimeout(600);
  const floatySel = '[data-floaty-chat="1"] [data-element-id="0x10000012"]';
  const emptyFloaty = await page.evaluate(`(${probeBar})('${floatySel}')`);
  console.log('[core3e] floaty bar (empty log):', JSON.stringify(emptyFloaty));

  // Whole-window opacity probe: unfocused → inactive (default 40%).
  const opacityUnfocused = await page.evaluate(`(() => {
    const p = document.querySelector('[data-floaty-chat="1"]');
    return p ? p.style.opacity : null;
  })()`);
  console.log('[core3e] floaty opacity unfocused:', opacityUnfocused);
  await page.screenshot({ path: join(OUT, '01-floaty-empty-unfocused.png'), clip: { x: 0, y: 0, width: 500, height: 400 } });

  // ── 2. Focus the floaty entry → active opacity on the WHOLE window ──
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-floaty-chat="1"] input');
    if (input) input.focus();
  })()`);
  await page.waitForTimeout(300);
  const opacityFocused = await page.evaluate(`(() => {
    const p = document.querySelector('[data-floaty-chat="1"]');
    return p ? p.style.opacity : null;
  })()`);
  console.log('[core3e] floaty opacity entry-focused:', opacityFocused);
  await page.screenshot({ path: join(OUT, '02-floaty-entry-focused.png'), clip: { x: 0, y: 0, width: 500, height: 400 } });
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-floaty-chat="1"] input');
    if (input) input.blur();
  })()`);
  await page.waitForTimeout(300);

  // ── 3. Main chat bar — fill the log, watch the thumb shrink ──
  const mainSel = '[data-element-id="0x10000012"]:not([data-floaty-chat] *)';
  const mainBefore = await page.evaluate(`(${probeBar})('${mainSel}')`);
  console.log('[core3e] main bar before fill:', JSON.stringify(mainBefore));
  await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    for (let i = 0; i < 8; i++) ui.addSystemMessage('Proportional thumb probe line ' + i);
  })()`);
  await page.waitForTimeout(400);
  const mainMid = await page.evaluate(`(${probeBar})('${mainSel}')`);
  console.log('[core3e] main bar after 8 lines:', JSON.stringify(mainMid));
  await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    for (let i = 8; i < 60; i++) ui.addSystemMessage('Proportional thumb probe line ' + i);
  })()`);
  await page.waitForTimeout(400);
  const mainFull = await page.evaluate(`(${probeBar})('${mainSel}')`);
  console.log('[core3e] main bar after 60 lines:', JSON.stringify(mainFull));
  await page.screenshot({ path: join(OUT, '03-main-bar-full-log.png'), clip: { x: 0, y: VIEW.height - 130, width: 800, height: 130 } });

  // ── 4. Floaty log filled via /say routing ──
  await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    for (let i = 0; i < 40; i++) ui.addChatMessage('Chat Tester', 'floaty fill line ' + i, undefined, 2);
  })()`);
  await page.waitForTimeout(400);
  const floatyFull = await page.evaluate(`(${probeBar})('${floatySel}')`);
  console.log('[core3e] floaty bar after 40 speech lines:', JSON.stringify(floatyFull));
  await page.screenshot({ path: join(OUT, '04-floaty-full-log.png'), clip: { x: 0, y: 0, width: 500, height: 400 } });

  console.log('[core3e] console errors:', errors.length, errors.slice(0, 5));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
