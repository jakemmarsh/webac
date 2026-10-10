/**
 * CORE.10.b live verification — toolbar item mana snake meter.
 *
 * Drives the real stack end-to-end: creates an owned mana item via @ci,
 * clicks its real inventory grid cell, and asserts the selection fires a
 * real QueryItemMana whose reply shows the snake meter (el 0x100001a2,
 * bg 0x060022d5 / fill 0x060022d6) clipped to the mana fraction — plus the
 * retail negatives: a manaless owned item keeps the grey heart and prints
 * nothing to chat.
 *
 * Usage: npx tsx tools/verify-core10b-mana-meter.ts <manaWcid> [manalessWcid]
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core10b';
const OUT = join(__dir, '..', 'verification', 'core10b');

const MANA_WCID = Number(process.argv[2] ?? 0);
const MANALESS_WCID = Number(process.argv[3] ?? 0);

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
    ui.wizard.name = 'Hud Tester';
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

const failures: string[] = [];
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!cond) failures.push(name);
}

interface StripState {
  manaDisplay: string; manaClipWidth: string; meterDisplay: string;
  glowDisplay: string; manaFraction: number | null;
}
async function stripState(page: Page): Promise<StripState> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const t = ui.hudState.target;
    return {
      manaDisplay: ui.targetManaMeter.style.display,
      manaClipWidth: ui.targetManaMeterClip.style.width,
      meterDisplay: ui.targetMeter.style.display,
      glowDisplay: ui.targetGlow.style.display,
      manaFraction: t && typeof t.manaFraction === 'number' ? t.manaFraction : null,
    };
  })()`) as Promise<StripState>;
}

async function rect(page: Page, sel: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, sel);
}

/** Create wcid via @ci, wait for it to land, return the inventory record. */
async function createAndFind(page: Page, wcid: number): Promise<{ idx: number; guid: number; name: string } | null> {
  const before = await page.evaluate(`window.__ac.playerState.inventory.getAll().map(i => i && i.id)`) as number[];
  await page.evaluate(`window.acDebug.sendTalk('@ci ${wcid}')`);
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    const found = await page.evaluate(`(() => {
      const prior = new Set(${JSON.stringify(before)});
      const items = window.__ac.playerState.inventory.getAll();
      for (let i = 0; i < items.length; i++) {
        if (items[i] && !prior.has(items[i].id)) return { idx: i, guid: items[i].id, name: items[i].name };
      }
      return null;
    })()`) as { idx: number; guid: number; name: string } | null;
    if (found) return found;
  }
  return null;
}

/** Click the real inventory grid cell whose title starts with the item name. */
async function clickInventoryCell(page: Page, name: string): Promise<boolean> {
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.inventoryVisible) ui.toggleInventory();
  })()`);
  await page.waitForTimeout(1200);
  const cellRect = await page.evaluate((n) => {
    const cells = document.querySelectorAll(`[title]`);
    for (const el of cells) {
      if (!(el.getAttribute('title') ?? '').startsWith(n)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0) return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return null;
  }, name);
  if (!cellRect) return false;
  await page.mouse.click(cellRect.x + cellRect.w / 2, cellRect.y + cellRect.h / 2);
  return true;
}

async function chatTail(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const log = document.querySelector('#chat-messages') || document.querySelector('#chat-log');
    if (!log) return '';
    return (log.textContent || '').slice(-400);
  })()`) as Promise<string>;
}

async function main(): Promise<void> {
  if (!MANA_WCID) { console.error('usage: verify-core10b-mana-meter.ts <manaWcid> [manalessWcid]'); process.exit(2); }
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  await page.waitForTimeout(8000);

  // ── 1. REAL path: create a mana item, click its inventory cell ───
  const manaItem = await createAndFind(page, MANA_WCID);
  check('mana-item-created', !!manaItem, JSON.stringify(manaItem));
  if (manaItem) {
    const clicked = await clickInventoryCell(page, manaItem.name);
    check('mana-cell-clicked', clicked, manaItem.name);
    // Selection → per-frame syncSelectionQueries → QueryItemMana → reply.
    await page.waitForTimeout(2500);
    const s = await stripState(page);
    check('snake-shown', s.manaDisplay === 'block', JSON.stringify(s));
    check('heart-hidden-under-snake', s.meterDisplay === 'none', s.meterDisplay);
    check('glow-shown', s.glowDisplay === 'block', s.glowDisplay);
    const expectedPx = s.manaFraction === null ? -1 : Math.round(Math.max(0, Math.min(1, s.manaFraction)) * 140);
    check('snake-clip-matches-fraction', s.manaFraction !== null && s.manaClipWidth === `${expectedPx}px`,
      `fraction=${s.manaFraction} clip=${s.manaClipWidth} expected=${expectedPx}px`);
    const tail = await chatTail(page);
    check('no-auto-chat-spam', !tail.includes('mana remaining') && !tail.includes('cannot read its mana'), tail.slice(-120));
    await page.screenshot({ path: join(OUT, 'core10b-mana-item-selected.png') });
    const tb = await rect(page, '#hud-toolbar-window');
    if (tb) {
      await page.screenshot({
        path: join(OUT, 'core10b-mana-toolbar.png'),
        clip: { x: tb.x, y: tb.y, width: tb.w, height: tb.h },
      });
    }
  }

  // ── 2. Negative: a manaless owned item keeps the grey heart ──────
  if (MANALESS_WCID) {
    const plain = await createAndFind(page, MANALESS_WCID);
    check('manaless-item-created', !!plain, JSON.stringify(plain));
    if (plain) {
      const clicked = await clickInventoryCell(page, plain.name);
      check('manaless-cell-clicked', clicked, plain.name);
      await page.waitForTimeout(2500);
      const s = await stripState(page);
      check('manaless-snake-hidden', s.manaDisplay === 'none', JSON.stringify(s));
      check('manaless-heart-shown', s.meterDisplay === 'block', s.meterDisplay);
      const tail = await chatTail(page);
      check('manaless-no-chat', !tail.includes('cannot read its mana'), tail.slice(-120));
      const tb = await rect(page, '#hud-toolbar-window');
      if (tb) {
        await page.screenshot({
          path: join(OUT, 'core10b-manaless-toolbar.png'),
          clip: { x: tb.x, y: tb.y, width: tb.w, height: tb.h },
        });
      }
    }
  }

  // ── 3. Clearing the selection hides the snake ────────────────────
  await page.evaluate(`window.acDebug.clearTarget()`);
  await page.waitForTimeout(500);
  const cleared = await stripState(page);
  check('cleared-snake-hidden', cleared.manaDisplay === 'none', JSON.stringify(cleared));

  await browser.close();
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
