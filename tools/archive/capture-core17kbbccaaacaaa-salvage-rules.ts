/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a.a — live check of gmSalvageUI's acceptance
 * rules (IsItemSuitable @ 004cb040, DragItemAcceptable @ 004cb650,
 * _AddContainedItems @ 004cb4f0) on the ACE stack (Holtburg).
 *
 * @ci an Ust (20646), a rusted dirk (23320, MaterialType 62), a rusted mace
 * (23321, MaterialType 61), a coin stack (273, no MaterialType) and a
 * Pack (136); the mace is moved into the backpack through the real
 * pack-drop handler (PutItemInContainer). The Ust opens the panel; then,
 * dropped on the list through its real drop listener: the pyreal (refused —
 * no material), the Pack (its contents added: the mace, with the notice
 * "Adding contents of Pack"), the dirk (refused while the character's Salvage
 * Multiple Materials option is off — another material — then listed with it
 * on). Salvage is clicked for
 * real and ACE's result lands in chat.
 *
 *   npx tsx tools/capture-core17kbbccaaacaaa-salvage-rules.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaacaaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const TELEPORT = '@teleloc 0xA9B4016A [77.4 36.2 94.01] 1 0 0 0';
const TAG = '[core17kbbccaaacaaa]';

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

async function dropOnList(page: Page, idx: number): Promise<void> {
  await page.evaluate((i) => {
    const ui = (window as any).__ac?.gameUI;
    ui.dragItemIndex = i; ui.dragSourceSlot = null;
    const list = ui.salvagePanel.querySelector('[data-element-id="0x10000074"]');
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
  }, idx);
  await page.waitForTimeout(900);
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
      spew: (document.getElementById('hud-spew-box')?.innerText ?? '') + ' ' + Array.from(document.querySelectorAll('#hud-spew-box [data-ac-full-text]')).map((n) => (n as HTMLElement).dataset.acFullText).join(' | '),
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
  page.on('console', (m) => { const t = m.text(); if (t.includes(TAG) || /Salvage|TinkeringTool|PutItemInContainer/i.test(t)) console.log(t.slice(0, 240)); });
  const state: Record<string, unknown> = { at: new Date().toISOString() };

  await page.goto(`${URL}&cb=kbbccaaacaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
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
  for (const w of [20646, 23320, 23321, 273, 136]) { await admin(page, `@ci ${w}`); await page.waitForTimeout(2500); }
  await page.waitForTimeout(3000);
  await page.evaluate(() => { const ui = (window as any).__ac?.gameUI; if (ui && !ui.inventoryVisible) ui.toggleInventory(); }); // eslint-disable-line @typescript-eslint/no-explicit-any

  // The mace into the backpack via the real pack-drop handler.
  const packIdx = await indexOfWcid(page, 136);
  const packGuid = await guidOf(page, packIdx);
  const packSlot = await page.evaluate((g) => ((window as any).__ac?.gameUI?.sidePackGuids ?? []).indexOf(g), packGuid); // eslint-disable-line @typescript-eslint/no-explicit-any
  const maceIdx = await indexOfWcid(page, 23321);
  const maceGuid = await guidOf(page, maceIdx);
  console.log(`${TAG} pack idx ${packIdx} guid ${packGuid.toString(16)} slot ${packSlot}; mace idx ${maceIdx}`);
  await page.evaluate(({ i, s }) => (window as any).__ac?.gameUI?.dragCallbacks?.onDropToPack?.(i, s), { i: maceIdx, s: packSlot }); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(3000);
  state.maceContainer = await page.evaluate((g) => ((window as any).__ac?.gameUI?.inventoryItems ?? []).find((i: any) => i.id === g)?.containerId, maceGuid); // eslint-disable-line @typescript-eslint/no-explicit-any
  state.packGuid = packGuid;
  state.materials = await page.evaluate(() => ((window as any).__ac?.gameUI?.inventoryItems ?? []) // eslint-disable-line @typescript-eslint/no-explicit-any
    .filter((i: any) => [20646, 23320, 23321, 273, 136].includes(i.weenieClassId)) // eslint-disable-line @typescript-eslint/no-explicit-any
    .map((i: any) => ({ wcid: i.weenieClassId, name: i.name, materialType: i.materialType ?? null, objectDescFlags: i.objectDescFlags, containerId: i.containerId }))); // eslint-disable-line @typescript-eslint/no-explicit-any

  // Spy on the notice / chat sinks (the spew strip and chat draw AC-font canvases).
  await page.evaluate(() => {
    const ui = (window as any).__ac?.gameUI; // eslint-disable-line @typescript-eslint/no-explicit-any
    const w = window as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    w.__spy = { notices: [] as string[], chat: [] as string[] };
    const de = ui.displayErrorText.bind(ui);
    ui.displayErrorText = (t: string) => { w.__spy.notices.push(t); de(t); };
    const am = ui.addSystemMessage.bind(ui);
    ui.addSystemMessage = (t: string, ...rest: unknown[]) => { w.__spy.chat.push(t); am(t, ...rest); };
  });
  state.salvageMultipleOption = await page.evaluate(() => (window as any).__ac?.gameUI?.optionsSettings?.salvageMultipleMaterialsAtOnce); // eslint-disable-line @typescript-eslint/no-explicit-any
  console.log(`${TAG} Salvage Multiple Materials = ${String(state.salvageMultipleOption)}`);
  const ust = await indexOfWcid(page, 20646);
  await page.evaluate((i) => (window as any).__ac?.gameUI?.dragCallbacks?.onDoubleClickItem?.(i), ust); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(1500);
  state.empty = await probe(page);

  await dropOnList(page, await indexOfWcid(page, 273));
  state.afterPyreal = await probe(page);
  await dropOnList(page, await indexOfWcid(page, 136));
  state.afterPack = await probe(page);
  await shoot(page, 'ours-after-pack');
  await dropOnList(page, await indexOfWcid(page, 23320));
  state.afterDirk = await probe(page);
  // With the option off the dirk (MaterialType 62) is refused while the
  // list holds the mace (61) — IsItemSuitable's m_material test. Turn the
  // option on (client-side read, as PlayerModule::SalvageMultiple is) and
  // drop it again.
  state.optionForcedOn = await page.evaluate(() => { const ui = (window as any).__ac?.gameUI; const was = ui.optionsSettings.salvageMultipleMaterialsAtOnce; ui.optionsSettings.salvageMultipleMaterialsAtOnce = true; return !was; }); // eslint-disable-line @typescript-eslint/no-explicit-any
  await dropOnList(page, await indexOfWcid(page, 23320));
  state.afterDirkMultiple = await probe(page);
  await shoot(page, 'ours-queued');

  const btn = await page.evaluate(() => {
    const el = (window as any).__ac?.gameUI?.salvagePanel?.querySelector('[data-element-id="0x10000076"]'); // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  if (btn) await page.mouse.click(btn.x, btn.y);
  await page.waitForTimeout(5000);
  state.salvaged = await probe(page);
  state.spy = await page.evaluate(() => (window as any).__spy); // eslint-disable-line @typescript-eslint/no-explicit-any
  await shoot(page, 'ours-result');
  writeFileSync(join(OUT, 'ours-live-state.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));

  const img = (p: string, cap: string) => existsSync(p)
    ? `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${cap}</figcaption></figure>` : '';
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await sheet.setContent(`<html><body style="background:#111;color:#ddd;font:13px sans-serif;margin:12px">
  <style>figure{margin:6px;display:inline-block;vertical-align:top}img{max-width:780px;border:1px solid #444}.zoom img{max-width:1560px}</style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a.a.a — gmSalvageUI acceptance rules (live ACE, Holtburg)</h1>
  <p>Retail side: IsItemSuitable @ 004cb040 / DragItemAcceptable @ 004cb650 / _AddContainedItems @ 004cb4f0 (no retail frame of the salvage panel exists; the DAT + decomp are the reference). Drops: pyreal (no MaterialType) → refused; the Pack holding the rusted mace (MaterialType 61) → "Adding contents of Pack" (notice 0x1a: chat + the spew strip, which sits under the vitals plate as in retail — CORE.17.k.c.a.a.a), the mace listed; the rusted dirk (MaterialType 62) → refused while this character's Salvage Multiple Materials is off (IsItemSuitable's m_material test), listed once it is on.</p>
  <div>${img(join(REPO, 'verification', 'core17kbbccaaacaa', 'ours-queued.png'), 'before (prior cycle) — any dropped item queued')}${img(join(OUT, 'ours-after-pack.png'), 'after — pyreal refused, the Pack dropped: its mace listed')}</div>
  <div>${img(join(OUT, 'ours-queued.png'), 'after — the dirk (another material) listed once Salvage Multiple is on')}${img(join(OUT, 'ours-result.png'), 'after — Salvage clicked: ACE result in chat')}</div>
  <div class="zoom">${img(join(OUT, 'ours-after-pack-zoom.png'), 'after the pack drop (zoom)')}</div>
  </body></html>`);
  await sheet.screenshot({ path: join(OUT, 'core17kbbccaaacaaa-salvage-rules-sidebyside.png'), fullPage: true });
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
