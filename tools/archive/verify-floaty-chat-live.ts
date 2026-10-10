/**
 * CORE.3.c live verification — enter the world, toggle the four floating
 * chat windows via the real 1-4 buttons, exercise routing/drag/close/persist,
 * and capture screenshots for the side-by-side against
 * reference/images/hud/chat-panel.jpg (retail screenshot showing all four
 * floaty windows open: "Chat Window 1: Speech" … "Chat Window 4: Channels").
 *
 * Usage: npx tsx tools/verify-floaty-chat-live.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=floaty';
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'screens', 'core3c');

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

  console.log(`[floaty] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[floaty] virgin create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await page.screenshot({ path: join(OUT, '00-never-entered.png') }); await browser.close(); throw new Error('never entered world'); }

  console.log('[floaty] in world — settling…');
  await page.waitForTimeout(10_000);
  await page.screenshot({ path: join(OUT, '01-hud-closed.png') });

  // Open all four windows by clicking the REAL 1-4 buttons in the chat bar.
  const openResult = await page.evaluate(`(() => {
    const out = [];
    for (const id of ['0x10000522', '0x10000523', '0x10000524', '0x10000525']) {
      const btn = document.querySelector('[data-element-id="' + id + '"]');
      if (!btn) { out.push(id + ':missing'); continue; }
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      out.push(id + ':clicked');
    }
    return out;
  })()`);
  console.log('[floaty] button clicks:', JSON.stringify(openResult));
  await page.waitForTimeout(800);

  // Probe: all four windows visible at DAT default positions with titles.
  const probe = await page.evaluate(`(() => {
    const wins = [];
    for (let i = 1; i <= 4; i++) {
      const p = document.querySelector('[data-floaty-chat="' + i + '"]');
      if (!p) { wins.push({ i, found: false }); continue; }
      const cs = getComputedStyle(p);
      const title = p.querySelector('[data-element-id="0x100004d9"]');
      const input = p.querySelector('input');
      const closeBox = p.querySelector('[data-element-id="0x1000052a"]');
      const scrollCol = p.querySelector('[data-element-id="0x10000012"]');
      wins.push({
        i, found: true, display: cs.display, left: p.style.left, top: p.style.top,
        w: p.style.width, h: p.style.height,
        titleText: title ? (title.textContent || '').trim() : null,
        hasInput: !!input, hasCloseBox: !!closeBox,
        scrollColDisplay: scrollCol ? getComputedStyle(scrollCol).display : null,
      });
    }
    const openFlags = [1,2,3,4].map(i => window.__ac.gameUI.isFloatyChatWindowOpen(i));
    return { wins, openFlags };
  })()`);
  console.log('[floaty] probe:', JSON.stringify(probe, null, 2));
  await page.screenshot({ path: join(OUT, '02-all-open.png') });
  // Left strip crop for the side-by-side vs chat-panel.jpg (windows stack 0..470 in base coords).
  await page.screenshot({ path: join(OUT, '03-left-strip.png'), clip: { x: 0, y: 0, width: 420, height: VIEW.height } });

  // Routing: speak (Speech → window 1 + main log; windows 3/4 must stay
  // empty). Chat lines render as ACFont canvases (no textContent), so
  // compare per-log CHILD COUNTS before/after the server HearSpeech echo.
  const countLogs = `(() => {
    const logOf = (i) => {
      const p = document.querySelector('[data-floaty-chat="' + i + '"]');
      const area = p && p.querySelector('[data-element-id="0x10000011"]');
      const log = area && area.querySelector('.layout-scroll-content');
      return log ? log.children.length : -1;
    };
    const main = document.getElementById('chat-messages');
    return { main: main ? main.children.length : -1, w1: logOf(1), w3: logOf(3), w4: logOf(4) };
  })()`;
  const before = await page.evaluate(countLogs) as Record<string, number>;
  console.log('[floaty] sending talk…');
  await page.evaluate(`window.acDebug.sendTalk('floaty routing check — hello window one')`);
  await page.waitForTimeout(4000);
  const after = await page.evaluate(countLogs) as Record<string, number>;
  const routing = {
    before, after,
    mainGrew: after.main > before.main,
    w1Grew: after.w1 > before.w1,
    w3Grew: after.w3 > before.w3,
    w4Grew: after.w4 > before.w4,
  };
  console.log('[floaty] routing:', JSON.stringify(routing));
  await page.screenshot({ path: join(OUT, '04-after-speech.png'), clip: { x: 0, y: 0, width: 420, height: 400 } });

  // Entry focus box 0x1000052b: hidden until the input focuses (state 4).
  const focusBoxProbe = await page.evaluate(`(() => {
    const p = document.querySelector('[data-floaty-chat="2"]');
    const box = p && p.querySelector('[data-element-id="0x1000052b"]');
    const input = p && p.querySelector('input');
    if (!box || !input) return { found: false };
    const beforeFocus = getComputedStyle(box).display;
    input.focus();
    const whileFocused = getComputedStyle(box).display;
    input.blur();
    const afterBlur = getComputedStyle(box).display;
    return { found: true, beforeFocus, whileFocused, afterBlur };
  })()`);
  console.log('[floaty] focus box:', JSON.stringify(focusBoxProbe));

  // Drag window 1 by its title bar: (0,35) → roughly (300,200).
  const w1bar = await page.evaluate(`(() => {
    const p = document.querySelector('[data-floaty-chat="1"]');
    const bar = p && p.querySelector('[data-element-id="0x10000529"]');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`) as { x: number; y: number } | null;
  if (w1bar) {
    await page.mouse.move(w1bar.x, w1bar.y);
    await page.mouse.down();
    await page.mouse.move(w1bar.x + 250, w1bar.y + 150, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  const dragProbe = await page.evaluate(`(() => {
    const p = document.querySelector('[data-floaty-chat="1"]');
    const stored = Object.keys(localStorage).filter(k => k.startsWith('ac_floaty_chat_v1'));
    const vals = {};
    for (const k of stored) vals[k] = localStorage.getItem(k);
    return { left: p ? p.style.left : null, top: p ? p.style.top : null, storageKeys: stored, storage: vals };
  })()`);
  console.log('[floaty] drag+persist:', JSON.stringify(dragProbe, null, 2));
  await page.screenshot({ path: join(OUT, '05-after-drag.png') });

  // Close window 1 via its close box; check the button 1 art flipped back.
  const closeProbe = await page.evaluate(`(() => {
    const p = document.querySelector('[data-floaty-chat="1"]');
    const btn = document.querySelector('[data-element-id="0x10000522"]');
    // Data-URL prefixes are identical for every PNG — compare FULL strings.
    const bgBefore = btn ? getComputedStyle(btn).backgroundImage : null;
    const close = p && p.querySelector('[data-element-id="0x1000052a"]');
    if (close) close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const bgAfter = btn ? getComputedStyle(btn).backgroundImage : null;
    return {
      closed: p ? getComputedStyle(p).display === 'none' : null,
      openFlag: window.__ac.gameUI.isFloatyChatWindowOpen(1),
      buttonBgChanged: bgBefore !== bgAfter,
    };
  })()`);
  console.log('[floaty] close:', JSON.stringify(closeProbe));
  await page.screenshot({ path: join(OUT, '06-after-close.png'), clip: { x: 0, y: 0, width: 420, height: VIEW.height } });

  writeFileSync(join(OUT, 'probe.json'), JSON.stringify({ openResult, probe, routing, focusBoxProbe, dragProbe, closeProbe, errors }, null, 2));
  console.log(`[floaty] errors: ${errors.length}`, errors.slice(0, 3));
  await browser.close();
  console.log(`[floaty] done → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
