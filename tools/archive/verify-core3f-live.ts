/**
 * CORE.3.f live verification — chat-window options server round-trip
 * (PlayerModule GameplayOptions blob via SetCharacterOptions 0x01A1,
 * echoed back in PlayerDescription), driven against the running ACE stack.
 *
 * Proof shape: move/resize/retitle/open a floaty window, force the
 * PlayerModule flush (pagehide — retail SaveToServer(true) equivalent),
 * then CLEAR localStorage and reload. Anything that survives can only
 * have come back from the server blob.
 *
 * Usage: npx tsx tools/verify-core3f-live.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core3f';
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'screens', 'core3f');

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

const probeFloaty = `((idx) => {
  const p = document.querySelector('[data-floaty-chat="' + idx + '"]');
  if (!p) return null;
  const title = p.querySelector('[data-element-id="0x100004d9"] canvas, [data-element-id="0x100004d9"]');
  return {
    display: p.style.display,
    left: parseInt(p.style.left) || 0,
    top: parseInt(p.style.top) || 0,
    width: parseInt(p.style.width) || 0,
    height: parseInt(p.style.height) || 0,
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
  const logs: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { const t = m.text(); if (t.includes('chat-window options')) logs.push(t); });

  console.log(`[core3f] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core3f] in world — settling…');
  await page.waitForTimeout(10_000);

  // ── 1. Open floaty window 1 and mutate everything the blob carries ──
  await page.evaluate(`(() => {
    const btn = document.querySelector('[data-element-id="0x10000522"]');
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await page.waitForTimeout(600);

  // Drag the title bar to move the window (real mouse path).
  const bar = await page.evaluate(`(() => {
    const el = document.querySelector('[data-floaty-chat="1"] [data-element-id="0x10000529"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const p = document.querySelector('[data-floaty-chat="1"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, scale: p.width / (parseInt(document.querySelector('[data-floaty-chat="1"]').style.width) || p.width) };
  })()`) as { x: number; y: number; scale: number } | null;
  if (!bar) throw new Error('floaty window 1 title bar not found');
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.down();
  await page.mouse.move(bar.x + 120 * bar.scale, bar.y + 80 * bar.scale, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  // Resize via the BR corner handle.
  const br = await page.evaluate(`(() => {
    const el = document.querySelector('[data-floaty-chat="1"] [data-element-id="0x10000503"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`) as { x: number; y: number } | null;
  if (br) {
    await page.mouse.move(br.x, br.y);
    await page.mouse.down();
    await page.mouse.move(br.x + 100 * bar.scale, br.y + 60 * bar.scale, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }

  // Retitle via the retail @title command in the floaty's own entry.
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-floaty-chat="1"] input');
    if (!input) return;
    input.focus();
    input.value = '@title Roundtrip W1';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await page.waitForTimeout(400);

  const before = await page.evaluate(`(${probeFloaty})(1)`);
  console.log('[core3f] window 1 after mutations:', JSON.stringify(before));
  await page.screenshot({ path: join(OUT, '01-before-save.png') });

  // Semantic snapshot the save will serialize.
  const snapshot = await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const d = ui.buildChatWindowOptionsData();
    const w2 = d.chatWindows.get(2);
    return {
      count: d.chatWindows.size,
      defaultOpacity: d.defaultOpacity,
      w2: w2 ? { x: w2.x, y: w2.y, w: w2.w, h: w2.h, visible: w2.visible, title: w2.title, filter: String(w2.filter) } : null,
      main: d.chatWindows.get(8) ? String(d.chatWindows.get(8).filter) : null,
    };
  })()`);
  console.log('[core3f] buildChatWindowOptionsData snapshot:', JSON.stringify(snapshot));

  // ── 2. Force the PlayerModule flush (retail SaveToServer(true)) ──
  await page.evaluate(`window.dispatchEvent(new Event('pagehide'))`);
  await page.waitForTimeout(2500);
  console.log('[core3f] save logs:', JSON.stringify(logs));

  // ── 3. Clear localStorage so only the SERVER can restore, then reload ──
  await page.evaluate(`localStorage.clear()`);
  console.log('[core3f] localStorage cleared — reloading');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  await page.waitForTimeout(10_000);

  const after = await page.evaluate(`(${probeFloaty})(1)`);
  console.log('[core3f] window 1 after localStorage-wipe reload:', JSON.stringify(after));
  const restoredTitleOk = await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const d = ui.buildChatWindowOptionsData();
    const w2 = d.chatWindows.get(2);
    return w2 ? { title: w2.title, x: w2.x, y: w2.y, w: w2.w, h: w2.h, visible: w2.visible } : null;
  })()`);
  console.log('[core3f] restored semantic state:', JSON.stringify(restoredTitleOk));
  console.log('[core3f] restore logs:', JSON.stringify(logs.filter(l => l.includes('Restored'))));
  await page.screenshot({ path: join(OUT, '02-after-reload-restored.png') });

  console.log('[core3f] console errors:', errors.length, errors.slice(0, 5));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
