/**
 * CORE.10.d live verification — split-on-drag consumes the toolbar split
 * size, against the REAL ACE server.
 *
 * Exercises, end-to-end over the wire:
 *  1. @ci 273 5000 pyreals → click the stack (selects + seeds split full).
 *  2. Entry box → 1200, drag the stack onto an EMPTY cell of its own pack
 *     → StackableSplitToContainer (split in place) → ACE answers with a
 *     new 1200 stack + SetStackSize 3800.
 *  3. Select the 3800 stack, entry → 300, drag it onto the 1200 stack →
 *     StackableMerge amount 300 (partial merge) → 3500 / 1500.
 *  4. Select the 1500 stack (split stays full), drag onto the 3500 stack
 *     → full merge → single 5000 stack.
 *  5. Entry → 250, drag onto the 3D canvas → StackableSplitTo3D → stack
 *     shrinks to 4750 (SetStackSize round trip).
 *
 * Usage: npx tsx tools/verify-core10d-live.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core10d';
const OUT = join(__dir, '..', 'verification', 'core10d');

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
    ui.wizard.name = 'Split Tester';
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

interface Stack { idx: number; guid: number; stackSize: number }
async function pyrealStacks(page: Page): Promise<Stack[]> {
  return page.evaluate(`(() => {
    const items = window.__ac.playerState.inventory.getAll();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.name.startsWith('Pyreal') && it.stackable) {
        out.push({ idx: i, guid: it.id, stackSize: it.stackSize });
      }
    }
    return out.sort((a, b) => b.stackSize - a.stackSize);
  })()`) as Promise<Stack[]>;
}

/** Click the inventory grid cell of the stack with the given guid. */
async function clickStackCell(page: Page, guid: number): Promise<boolean> {
  const r = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const items = ui.inventoryItems;
    const cells = document.querySelectorAll('[title^="Pyreal"]');
    for (const el of cells) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      // Match the cell to the guid via its rendered title stack count.
      const it = items.find(x => x && x.id === ${guid});
      if (!it) return null;
      const nm = it.stackSize >= 2 ? (it.pluralName || (it.name.endsWith('s') ? it.name + 'es' : it.name + 's')) : it.name; const expTitle = nm + (it.stackSize > 1 ? ' (' + it.stackSize + ')' : '');
      if (el.getAttribute('title') === expTitle) {
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
    }
    return null;
  })()`) as { x: number; y: number } | null;
  if (!r) return false;
  await page.mouse.click(r.x, r.y);
  await page.waitForTimeout(600);
  const sel = await page.evaluate(`(() => {
    const t = window.__ac.gameUI.hudState.target;
    return t ? t.id : 0;
  })()`) as number;
  return sel === guid;
}

async function setSplitEntry(page: Page, value: number): Promise<{ splitSize: number; maxSplitSize: number }> {
  const entry = await page.evaluate(`(() => {
    const el = document.querySelector('#tb-stack-entry');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`) as { x: number; y: number } | null;
  if (!entry) throw new Error('split entry box not visible');
  await page.mouse.click(entry.x, entry.y);
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  return page.evaluate(`window.__ac.gameUI.getToolbarSplitState()`) as Promise<{ splitSize: number; maxSplitSize: number }>;
}

/**
 * Synthetic HTML5 drag from the grid cell of `guid` onto a target:
 *  - 'empty'  → first empty cell in the item grid
 *  - 'canvas' → the 3D viewport
 *  - number   → the grid cell of that stack guid
 */
async function dragStack(page: Page, guid: number, target: 'empty' | 'canvas' | number): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const items = ui.inventoryItems;
    const findCell = (g) => {
      const it = items.find(x => x && x.id === g);
      if (!it) return null;
      const nm = it.stackSize >= 2 ? (it.pluralName || (it.name.endsWith('s') ? it.name + 'es' : it.name + 's')) : it.name; const expTitle = nm + (it.stackSize > 1 ? ' (' + it.stackSize + ')' : '');
      for (const el of document.querySelectorAll('[title^="Pyreal"]')) {
        if (el.getAttribute('title') === expTitle && el.getBoundingClientRect().width > 0) return el;
      }
      return null;
    };
    const src = findCell(${guid});
    if (!src) return 'no-src-cell';
    let tgt = null;
    const targetSpec = ${typeof target === 'number' ? target : `'${target}'`};
    if (targetSpec === 'canvas') {
      tgt = document.getElementById('game-canvas');
    } else if (targetSpec === 'empty') {
      // Empty cells: siblings of src in the grid with no title attribute.
      for (const el of src.parentElement.children) {
        if (!el.getAttribute('title') && el.getBoundingClientRect().width > 0) { tgt = el; break; }
      }
    } else {
      tgt = findCell(targetSpec);
    }
    if (!tgt) return 'no-target';
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    tgt.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    tgt.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    return 'dropped';
  })()`) as Promise<string>;
}

async function main(): Promise<void> {
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

  // ── Seed: 5000 pyreals, open inventory ───────────────────────────
  await page.evaluate(`window.acDebug.sendTalk('@ci 273 5000')`);
  await page.waitForTimeout(5000);
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.inventoryVisible) ui.toggleInventory();
  })()`);
  await page.waitForTimeout(1500);
  let stacks = await pyrealStacks(page);
  check('seed-5000', stacks.length === 1 && stacks[0].stackSize === 5000, JSON.stringify(stacks));
  if (stacks.length !== 1) { await browser.close(); process.exit(1); }

  // ── 1. Split in place: select, entry=1200, drag → empty cell ─────
  check('select-stack', await clickStackCell(page, stacks[0].guid), 'click selects the 5000 stack');
  let split = await setSplitEntry(page, 1200);
  check('entry-1200', split.splitSize === 1200 && split.maxSplitSize === 5000, JSON.stringify(split));
  await page.screenshot({ path: join(OUT, 'core10d-before-split-drag.png') });
  let res = await dragStack(page, stacks[0].guid, 'empty');
  check('split-drag-dispatched', res === 'dropped', res);
  await page.waitForTimeout(3500);
  stacks = await pyrealStacks(page);
  check('split-round-trip-3800-1200',
    stacks.length === 2 && stacks[0].stackSize === 3800 && stacks[1].stackSize === 1200,
    JSON.stringify(stacks));
  await page.screenshot({ path: join(OUT, 'core10d-after-split-3800-1200.png') });

  // ── 2. Partial merge: select 3800, entry=300, drag onto 1200 ─────
  if (stacks.length === 2) {
    check('select-3800', await clickStackCell(page, stacks[0].guid), 'click selects the 3800 stack');
    split = await setSplitEntry(page, 300);
    check('entry-300', split.splitSize === 300 && split.maxSplitSize === 3800, JSON.stringify(split));
    res = await dragStack(page, stacks[0].guid, stacks[1].guid);
    check('merge-drag-dispatched', res === 'dropped', res);
    await page.waitForTimeout(3500);
    stacks = await pyrealStacks(page);
    check('partial-merge-3500-1500',
      stacks.length === 2 && stacks[0].stackSize === 3500 && stacks[1].stackSize === 1500,
      JSON.stringify(stacks));
    await page.screenshot({ path: join(OUT, 'core10d-after-partial-merge.png') });
  }

  // ── 3. Full merge: select 1500 (split seeds full), drag onto 3500 ─
  if (stacks.length === 2) {
    check('select-1500', await clickStackCell(page, stacks[1].guid), 'click selects the 1500 stack');
    split = await page.evaluate(`window.__ac.gameUI.getToolbarSplitState()`) as { splitSize: number; maxSplitSize: number };
    check('full-seeded', split.splitSize === split.maxSplitSize && split.maxSplitSize === 1500, JSON.stringify(split));
    res = await dragStack(page, stacks[1].guid, stacks[0].guid);
    check('full-merge-dispatched', res === 'dropped', res);
    await page.waitForTimeout(3500);
    stacks = await pyrealStacks(page);
    check('full-merge-5000', stacks.length === 1 && stacks[0].stackSize === 5000, JSON.stringify(stacks));
  }

  // ── 4. Split to 3D: select, entry=250, drag onto the canvas ──────
  if (stacks.length === 1) {
    check('select-for-3d', await clickStackCell(page, stacks[0].guid), 'click selects the 5000 stack');
    split = await setSplitEntry(page, 250);
    check('entry-250', split.splitSize === 250, JSON.stringify(split));
    res = await dragStack(page, stacks[0].guid, 'canvas');
    check('3d-drag-dispatched', res === 'dropped', res);
    await page.waitForTimeout(4000);
    stacks = await pyrealStacks(page);
    check('split-to-3d-4750', stacks.length === 1 && stacks[0].stackSize === 4750, JSON.stringify(stacks));
    await page.screenshot({ path: join(OUT, 'core10d-after-3d-split.png') });
  }

  await browser.close();
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
