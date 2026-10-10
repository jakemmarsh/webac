/**
 * CORE.3.b live verification — enter the world, flood the chat log past its
 * visible height, and capture the chat panel + a crop of the scrollbar column
 * (0x10000012 at 474,6, 16x68) so the retail DAT scrollbar art can be judged
 * side-by-side against reference/images/hud/reddit-shutdown.jpg.
 *
 * Usage: npx tsx tools/verify-chat-scrollbar-live.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=chatsb';
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'screens', 'core3b');

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}
async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Chat Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

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

  console.log(`[chatsb] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[chatsb] virgin create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await page.screenshot({ path: join(OUT, '00-never-entered.png') }); await browser.close(); throw new Error('never entered world'); }

  console.log('[chatsb] in world — settling…');
  await page.waitForTimeout(10_000);
  await page.screenshot({ path: join(OUT, '01-hud.png') });

  // Flood the chat log so it overflows the ~74px visible area (retail hides
  // the scrollbar when the log fits; we need the overflow state to see it).
  console.log('[chatsb] flooding chat log…');
  for (let i = 0; i < 40; i++) {
    await page.evaluate(`window.acDebug.sendTalk('scrollbar test line ${i} — the quick brown fox')`);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1500);

  // Probe the scrollbar column DOM state.
  const probe = await page.evaluate(`(() => {
    const col = document.querySelector('[data-element-id="0x10000012"]');
    const vp = document.getElementById('chat-messages');
    if (!col || !vp) return { found: false };
    const cs = getComputedStyle(col);
    const thumb = col.querySelector('[data-chat-thumb="1"]');
    return {
      found: true,
      columnDisplay: cs.display,
      columnBg: cs.backgroundImage.slice(0, 40),
      columnRepeat: cs.backgroundRepeat,
      childCount: col.children.length,
      hasThumb: !!thumb,
      thumbTop: thumb ? getComputedStyle(thumb).top : null,
      viewportScrollbarWidth: getComputedStyle(vp).scrollbarWidth || getComputedStyle(vp)['scrollbar-width'],
      overflow: vp.scrollHeight - vp.clientHeight,
      scrollTop: vp.scrollTop,
      rect: (() => { const r = col.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    };
  })()`) as Record<string, unknown>;
  console.log('[chatsb] probe:', JSON.stringify(probe, null, 2));

  // Full chat-area screenshot.
  await page.screenshot({ path: join(OUT, '02-chat-flooded.png') });

  // Crop the chat panel region (bottom-left) for the side-by-side.
  const rect = (probe as any).rect;
  if (rect && rect.w > 0) {
    // Chat panel spans ~0..490 wide from bottom-left; crop a generous region.
    const clip = { x: 0, y: Math.max(0, VIEW.height - 200), width: 540, height: 200 };
    await page.screenshot({ path: join(OUT, '03-chat-crop.png'), clip });
    // Tight crop on the scrollbar column itself (zoomed context).
    const zx = Math.max(0, rect.x - 30), zy = Math.max(0, rect.y - 20);
    await page.screenshot({ path: join(OUT, '04-scrollbar-zoom.png'), clip: { x: zx, y: zy, width: 90, height: Math.min(140, rect.h + 40) } });
  }

  // Scroll up via the up button click to confirm live wiring + thumb move.
  const upClick = await page.evaluate(`(() => {
    const col = document.querySelector('[data-element-id="0x10000012"]');
    const vp = document.getElementById('chat-messages');
    if (!col || !vp) return 'no-col';
    const before = vp.scrollTop;
    const up = col.children[0]; // up button rendered first
    up.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { before, after: vp.scrollTop };
  })()`);
  console.log('[chatsb] up-button click:', JSON.stringify(upClick));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, '05-after-scroll-up.png') });

  writeFileSync(join(OUT, 'probe.json'), JSON.stringify({ probe, upClick, errors }, null, 2));
  console.log(`[chatsb] errors: ${errors.length}`);
  await browser.close();
  console.log(`[chatsb] done → ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
