/**
 * CORE.10.e live verification — PluralName parsed from CreateObject and
 * used for stack labels, against the REAL ACE server.
 *
 * Exercises, end-to-end over the wire:
 *  1. @ci 7975 5 (Vial of Berimphur Dye) → weenie 7975 defines
 *     PropertyString.PluralName "Vials of Berimphur Dye" → ACE sets
 *     WeenieHeaderFlag 0x1 → parseCreateObject captures it →
 *     InventoryItem.pluralName; the title reads "Vials of Berimphur Dye
 *     (5)" — the +s fallthrough would say "Vial of Berimphur Dyes", so
 *     this distinguishes the wire plural from client-side pluralize.
 *  2. @ci 273 5000 pyreals → weenie 273 defines NO PluralName (verified
 *     in ace_world weenie_properties_string) → wire pluralName '' →
 *     title "Pyreals (5000)" via the NAME_PLURAL +s fallthrough.
 *  3. Clicking the pyreal stack drives the toolbar strip: label
 *     "5000 Pyreals (of <CoinValue>)" ("%d %hs (of %d)", %hs =
 *     GetObjectName(NAME_APPROPRIATE)).
 *
 * Usage: npx tsx tools/verify-core10e-live.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core10e';
const OUT = join(__dir, '..', 'verification', 'core10e');

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
    ui.wizard.name = 'Plural Tester';
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

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  results.push({ name, pass: cond, detail });
}

async function pyrealItems(page: Page): Promise<Array<{ guid: number; stackSize: number; pluralName?: string; name: string }>> {
  return page.evaluate(`(() => {
    const items = window.__ac.playerState.inventory.getAll();
    return items.filter(it => it && it.name.startsWith('Pyreal') && it.stackable)
      .map(it => ({ guid: it.id, stackSize: it.stackSize, pluralName: it.pluralName, name: it.name }))
      .sort((a, b) => b.stackSize - a.stackSize);
  })()`) as Promise<Array<{ guid: number; stackSize: number; pluralName?: string; name: string }>>;
}

async function clickPyrealCell(page: Page, guid: number): Promise<boolean> {
  const r = await page.evaluate(`(() => {
    const items = window.__ac.gameUI.inventoryItems;
    const it = items.find(x => x && x.id === ${guid});
    if (!it) return null;
    const nm = it.stackSize >= 2 ? (it.pluralName || (it.name.endsWith('s') ? it.name + 'es' : it.name + 's')) : it.name;
    const expTitle = nm + (it.stackSize > 1 ? ' (' + it.stackSize + ')' : '');
    for (const el of document.querySelectorAll('[title^="Pyreal"]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && el.getAttribute('title') === expTitle) {
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

  // ── Seed a wire-plural stack + pyreals, open inventory ───────────
  await page.evaluate(`window.acDebug.sendTalk('@ci 7975 5')`);
  await page.waitForTimeout(3000);
  await page.evaluate(`window.acDebug.sendTalk('@ci 273 5000')`);
  await page.waitForTimeout(5000);
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.inventoryVisible) ui.toggleInventory();
  })()`);
  await page.waitForTimeout(1500);

  // 1. Wire plural captured end-to-end (irregular — fallthrough can't fake it)
  const vial = await page.evaluate(`(() => {
    const it = window.__ac.playerState.inventory.getAll().find(x => x && x.name === 'Vial of Berimphur Dye');
    return it ? { pluralName: it.pluralName, stackSize: it.stackSize } : null;
  })()`) as { pluralName?: string; stackSize: number } | null;
  check('wire-plural-captured', !!vial && vial.pluralName === 'Vials of Berimphur Dye',
    `vial=${JSON.stringify(vial)}`);
  const vialTitle = await page.evaluate(`(() => {
    for (const el of document.querySelectorAll('[title^="Vial"]')) {
      if (el.getBoundingClientRect().width > 0) return el.getAttribute('title');
    }
    return null;
  })()`) as string | null;
  check('cell-title-wire-plural', vialTitle === `Vials of Berimphur Dye (${vial?.stackSize ?? 0})`,
    `title=${JSON.stringify(vialTitle)}`);

  // 2. Pyreals: no wire plural in ace_world → +s fallthrough
  const stacks = await pyrealItems(page);
  check('pyreal-no-wire-plural', stacks.length >= 1 && !stacks[0].pluralName,
    `stacks=${JSON.stringify(stacks)}`);
  if (stacks.length === 0) { await browser.close(); process.exit(1); }
  const big = stacks[0];
  const title = await page.evaluate(`(() => {
    for (const el of document.querySelectorAll('[title^="Pyreal"]')) {
      if (el.getBoundingClientRect().width > 0) return el.getAttribute('title');
    }
    return null;
  })()`) as string | null;
  check('cell-title-fallthrough-plural', title === `Pyreals (${big.stackSize})`, `title=${JSON.stringify(title)}`);

  // 3. Toolbar strip label: "%d Pyreals (of %d)"
  const clicked = await clickPyrealCell(page, big.guid);
  check('stack-selected', clicked, `guid=0x${big.guid.toString(16)}`);
  // The strip name is an AC-bitmap-font canvas (no textContent) — compare
  // pixel width against the expected label rendered via the same engine,
  // and against the WRONG (singular) label to prove they differ.
  const strip = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const c = ui.targetNameHost.firstChild;
    if (!c || c.tagName !== 'CANVAS') return null;
    const coin = ui.hud.coinValue;
    const n = ui.hudState.target.stackSize;
    const exp = ui.fontRenderer.renderTextToCanvas(n + ' Pyreals (of ' + coin + ')', '#ffffff', 1);
    const wrong = ui.fontRenderer.renderTextToCanvas(n + ' Pyreal (of ' + coin + ')', '#ffffff', 1);
    return { got: c.width, expected: exp.width, wrong: wrong.width, coin };
  })()`) as { got: number; expected: number; wrong: number; coin: number } | null;
  check('toolbar-strip-plural', !!strip && strip.got === strip.expected && strip.got !== strip.wrong,
    JSON.stringify(strip));
  await page.screenshot({ path: join(OUT, 'toolbar-strip-plural.png') });

  // 4. Hover tooltip first line uses the plural
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    for (const el of document.querySelectorAll('[title^="Pyreals"]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) {
        el.dispatchEvent(new MouseEvent('mouseenter', { clientX: rect.x + 8, clientY: rect.y + 8, bubbles: false }));
        return;
      }
    }
  })()`);
  await page.waitForTimeout(1000); // showTooltip has a 350ms delay
  const tooltipFirst = await page.evaluate(`(() => {
    const tip = window.__ac.gameUI.tooltipEl;
    return tip ? tip.textContent : null;
  })()`) as string | null;
  check('tooltip-plural', !!tooltipFirst && tooltipFirst.startsWith('Pyreals'),
    `tooltip=${JSON.stringify(tooltipFirst)}`);
  await page.screenshot({ path: join(OUT, 'inventory-tooltip-plural.png') });

  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log(failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
