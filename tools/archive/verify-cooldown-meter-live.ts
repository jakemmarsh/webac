/**
 * BUG.cooldown-id-duration-discarded — live verification on the ACE stack.
 *
 * Drives one real client: logs in, spawns a stack of Enhanced Mana Elixirs
 * (wcid 37516 — PropertyInt.SharedCooldown=5, PropertyFloat.CooldownDuration
 * =30 in the world DB), and checks the full retail chain live:
 *
 *  1. WIRE: the elixir's inventory entry carries cooldownId=5 /
 *     cooldownDuration=30 parsed from the real CreateObject (pre-fix both
 *     were read-and-discarded).
 *  2. USE: double-clicking the elixir makes ACE StartCooldown mint the
 *     cooldown enchantment (spell id 0x8000+5 = 0x8005) which lands in
 *     GameUI.activeEnchantments with isCooldown=true.
 *  3. METER: the inventory cell renders the full-size decile overlay with
 *     the high-decile DAT texture (0x060067d8 = Icon_Cooldown_100 family),
 *     steps down as time passes, and disappears after expiry.
 *
 * Evidence: verdict.json + screenshots in verification/cooldown-meter/.
 */
import { chromium, Browser, Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const OUT = join(REPO, 'verification', 'cooldown-meter');
const CREATE_NAME = 'Cooldown Tester';
const ELIXIR_WCID = 37516;
const EXPECT_COOLDOWN_ID = 5;
const EXPECT_DURATION = 30;
const TEX_BASE = 0x060067cf; // decile 1

function url(account: string): string {
  return `http://localhost:3000/?ace&bridge=ws://localhost:9090&account=${account}&password=${account}&cb=cdmeter`;
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page, name: string): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = ${JSON.stringify(name)};
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function loginLoop(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      const created = await driveCharacterCreate(page, CREATE_NAME);
      if (created !== 'not-at-create') {
        console.log(`[cd-live] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 90_000) {
      console.log('[cd-live] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
      createSent = false;
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world within 360s');
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

interface ElixirState {
  found: boolean;
  cooldownId?: number;
  cooldownDuration?: number;
  stackSize?: number;
}

async function elixirInventoryState(page: Page): Promise<ElixirState> {
  return page.evaluate(`(() => {
    const items = window.__ac.gameUI.inventoryItems || [];
    const it = items.find((i) => i.weenieClassId === ${ELIXIR_WCID});
    if (!it) return { found: false };
    return { found: true, cooldownId: it.cooldownId, cooldownDuration: it.cooldownDuration, stackSize: it.stackSize };
  })()`) as Promise<ElixirState>;
}

/** The decile of the cooldown overlay rendered in the elixir's inventory
 *  cell right now (0 = no overlay), identified by matching the overlay's
 *  background-image data URL against the icon cache entries for the ten
 *  decile textures. */
async function renderedDecile(page: Page): Promise<number> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const handle = ui.inventoryPanelHandle;
    if (!handle) return -1;
    const gridEl = handle.elements.get(0x100001cf);
    if (!gridEl) return -2;
    const itemGrid = gridEl.querySelector('div[style*="grid"]');
    if (!itemGrid) return -3;
    const urls = [];
    for (let d = 0; d < 10; d++) urls.push(ui.itemIconCache.get(${TEX_BASE} + d) || '__none__' + d);
    for (const cell of itemGrid.children) {
      for (const child of cell.children) {
        const bg = child.style && child.style.backgroundImage;
        if (!bg) continue;
        for (let d = 0; d < 10; d++) {
          // Match on the TAIL of the data URL — 32x32 PNGs share their
          // header bytes, so the leading base64 chars collide across deciles.
          if (urls[d].length > 100 && bg.includes(urls[d].slice(-60))) {
            return d + 1;
          }
        }
      }
    }
    return 0;
  })()`) as Promise<number>;
}

async function cooldownEnchantmentActive(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    for (const e of window.__ac.gameUI.activeEnchantments.values()) {
      if (e.isCooldown && (e.spellId & 0xFFFF) === (0x8000 + ${EXPECT_COOLDOWN_ID})) return true;
    }
    return false;
  })()`) as Promise<boolean>;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  const checks: Record<string, boolean> = {};
  const notes: Record<string, unknown> = {};

  console.log('[cd-live] logging in testacjs …');
  await page.goto(url('testacjs'), { waitUntil: 'domcontentloaded' });
  await loginLoop(page);
  console.log('[cd-live] in world.');

  // Spawn a stack of elixirs (admin @ci), open the inventory panel.
  await page.evaluate(`window.acDebug.sendTalk('@ci ${ELIXIR_WCID} 5')`);
  await waitFor(async () => (await elixirInventoryState(page)).found, 30_000, 'elixir in inventory');
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.inventoryVisible) ui.toggleInventory();
  })()`);
  await page.waitForTimeout(2000);

  // ── 1. WIRE ──
  const st = await elixirInventoryState(page);
  notes.inventoryEntry = st;
  checks['wire-cooldownId'] = st.cooldownId === EXPECT_COOLDOWN_ID;
  checks['wire-cooldownDuration'] = st.cooldownDuration === EXPECT_DURATION;
  console.log(`[cd-live] inventory entry: cooldownId=${st.cooldownId} cooldownDuration=${st.cooldownDuration} stack=${st.stackSize}`);

  const decileBefore = await renderedDecile(page);
  checks['no-overlay-before-use'] = decileBefore === 0;
  notes.decileBefore = decileBefore;
  await page.screenshot({ path: join(OUT, '1-before-use.png') });

  // ── 2. USE ──
  console.log('[cd-live] double-clicking the elixir …');
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const idx = ui.inventoryItems.findIndex((i) => i.weenieClassId === ${ELIXIR_WCID});
    ui.dragCallbacks.onDoubleClickItem(idx);
  })()`);
  await waitFor(() => cooldownEnchantmentActive(page), 20_000, 'cooldown enchantment (0x8005) active');
  checks['cooldown-enchantment-arrived'] = true;
  const tEnch = Date.now();

  // ── 3. METER ──
  // Force a re-render so the overlay reflects the fresh enchantment
  // immediately (the 1s ticker would do it anyway).
  await page.evaluate(`window.__ac.gameUI.renderInventoryPanel()`);
  const decileFresh = await renderedDecile(page);
  notes.decileFresh = decileFresh;
  checks['overlay-high-decile-after-use'] = decileFresh >= 9;
  console.log(`[cd-live] decile right after use: ${decileFresh} (expect >= 9)`);
  await page.screenshot({ path: join(OUT, '2-on-cooldown-fresh.png') });

  console.log('[cd-live] waiting ~14s for the meter to tick down …');
  await page.waitForTimeout(14_000);
  await page.evaluate(`window.__ac.gameUI.renderInventoryPanel()`);
  const decileMid = await renderedDecile(page);
  // Screenshots + evaluates run seconds-slow under SwiftShader, so compute
  // the expectation from the actual elapsed wall clock since the cooldown
  // enchantment arrived (appliedAt is client receipt time), ±1 decile.
  const elapsed = (Date.now() - tEnch) / 1000;
  const expectMid = Math.min(10, Math.max(0, Math.ceil(((EXPECT_DURATION - elapsed) / EXPECT_DURATION) * 10)));
  notes.decileMid = decileMid;
  notes.elapsedAtMid = elapsed;
  notes.expectMid = expectMid;
  checks['overlay-steps-down'] = Math.abs(decileMid - expectMid) <= 1 && decileMid < decileFresh && decileMid > 0;
  console.log(`[cd-live] decile mid-cooldown: ${decileMid} (elapsed ${elapsed.toFixed(1)}s -> expect ${expectMid}±1, < ${decileFresh})`);
  await page.screenshot({ path: join(OUT, '3-on-cooldown-mid.png') });

  console.log('[cd-live] waiting for expiry …');
  await waitFor(async () => (await renderedDecile(page)) === 0, 40_000, 'overlay gone after expiry');
  checks['overlay-gone-after-expiry'] = true;
  await page.screenshot({ path: join(OUT, '4-after-expiry.png') });

  const pass = Object.values(checks).every(Boolean);
  const verdict = { pass, checks, notes, when: new Date().toISOString() };
  writeFileSync(join(OUT, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log(`[cd-live] ${JSON.stringify(verdict, null, 2)}`);
  console.log(`[cd-live] ${pass ? 'ALL CHECKS PASS' : 'FAILURES PRESENT'}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error('[cd-live] FATAL', err); process.exit(2); });
