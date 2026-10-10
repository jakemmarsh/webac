/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a — live capture of gmSalvageUI drawn from its
 * DAT slot (0x2100006d:0x100005fb slot 0x1000005e ← 0x2100000c:0x10000073).
 *
 * On the live ACE stack (Holtburg): @ci an Ust (20646) + two rusted weapons
 * of different materials (23320 dirk, 23321 mace); the Ust double-clicked
 * through the real inventory handler opens the panel (empty); the two
 * weapons are dropped on the list (queued: their cells + the inventory
 * trade-state overlay); the Salvage button is clicked for real — ACE
 * HandleSalvaging answers with SalvageOperationsResult, which lands in the
 * chat log as the retail sentence. Whole-screen + zoom captures and a
 * before | after sheet under verification/core17kbbccaaacaa/ (the "before"
 * is the previous cycle's verification/core17kbbccaaaca/ours-salvage*.png).
 *
 *   npx tsx tools/capture-core17kbbccaaacaa-salvage-slot.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacaa');
const BEFORE_DIR = join(REPO, 'verification', 'core17kbbccaaaca');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 2;
const UST_WCID = 20646;
const LOOT_WCIDS = [23320, 23321];
const TELEPORT = '@teleloc 0xA9B4016A [77.4 36.2 94.01] 1 0 0 0';
const TAG = '[core17kbbccaaacaa]';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const cs = (window as any).acDebug?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function admin(page: Page, cmd: string): Promise<void> {
  await page.evaluate((c) => (window as any).acDebug?.admin?.(c), cmd);
}

/** The inventory index of the newest item matching `pred` (by name / itemType). */
async function indexOf(page: Page, kind: 'ust' | 'loot', skip: number[] = []): Promise<number> {
  return page.evaluate(({ k, skip }) => {
    const items: any[] = (window as any).__ac?.gameUI?.inventoryItems ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (skip.includes(i)) continue;
      const it = items[i];
      const isUst = ((it.itemType ?? 0) & 0x20000000) !== 0;
      if (k === 'ust' ? isUst : (/rusted/i.test(it.name ?? '') && !isUst)) return i;
    }
    return -1;
  }, { k: kind, skip });
}

async function probe(page: Page) {
  return page.evaluate(() => {
    const ui = (window as any).__ac?.gameUI;
    const host: HTMLElement | null = ui?.salvagePanel ?? null;
    const rect = (e: Element | null | undefined) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const byId = (id: number) => host?.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
    const txt = (id: number) => Array.from(byId(id)?.querySelectorAll('canvas, span') ?? [])
      .map((n) => (n as HTMLElement).dataset.acFullText || n.textContent || '').join(' ');
    const chat = Array.from(document.querySelectorAll('*'))
      .map((n) => (n as HTMLElement).dataset?.acFullText ?? '')
      .filter((t) => /You obtain|Salvaging Failed|not suitable/.test(t));
    return {
      open: !!ui?.isSalvageOpen, dockPanel: ui?.transactionDockPanel ?? null,
      queue: ui?.getSalvageQueue?.() ?? [], staged: [...(ui?.salvageStagedGuids?.() ?? [])],
      host: rect(host), slot: rect(byId(0x1000005e)),
      title: txt(0x10000077), button: txt(0x10000076),
      buttonArt: byId(0x10000076)?.style.backgroundImage.slice(0, 60) ?? null,
      listW: byId(0x10000074)?.style.width ?? null,
      cells: {
        item: host?.querySelectorAll('[data-ac-salvage-cell="item"]').length ?? 0,
        empty: host?.querySelectorAll('[data-ac-salvage-cell="empty"]').length ?? 0,
      },
      barShown: byId(0x10000075)?.style.display !== 'none',
      chat: [...new Set(chat)],
    };
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const r = await page.evaluate(() => {
    const h = (window as unknown as { __ac?: { gameUI?: { salvagePanel?: HTMLElement } } }).__ac?.gameUI?.salvagePanel;
    const b = h?.getBoundingClientRect();
    return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
  });
  if (r) {
    await page.screenshot({ path: join(OUT, `${name}-zoom.png`), clip: { x: r.x - 10, y: r.y - 10, width: r.w + 20, height: r.h + 20 } });
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  await page.addInitScript('window.__name = (f) => f;');
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.includes(TAG) || /Salvage|TinkeringTool/i.test(t)) console.log(t.slice(0, 240)); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await page.goto(`${URL}&cb=kbbccaaacaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 360_000; let lastReload = Date.now();
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  console.log(`${TAG} in world`);
  await page.waitForTimeout(4000);
  await admin(page, TELEPORT);
  await page.waitForTimeout(10000);
  await page.evaluate(() => (window as unknown as { acDebug?: { freezeTimeOfDay?: (t: number) => void } }).acDebug?.freezeTimeOfDay?.(0.5));
  for (const w of [UST_WCID, ...LOOT_WCIDS]) { await admin(page, `@ci ${w}`); await page.waitForTimeout(2500); }
  await page.waitForTimeout(3000);

  // The inventory open, so the queued items' trade-state overlay shows.
  await page.evaluate(() => { const ui = (window as any).__ac?.gameUI; if (ui && !ui.inventoryVisible) ui.toggleInventory(); }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const ust = await indexOf(page, 'ust');
  console.log(`${TAG} Ust index ${ust}`);
  await page.evaluate((i) => (window as any).__ac?.gameUI?.dragCallbacks?.onDoubleClickItem?.(i), ust); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(1500);
  state.empty = await probe(page);
  await shoot(page, 'ours-empty');

  const loot: number[] = [];
  for (let n = 0; n < LOOT_WCIDS.length; n++) {
    const i = await indexOf(page, 'loot', loot);
    if (i < 0) break;
    loot.push(i);
    await page.evaluate((idx) => {
      const ui = (window as any).__ac?.gameUI; // eslint-disable-line @typescript-eslint/no-explicit-any
      ui.dragItemIndex = idx; ui.dragSourceSlot = null;
      const list = ui.salvagePanel.querySelector('[data-element-id="0x10000074"]');
      list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    }, i);
    await page.waitForTimeout(800);
  }
  state.queued = await probe(page);
  await shoot(page, 'ours-queued');

  // The real Salvage button: a mouse click at its centre.
  const btn = await page.evaluate(() => {
    const el = (window as any).__ac?.gameUI?.salvagePanel?.querySelector('[data-element-id="0x10000076"]'); // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  if (btn) await page.mouse.click(btn.x, btn.y);
  await page.waitForTimeout(5000);
  state.salvaged = await probe(page);
  await shoot(page, 'ours-result');
  writeFileSync(join(OUT, 'ours-live-state.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));

  // Before | after sheet.
  const img = (p: string, cap: string) => existsSync(p)
    ? `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${cap}</figcaption></figure>` : '';
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await sheet.setContent(`<html><body style="background:#111;color:#ddd;font:13px sans-serif;margin:12px">
  <style>figure{margin:6px;display:inline-block;vertical-align:top}img{max-width:780px;border:1px solid #444}.zoom img{max-width:1560px}</style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a.a — gmSalvageUI from its DAT slot (live ACE, Holtburg)</h1>
  <p>DAT: 0x2100006d:0x100005fb slot 0x1000005e ← 0x2100000c:0x10000073 — title 0x10000077 p23 str 177659015, list 0x10000074 (UIElement_ItemList, template 0x10000339), bar 0x10000075, button 0x10000076 (base 0x10000079: 1 = 0x06004c4c, 13 = 0x06004c4e), close 0x10000078. No retail frame of the salvage panel was found; the retail side is the DAT + decomp.</p>
  <div>${img(join(BEFORE_DIR, 'ours-salvage.png'), 'before — hand-built content in the dock slot')}${img(join(OUT, 'ours-empty.png'), 'after — empty (Ust double-clicked)')}</div>
  <div>${img(join(OUT, 'ours-queued.png'), 'after — two rusted weapons queued (inventory trade-state overlay)')}${img(join(OUT, 'ours-result.png'), 'after — Salvage clicked: list flushed, the result in chat')}</div>
  <div class="zoom">${img(join(BEFORE_DIR, 'ours-salvage-zoom.png'), 'before (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-empty-zoom.png'), 'after — empty (zoom)')}</div>
  <div class="zoom">${img(join(OUT, 'ours-queued-zoom.png'), 'after — queued (zoom)')}</div>
  </body></html>`);
  await sheet.screenshot({ path: join(OUT, 'core17kbbccaaacaa-salvage-slot-sidebyside.png'), fullPage: true });
  console.log(`${TAG} ZOOM ${ZOOM} wrote ${OUT}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
