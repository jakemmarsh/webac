/**
 * BUG.structure-maxstructure-discarded — live verification on the ACE stack.
 *
 * Drives one real client: logs in, spawns a healing kit (@ci), and checks
 * the full retail chain live:
 *
 *  1. WIRE: the kit's inventory entry carries structure/maxStructure parsed
 *     from the real CreateObject (pre-fix both were read-and-discarded), a
 *     fresh kit has structure == maxStructure > 0, and the icon renders NO
 *     bar (retail hides the meter at ratio exactly 1.0).
 *  2. DRAIN: appraise the kit, then `@setproperty PropertyInt.Structure N`
 *     — ACE Player.UpdateProperty broadcasts the same
 *     GameMessagePublicUpdatePropertyInt(Structure=92) that Healer.cs:191 /
 *     Lock.cs:94 / PetDevice.cs:94 send on a real use — and the inventory
 *     item + icon bar update live.
 *  3. METER: the rendered bar matches the DAT ground truth — track texture
 *     0x06004d24 at (26,1) 5x30, fill texture 0x06004d25 bottom-anchored at
 *     Clamp(structure/maxStructure,0,1) * 30px (LayoutDesc 0x21000037
 *     element 0x10000348, direction 4 per UIElement_Meter::DrawChildren).
 *
 * Evidence: verdict.json + screenshots in verification/structure-bar/.
 */
import { chromium, Browser, Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const OUT = join(REPO, 'verification', 'structure-bar');
const CREATE_NAME = 'Structure Tester';
const KIT_WCID = Number(process.env.KIT_WCID ?? 9229); // healingkittreated (Structure 50/50)
const DRAIN_TO = 12;
const BG_TEX = 0x06004d24;
const FILL_TEX = 0x06004d25;

function url(account: string): string {
  return `http://localhost:3000/?ace&bridge=ws://localhost:9090&account=${account}&password=${account}&cb=sbar`;
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
        console.log(`[sbar-live] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 90_000) {
      console.log('[sbar-live] not in world yet — reloading (phantom-session retry)');
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

interface KitState {
  found: boolean;
  guid?: number;
  structure?: number;
  maxStructure?: number;
}

async function kitInventoryState(page: Page): Promise<KitState> {
  return page.evaluate(`(() => {
    const items = window.__ac.gameUI.inventoryItems || [];
    const it = items.find((i) => i.weenieClassId === ${KIT_WCID});
    if (!it) return { found: false };
    return { found: true, guid: it.id, structure: it.structure, maxStructure: it.maxStructure };
  })()`) as Promise<KitState>;
}

interface BarState {
  bars: number;
  left?: string;
  top?: string;
  width?: string;
  height?: string;
  trackIsBgTex?: boolean;
  fillHeight?: string;
  fillBottom?: string;
  fillIsFillTex?: boolean;
}

/** The rendered structure bar (if any) in the kit's inventory cell. */
async function renderedBar(page: Page): Promise<BarState> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const handle = ui.inventoryPanelHandle;
    if (!handle) return { bars: -1 };
    const gridEl = handle.elements.get(0x100001cf);
    if (!gridEl) return { bars: -2 };
    const itemGrid = gridEl.querySelector('div[style*="grid"]');
    if (!itemGrid) return { bars: -3 };
    const bgUrl = ui.itemIconCache.get(${BG_TEX}) || '__none_bg__';
    const fillUrl = ui.itemIconCache.get(${FILL_TEX}) || '__none_fill__';
    const found = [];
    for (const cell of itemGrid.children) {
      for (const bar of cell.querySelectorAll('[data-structure-bar]')) {
        const fill = bar.children[0];
        found.push({
          left: bar.style.left, top: bar.style.top,
          width: bar.style.width, height: bar.style.height,
          trackIsBgTex: bgUrl.length > 100 && bar.style.backgroundImage.includes(bgUrl.slice(-60)),
          fillHeight: fill ? fill.style.height : '',
          fillBottom: fill ? fill.style.bottom : '',
          fillIsFillTex: !!fill && fillUrl.length > 100 && fill.style.backgroundImage.includes(fillUrl.slice(-60)),
        });
      }
    }
    return Object.assign({ bars: found.length }, found[0] || {});
  })()`) as Promise<BarState>;
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

  console.log('[sbar-live] logging in testacjs …');
  await page.goto(url('testacjs'), { waitUntil: 'domcontentloaded' });
  await loginLoop(page);
  console.log('[sbar-live] in world.');

  // Spawn a fresh kit, open the inventory panel.
  await page.evaluate(`window.acDebug.sendTalk('@ci ${KIT_WCID}')`);
  await waitFor(async () => (await kitInventoryState(page)).found, 30_000, 'kit in inventory');
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.inventoryVisible) ui.toggleInventory();
  })()`);
  await page.waitForTimeout(2000);

  // ── 1. WIRE (fresh kit) ──
  const fresh = await kitInventoryState(page);
  notes.freshEntry = fresh;
  checks['wire-maxstructure-positive'] = (fresh.maxStructure ?? 0) > 0;
  checks['wire-fresh-structure-equals-max'] = fresh.structure === fresh.maxStructure;
  console.log(`[sbar-live] fresh kit: structure=${fresh.structure}/${fresh.maxStructure}`);

  const barFresh = await renderedBar(page);
  notes.barFresh = barFresh;
  checks['no-bar-when-fresh'] = barFresh.bars === 0;
  await page.screenshot({ path: join(OUT, '1-fresh-no-bar.png') });

  // ── 2. DRAIN ──
  // Appraise the kit via the real context-menu Examine path (sends
  // IdentifyObject, making it ACE's RequestedAppraisalTarget), then
  // @setproperty broadcasts the same PublicUpdatePropertyInt(Structure)
  // wire message a real Healer.cs/Lock.cs use emits.
  const examined = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const idx = ui.inventoryItems.findIndex((i) => i.weenieClassId === ${KIT_WCID});
    if (idx < 0) return 'no-item';
    ui.dragCallbacks.onRightClickItem(idx);
    const menu = ui.contextMenu;
    if (!menu) return 'no-menu';
    const row = [...menu.children].find((r) => r.textContent === 'Examine');
    if (!row) return 'no-examine-row';
    row.click();
    return 'clicked';
  })()`);
  console.log(`[sbar-live] examine: ${examined}`);
  await page.waitForTimeout(3000);
  await page.evaluate(`window.acDebug.sendTalk('@setproperty PropertyInt.Structure ${DRAIN_TO}')`);
  await waitFor(async () => (await kitInventoryState(page)).structure === DRAIN_TO, 20_000, `structure drains to ${DRAIN_TO}`);
  checks['drain-structure-arrived'] = true;
  const drained = await kitInventoryState(page);
  notes.drainedEntry = drained;
  console.log(`[sbar-live] drained kit: structure=${drained.structure}/${drained.maxStructure}`);

  // ── 3. METER ──
  const bar = await renderedBar(page);
  notes.barDrained = bar;
  const frac = DRAIN_TO / (drained.maxStructure ?? 1);
  const expectFillPx = Math.round(frac * 30);
  checks['bar-rendered'] = bar.bars === 1;
  checks['bar-geometry'] = bar.left === '26px' && bar.top === '1px' && bar.width === '5px' && bar.height === '30px';
  checks['bar-track-texture'] = bar.trackIsBgTex === true;
  checks['bar-fill-texture'] = bar.fillIsFillTex === true;
  checks['bar-fill-bottom-anchored'] = bar.fillBottom === '0px';
  checks['bar-fill-height'] = bar.fillHeight === `${expectFillPx}px`;
  notes.expectFillPx = expectFillPx;
  console.log(`[sbar-live] bar: ${JSON.stringify(bar)} (expect fill ${expectFillPx}px)`);
  await page.screenshot({ path: join(OUT, '2-drained-bar.png') });

  // Zoomed crop of the kit's cell for the side-by-side.
  const cellBox = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const gridEl = ui.inventoryPanelHandle.elements.get(0x100001cf);
    const itemGrid = gridEl.querySelector('div[style*="grid"]');
    for (const cell of itemGrid.children) {
      if (cell.querySelector('[data-structure-bar]')) {
        const r = cell.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    return null;
  })()`) as { x: number; y: number; width: number; height: number } | null;
  if (cellBox) {
    await page.screenshot({ path: join(OUT, '3-cell-crop.png'), clip: cellBox });
  }

  const allPass = Object.values(checks).every(Boolean);
  const verdict = { task: 'BUG.structure-maxstructure-discarded', kitWcid: KIT_WCID, checks, notes, allPass, at: new Date().toISOString() };
  writeFileSync(join(OUT, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log(`[sbar-live] ${allPass ? 'ALL CHECKS PASS' : 'FAILURES'}: ${JSON.stringify(checks)}`);

  await browser.close();
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error('[sbar-live] fatal:', e); process.exit(2); });
