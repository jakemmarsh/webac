/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a.a.a — live check of gmSalvageUI's drag-over
 * feedback (OnItemListDragOver @ 004cb740 → SetDragAcceptState 0x10000040 /
 * 0x10000041 on the hovered cell's 0x1000045a) and the paperdoll as a drop
 * source, on the ACE stack (Holtburg).
 *
 * @ci an Ust (20646), a rusted dirk (23320, MaterialType 62), a rusted mace
 * (23321, MaterialType 61) and a coin stack (273, no MaterialType). The mace
 * is wielded through the real onDropToSlot. The Ust opens the panel; DragEvents
 * go through the real cell / list listeners: the pyreal hovering a cell (red
 * slashed circle), the dirk hovering (green ring) then dropped, the wielded
 * mace dragged from its paperdoll slot hovering (refused — another material
 * while Salvage Multiple is off), then with the option on (green ring) and
 * dropped (listed).
 *
 *   npx tsx tools/capture-core17kbbccaaacaaaa-salvage-drag-accept.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacaaaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const TELEPORT = '@teleloc 0xA9B4016A [77.4 36.2 94.01] 1 0 0 0';
const TAG = '[core17kbbccaaacaaaa]';

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

/** The inventory index of the newest item whose weenie class is `wcid`. */
async function indexOfWcid(page: Page, wcid: number): Promise<number> {
  return page.evaluate((w) => {
    const items: any[] = (window as any).__ac?.gameUI?.inventoryItems ?? [];
    for (let i = items.length - 1; i >= 0; i--) if (items[i].weenieClassId === w) return i;
    return -1;
  }, wcid);
}

async function guidOf(page: Page, idx: number): Promise<number> {
  return page.evaluate((i) => (window as any).__ac?.gameUI?.inventoryItems?.[i]?.id ?? 0, idx);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function setDrag(page: Page, drag: { idx?: number; slot?: number }): Promise<void> {
  await page.evaluate((d) => {
    const ui = (window as any).__ac?.gameUI;
    ui.dragItemIndex = d.idx ?? -1; ui.dragSourceSlot = d.slot ?? null;
  }, drag);
}

/** Fire a real dragover on salvage cell `n`; return every cell's accept state. */
async function hoverCell(page: Page, n: number): Promise<{ states: string[]; bg: string }> {
  return page.evaluate((i) => {
    const ui = (window as any).__ac?.gameUI;
    const cells = [...ui.salvagePanel.querySelectorAll('[data-ac-salvage-cell]')] as HTMLElement[];
    cells[i].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
    const ov = (c: HTMLElement) => c.querySelector('[data-ac-drag-accept]') as HTMLElement;
    return { states: cells.map((c) => '0x' + Number(ov(c).dataset.acDragAccept).toString(16)), bg: ov(cells[i]).style.backgroundImage.slice(0, 40) };
  }, n);
}

async function leaveCell(page: Page, n: number): Promise<void> {
  await page.evaluate((i) => {
    const ui = (window as any).__ac?.gameUI;
    const cells = [...ui.salvagePanel.querySelectorAll('[data-ac-salvage-cell]')] as HTMLElement[];
    cells[i].dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
  }, n);
}

async function dropOnList(page: Page): Promise<boolean> {
  const took = await page.evaluate(() => {
    const ui = (window as any).__ac?.gameUI;
    const list = ui.salvagePanel.querySelector('[data-element-id="0x10000074"]');
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true });
    list.dispatchEvent(over);
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    return over.defaultPrevented;
  });
  await page.waitForTimeout(900);
  return took;
}

const queue = (page: Page) => page.evaluate(() => (window as any).__ac?.gameUI?.getSalvageQueue?.() ?? []);
/* eslint-enable @typescript-eslint/no-explicit-any */

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const r = await page.evaluate(() => {
    const h = (window as unknown as { __ac?: { gameUI?: { salvagePanel?: HTMLElement } } }).__ac?.gameUI?.salvagePanel;
    const b = h?.getBoundingClientRect();
    return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
  });
  if (r) await page.screenshot({ path: join(OUT, `${name}-zoom.png`), clip: { x: r.x - 10, y: r.y - 10, width: r.w + 20, height: r.h + 20 } });
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
  page.on('console', (m) => { const t = m.text(); if (t.includes(TAG)) console.log(t.slice(0, 240)); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await page.goto(`${URL}&cb=kbbccaaacaaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
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
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(0.5)); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const w of [20646, 23320, 23321, 273]) { await admin(page, `@ci ${w}`); await page.waitForTimeout(2500); }
  await page.waitForTimeout(3000);
  await page.evaluate(() => { const ui = (window as any).__ac?.gameUI; if (ui && !ui.inventoryVisible) ui.toggleInventory(); }); // eslint-disable-line @typescript-eslint/no-explicit-any

  // Wield the mace through the real paperdoll drop.
  const maceIdx = await indexOfWcid(page, 23321);
  const maceGuid = await guidOf(page, maceIdx);
  await page.evaluate((i) => { const ui = (window as any).__ac?.gameUI; const it = ui.inventoryItems[i]; ui.dragCallbacks?.onDropToSlot?.(i, it.validLocations); }, maceIdx); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(4000);
  const wield = await page.evaluate((g) => { const e = ((window as any).__ac?.gameUI?.equippedItems ?? []).find((x: any) => x.id === g); return e ? { slot: e.slot, materialType: e.materialType ?? null } : null; }, maceGuid); // eslint-disable-line @typescript-eslint/no-explicit-any
  state.wieldedMace = wield;
  console.log(`${TAG} mace wielded: ${JSON.stringify(wield)}`);
  state.salvageMultipleOption = await page.evaluate(() => (window as any).__ac?.gameUI?.optionsSettings?.salvageMultipleMaterialsAtOnce); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => { (window as any).__ac.gameUI.optionsSettings.salvageMultipleMaterialsAtOnce = false; }); // eslint-disable-line @typescript-eslint/no-explicit-any

  const ust = await indexOfWcid(page, 20646);
  await page.evaluate((i) => (window as any).__ac?.gameUI?.dragCallbacks?.onDoubleClickItem?.(i), ust); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(1500);

  await setDrag(page, { idx: await indexOfWcid(page, 273) });
  state.pyrealHover = await hoverCell(page, 0);
  await shoot(page, 'ours-pyreal-refuse');
  await leaveCell(page, 0);
  state.afterLeave = await page.evaluate(() => [...(window as any).__ac.gameUI.salvagePanel.querySelectorAll('[data-ac-drag-accept]')] // eslint-disable-line @typescript-eslint/no-explicit-any
    .map((o) => '0x' + Number((o as HTMLElement).dataset.acDragAccept).toString(16)));

  await setDrag(page, { idx: await indexOfWcid(page, 23320) });
  state.dirkHover = await hoverCell(page, 0);
  await shoot(page, 'ours-dirk-accept');
  state.dirkDropTaken = await dropOnList(page);
  state.queueAfterDirk = await queue(page);

  if (wield) {
    await setDrag(page, { slot: wield.slot });
    state.maceSlotHover = await hoverCell(page, 1);
    await shoot(page, 'ours-mace-slot-refuse');
    await page.evaluate(() => { (window as any).__ac.gameUI.optionsSettings.salvageMultipleMaterialsAtOnce = true; }); // eslint-disable-line @typescript-eslint/no-explicit-any
    state.maceSlotHoverMultiple = await hoverCell(page, 1);
    await shoot(page, 'ours-mace-slot-accept');
    state.maceDropTaken = await dropOnList(page);
    state.queueAfterMace = await queue(page);
    await shoot(page, 'ours-after-mace');
  }
  state.maceGuid = maceGuid;
  writeFileSync(join(OUT, 'ours-live-state.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));

  const img = (p: string, cap: string) => existsSync(p)
    ? `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${cap}</figcaption></figure>` : '';
  const tex = (id: string) => img(join(OUT, `${id}.png`), id);
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await sheet.setContent(`<html><body style="background:#111;color:#ddd;font:13px sans-serif;margin:12px">
  <style>figure{margin:6px;display:inline-block;vertical-align:top}img{max-width:780px;border:1px solid #444}.tex img{width:96px;image-rendering:pixelated}</style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a.a.a.a — salvage list drag-over state (live ACE, Holtburg)</h1>
  <p>Reference: no retail capture of a mid-drag salvage cell exists; the DAT is the reference — template 0x1000033a's 0x1000045a (base 0x21000037:0x1000045d): state 0x10000040 → 0x060011f9, 0x10000041 → 0x060011f8. Before this change our cells showed nothing under a drag and a paperdoll drag was ignored.</p>
  <div class="tex">${tex('0x060011f9')}${tex('0x060011f8')}</div>
  <div>${img(join(OUT, 'ours-pyreal-refuse-zoom.png'), 'pyreal (no material) over cell 0 → 0x10000041')}${img(join(OUT, 'ours-dirk-accept-zoom.png'), 'rusted dirk over cell 0 → 0x10000040')}</div>
  <div>${img(join(OUT, 'ours-mace-slot-refuse-zoom.png'), 'wielded mace (61) from the paperdoll vs the listed dirk (62), Salvage Multiple off → refuse')}${img(join(OUT, 'ours-mace-slot-accept-zoom.png'), 'the same with Salvage Multiple on → accept')}</div>
  <div>${img(join(OUT, 'ours-after-mace.png'), 'whole screen — the mace dropped from the paperdoll is listed')}</div>
  </body></html>`);
  await sheet.screenshot({ path: join(OUT, 'core17kbbccaaacaaaa-salvage-drag-accept-sidebyside.png'), fullPage: true });
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
