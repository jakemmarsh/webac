/**
 * CORE.3.d live verification — floaty chat window resize (8 DAT resize
 * handles + edge-anchor reflow), per-window chat options (filter checkboxes
 * routing live, @title retitling), and per-window input history, driven
 * against the running ACE stack.
 *
 * Usage: npx tsx tools/verify-floaty-chat-resize-live.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=floatyresize';
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'screens', 'core3d');

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
      const cs = dbg?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
  } catch { return false; } // navigation mid-probe — retry next tick
}
async function driveCharacterCreate(page: Page): Promise<string> {
  try {
    return await drive(page);
  } catch { return 'not-at-create'; }
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
      const created = await driveCharacterCreate(page);
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

const panelRect = `((i) => {
  const p = document.querySelector('[data-floaty-chat="' + i + '"]');
  if (!p) return null;
  const childRect = (id) => {
    const el = p.querySelector('[data-element-id="' + id + '"]');
    return el ? { x: parseInt(el.style.left), y: parseInt(el.style.top), w: parseInt(el.style.width), h: parseInt(el.style.height) } : null;
  };
  return {
    left: parseInt(p.style.left), top: parseInt(p.style.top),
    w: parseInt(p.style.width), h: parseInt(p.style.height),
    titleBar: childRect('0x10000529'), closeBox: childRect('0x1000052a'),
    logArea: childRect('0x10000010'), scrollCol: childRect('0x10000012'),
    entryRow: childRect('0x10000509'), sendBtn: childRect('0x10000019'),
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

  console.log(`[core3d] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core3d] in world — settling…');
  await page.waitForTimeout(10_000);

  // Open windows 1-3 via the real chat-bar buttons.
  await page.evaluate(`(() => {
    for (const id of ['0x10000522', '0x10000523', '0x10000524']) {
      const btn = document.querySelector('[data-element-id="' + id + '"]');
      if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  })()`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, '01-open-default-size.png'), clip: { x: 0, y: 0, width: 500, height: VIEW.height } });

  // ── 1. RESIZE via the bottom-right corner handle (0x10000503) ──
  const before = await page.evaluate(`(${panelRect})(1)`);
  console.log('[core3d] w1 before resize:', JSON.stringify(before));
  const brHandle = await page.evaluate(`(() => {
    const p = document.querySelector('[data-floaty-chat="1"]');
    const h = p && p.querySelector('[data-element-id="0x10000503"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, cursor: getComputedStyle(h).cursor };
  })()`) as { x: number; y: number; cursor: string } | null;
  console.log('[core3d] BR handle:', JSON.stringify(brHandle));
  if (!brHandle) throw new Error('BR resize handle not found');
  // HUD scale: design px → screen px (measure from the panel itself).
  const scale = await page.evaluate(`(() => {
    const p = document.querySelector('[data-floaty-chat="1"]');
    return p.getBoundingClientRect().width / parseInt(p.style.width);
  })()`) as number;
  await page.mouse.move(brHandle.x, brHandle.y);
  await page.mouse.down();
  await page.mouse.move(brHandle.x + 150 * scale, brHandle.y + 96 * scale, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterGrow = await page.evaluate(`(${panelRect})(1)`);
  console.log('[core3d] w1 after BR grow (+150,+96):', JSON.stringify(afterGrow));
  await page.screenshot({ path: join(OUT, '02-after-grow.png'), clip: { x: 0, y: 0, width: 600, height: VIEW.height } });

  // ── 2. RESIZE via the LEFT edge (0x100004d2) — x moves, right edge fixed ──
  const lHandle = await page.evaluate(`(() => {
    const p = document.querySelector('[data-floaty-chat="2"]');
    const h = p && p.querySelector('[data-element-id="0x100004d2"]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`) as { x: number; y: number } | null;
  const w2Before = await page.evaluate(`(${panelRect})(2)`);
  if (!lHandle) throw new Error('L resize handle not found');
  // Drag left edge LEFT past the min — but window 2 starts at x=0, so drag
  // RIGHT instead: width shrinks toward the 150 minimum (clamped).
  await page.mouse.move(lHandle.x, lHandle.y);
  await page.mouse.down();
  await page.mouse.move(lHandle.x + 300 * scale, lHandle.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const w2After = await page.evaluate(`(${panelRect})(2)`);
  console.log('[core3d] w2 left-edge shrink to min:', JSON.stringify({ before: w2Before, after: w2After }));

  // ── 3. Persistence of size ──
  const storage = await page.evaluate(`(() => {
    const out = {};
    for (const k of Object.keys(localStorage)) if (k.startsWith('ac_floaty_chat_v1')) out[k] = localStorage.getItem(k);
    return out;
  })()`);
  console.log('[core3d] persisted:', JSON.stringify(storage, null, 2));

  // ── 4. @title in a floaty window ──
  const titleProbe = await page.evaluate(`(async () => {
    const p = document.querySelector('[data-floaty-chat="2"]');
    const input = p.querySelector('input');
    const titleEl = p.querySelector('[data-element-id="0x100004d9"]');
    const logCount = () => {
      const area = p.querySelector('[data-element-id="0x10000011"]');
      const log = area && area.querySelector('.layout-scroll-content');
      return log ? log.children.length : -1;
    };
    const mainCount = () => document.getElementById('chat-messages').children.length;
    const send = (text) => {
      input.focus();
      input.value = text;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    const before = { log: logCount(), main: mainCount(), title: (titleEl.textContent || '').trim() };
    send('@title Trade watch');
    await new Promise(r => setTimeout(r, 200));
    const afterSet = { title: (titleEl.textContent || '').trim() };
    send('@title');
    await new Promise(r => setTimeout(r, 200));
    const afterErr = { log: logCount(), main: mainCount() };
    // Main chat: @title must be rejected with the retail line.
    const mainInput = document.getElementById('chat-input');
    const mainBefore = mainCount();
    mainInput.focus();
    mainInput.value = '@title nope';
    mainInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 200));
    const stored = {};
    for (const k of Object.keys(localStorage)) if (k.startsWith('ac_floaty_chat_v1')) stored[k] = localStorage.getItem(k);
    return { before, afterSet, afterErr, mainGrewOnReject: mainCount() > mainBefore, stored };
  })()`);
  console.log('[core3d] @title:', JSON.stringify(titleProbe, null, 2));
  await page.screenshot({ path: join(OUT, '03-after-title.png'), clip: { x: 0, y: 0, width: 600, height: VIEW.height } });

  // ── 5. Per-window input history ──
  const historyProbe = await page.evaluate(`(async () => {
    const win = (i) => document.querySelector('[data-floaty-chat="' + i + '"]');
    const type = (input, text) => {
      input.focus();
      input.value = text;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    const arrowUp = (input) => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      return input.value;
    };
    const i1 = win(1).querySelector('input');
    const i3 = win(3).querySelector('input');
    type(i1, 'window one alpha');
    await new Promise(r => setTimeout(r, 300));
    type(i1, 'window one beta');
    await new Promise(r => setTimeout(r, 300));
    type(i3, 'window three gamma');
    await new Promise(r => setTimeout(r, 300));
    const w1recall = arrowUp(i1);
    const w1recall2 = arrowUp(i1);
    const w3recall = arrowUp(i3);
    const mainInput = document.getElementById('chat-input');
    mainInput.focus();
    mainInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    const mainRecall = mainInput.value;
    mainInput.value = '';
    const historyKeys = Object.keys(localStorage).filter(k => k.startsWith('ac_chat_history_v1'));
    return { w1recall, w1recall2, w3recall, mainRecall, historyKeys };
  })()`);
  console.log('[core3d] history:', JSON.stringify(historyProbe, null, 2));

  // ── 6. Filter options wiring (Chat Options → live routing) ──
  const filterProbe = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const logCount = (i) => {
      const p = document.querySelector('[data-floaty-chat="' + i + '"]');
      const area = p && p.querySelector('[data-element-id="0x10000011"]');
      const log = area && area.querySelector('.layout-scroll-content');
      return log ? log.children.length : -1;
    };
    const mainCount = () => document.getElementById('chat-messages').children.length;
    // Fellowship type 0x13 routes to window 3 (default) but not window 2.
    const s1 = { m: mainCount(), w2: logCount(2), w3: logCount(3) };
    ui.addSystemMessage('fellowship line A', '#ffff99', 0x13);
    const s2 = { m: mainCount(), w2: logCount(2), w3: logCount(3) };
    // Enable Fellowship in window 2 via the Chat Options setting → routes there too.
    ui.optionsSettings.chatWindow2Fellowship = true;
    ui.addSystemMessage('fellowship line B', '#ffff99', 0x13);
    const s3 = { m: mainCount(), w2: logCount(2), w3: logCount(3) };
    // Uncheck Combat in the MAIN window → combat line skips the main log.
    ui.optionsSettings.chatMainWindowCombat = false;
    ui.addSystemMessage('combat line', '#ff9999', 0x06);
    const s4 = { m: mainCount(), w2: logCount(2), w3: logCount(3) };
    ui.optionsSettings.chatMainWindowCombat = true;
    ui.optionsSettings.chatWindow2Fellowship = false;
    return { s1, s2, s3, s4 };
  })()`);
  console.log('[core3d] filters:', JSON.stringify(filterProbe, null, 2));

  // ── 7. Reload → size + title restored from persistence ──
  console.log('[core3d] reloading for persistence check…');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  await page.waitForTimeout(8000);
  const restored = await page.evaluate(`(() => {
    const r1 = (${panelRect})(1);
    const r2 = (${panelRect})(2);
    const p2 = document.querySelector('[data-floaty-chat="2"]');
    const title2 = p2 && p2.querySelector('[data-element-id="0x100004d9"]');
    return { w1: r1, w2: r2, w2title: title2 ? (title2.textContent || '').trim() : null,
      open: [1,2,3,4].map(i => window.__ac.gameUI.isFloatyChatWindowOpen(i)) };
  })()`);
  console.log('[core3d] after reload:', JSON.stringify(restored, null, 2));
  await page.screenshot({ path: join(OUT, '04-after-reload.png'), clip: { x: 0, y: 0, width: 600, height: VIEW.height } });
  await page.screenshot({ path: join(OUT, '05-full.png') });

  writeFileSync(join(OUT, 'probe.json'), JSON.stringify({
    before, afterGrow, w2Before, w2After, storage, titleProbe, historyProbe, filterProbe, restored, errors,
  }, null, 2));
  console.log(`[core3d] errors: ${errors.length}`, errors.slice(0, 5));
  await browser.close();
  console.log(`[core3d] done → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
