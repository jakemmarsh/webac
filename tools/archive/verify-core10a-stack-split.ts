/**
 * CORE.10.a live verification — toolbar stack-split UI.
 *
 * Drives the real stack: seeds toolbar selections (acDebug.seedTarget) and
 * exercises the REAL inventory path via @ci 273 5000 (pyreals) + a genuine
 * mouse click on the inventory grid cell.
 *
 * Asserts:
 *  - stack of >=2 selected → dim glow 0x06004cf4 mode, split entry box +
 *    slider visible, heart meter hidden, entry seeded to the FULL stack
 *    size, thumb parked right (74px), name "%d %hs".
 *  - typing into the entry (real keyboard) clamps + syncs the slider.
 *  - dragging the slider (real mouse) sets splitSize=round(frac*max) and
 *    syncs the entry.
 *  - single selection → bright glow, widgets hidden.
 *  - REAL path: clicking a pyreal stack cell in the inventory grid selects
 *    it into the toolbar with the coin label "%d %hs (of %d)".
 *
 * Usage: npx tsx tools/verify-core10a-stack-split.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core10a';
const OUT = join(__dir, '..', 'verification', 'core10a');

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
  entryDisplay: string; sliderDisplay: string; meterDisplay: string;
  entryValue: string; thumbLeft: string; glowMode: string | undefined;
  glowDisplay: string; nameText: string;
  split: { splitSize: number; maxSplitSize: number };
}
async function stripState(page: Page): Promise<StripState> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    return {
      entryDisplay: ui.targetStackEntryWrap.style.display,
      sliderDisplay: ui.targetStackSlider.style.display,
      meterDisplay: ui.targetMeter.style.display,
      entryValue: ui.targetStackEntry.value,
      thumbLeft: ui.targetStackThumb.style.left,
      glowMode: ui.targetGlow.dataset.mode,
      glowDisplay: ui.targetGlow.style.display,
      nameText: ui.targetNameHost.textContent,
      split: ui.getToolbarSplitState(),
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

  // ── 1. Seeded stack selection ────────────────────────────────────
  await page.evaluate(`window.acDebug.seedTarget('item', 0, 100)`);
  let s = await stripState(page);
  check('stack-widgets-shown', s.entryDisplay === 'block' && s.sliderDisplay === 'block', JSON.stringify(s));
  check('stack-meter-hidden', s.meterDisplay === 'none', s.meterDisplay);
  check('stack-dim-glow', s.glowMode === 'stack' && s.glowDisplay === 'block', `${s.glowMode}/${s.glowDisplay}`);
  check('stack-seeded-full', s.entryValue === '100' && s.split.splitSize === 100 && s.split.maxSplitSize === 100, JSON.stringify(s.split));
  check('stack-thumb-right', s.thumbLeft === '74px', s.thumbLeft);
  // The name is an AC-bitmap-font canvas (no textContent). Compare its
  // pixel width against the expected label rendered via the same engine.
  const nameWidth = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const c = ui.targetNameHost.firstChild;
    if (!c || c.tagName !== 'CANVAS') return null;
    const exp = ui.fontRenderer.renderTextToCanvas('100 Arrowheads', '#ffffff', 1);
    return { got: c.width, expected: exp.width };
  })()`) as { got: number; expected: number } | null;
  check('stack-name-count', !!nameWidth && nameWidth.got === nameWidth.expected && nameWidth.got > 0, JSON.stringify(nameWidth));
  const toolbarWin = await rect(page, '#hud-toolbar-window');
  if (toolbarWin) {
    await page.screenshot({
      path: join(OUT, 'core10a-stack-selected.png'),
      clip: { x: toolbarWin.x, y: toolbarWin.y, width: toolbarWin.w, height: toolbarWin.h },
    });
  }

  // ── 2. Entry box: real keyboard ──────────────────────────────────
  const entryRect = await rect(page, '#tb-stack-entry');
  check('entry-present', !!entryRect, JSON.stringify(entryRect));
  if (entryRect) {
    await page.mouse.click(entryRect.x + entryRect.w / 2, entryRect.y + entryRect.h / 2);
    // Focus selects-all (retail msg 0x2f dwParam1!=0 → SelectAll); typing replaces.
    await page.keyboard.type('25');
    await page.keyboard.press('Enter');
    s = await stripState(page);
    check('entry-typed-25', s.split.splitSize === 25 && s.entryValue === '25', JSON.stringify(s.split));
    // 25/100 of the 74px travel ≈ 19px.
    check('entry-syncs-thumb', s.thumbLeft === '19px' || s.thumbLeft === '18px', s.thumbLeft);
    // Over-max clamps and rewrites.
    await page.mouse.click(entryRect.x + entryRect.w / 2, entryRect.y + entryRect.h / 2);
    await page.keyboard.type('9999');
    await page.keyboard.press('Enter');
    s = await stripState(page);
    check('entry-clamps-max', s.split.splitSize === 100 && s.entryValue === '100', JSON.stringify(s.split));
  }

  // ── 3. Slider: real mouse drag ───────────────────────────────────
  const sliderRect = await rect(page, '#tb-stack-slider');
  check('slider-present', !!sliderRect, JSON.stringify(sliderRect));
  if (sliderRect) {
    // Press mid-track: frac=(45-8)/74=0.5 → 50 of 100.
    await page.mouse.move(sliderRect.x + sliderRect.w / 2, sliderRect.y + sliderRect.h / 2);
    await page.mouse.down();
    await page.mouse.up();
    s = await stripState(page);
    check('slider-mid-50', Math.abs(s.split.splitSize - 50) <= 2 && s.entryValue === String(s.split.splitSize), JSON.stringify(s.split));
    // Drag to the far left: clamps to 1.
    await page.mouse.move(sliderRect.x + 4, sliderRect.y + sliderRect.h / 2);
    await page.mouse.down();
    await page.mouse.up();
    s = await stripState(page);
    check('slider-left-clamps-1', s.split.splitSize === 1, JSON.stringify(s.split));
    await page.screenshot({
      path: join(OUT, 'core10a-slider-at-1.png'),
      clip: toolbarWin ? { x: toolbarWin.x, y: toolbarWin.y, width: toolbarWin.w, height: toolbarWin.h } : undefined,
    });
  }

  // ── 4. Single selection hides the split UI ───────────────────────
  await page.evaluate(`window.acDebug.seedTarget('creature', 0.65)`);
  s = await stripState(page);
  check('single-widgets-hidden', s.entryDisplay === 'none' && s.sliderDisplay === 'none', JSON.stringify(s));
  check('single-bright-glow', s.glowMode === 'single' && s.meterDisplay === 'block', `${s.glowMode}/${s.meterDisplay}`);
  await page.evaluate(`window.acDebug.clearTarget()`);

  // ── 5. REAL path: @ci pyreals, click the inventory cell ──────────
  await page.evaluate(`window.acDebug.sendTalk('@ci 273 5000')`);
  await page.waitForTimeout(5000);
  const pyreal = await page.evaluate(`(() => {
    const items = window.__ac.playerState.inventory.getAll();
    for (let i = 0; i < items.length; i++) {
      if (items[i] && items[i].name.startsWith('Pyreal') && items[i].stackSize >= 2) {
        return { idx: i, guid: items[i].id, stackSize: items[i].stackSize, wcid: items[i].weenieClassId };
      }
    }
    return null;
  })()`) as { idx: number; guid: number; stackSize: number; wcid: number } | null;
  check('pyreals-created', !!pyreal && pyreal.stackSize >= 2, JSON.stringify(pyreal));
  if (pyreal) {
    // Open the inventory panel and click the real grid cell.
    await page.evaluate(`(() => {
      const ui = window.__ac.gameUI;
      if (!ui.inventoryVisible) ui.toggleInventory();
    })()`);
    await page.waitForTimeout(1500);
    const cellRect = await page.evaluate(`(() => {
      const cells = document.querySelectorAll('[title^="Pyreal"]');
      for (const el of cells) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) return { x: r.x, y: r.y, w: r.width, h: r.height, title: el.getAttribute('title') };
      }
      return null;
    })()`) as { x: number; y: number; w: number; h: number; title: string } | null;
    check('pyreal-cell-found', !!cellRect, JSON.stringify(cellRect));
    if (cellRect) {
      await page.mouse.click(cellRect.x + cellRect.w / 2, cellRect.y + cellRect.h / 2);
      await page.waitForTimeout(800);
      s = await stripState(page);
      const coin = await page.evaluate(`(() => {
        const t = window.__ac.gameUI.hudState.target;
        return t ? { id: t.id, isCoin: !!t.isCoin, stackSize: t.stackSize, coinValue: window.__ac.gameUI.hudState.coinValue } : null;
      })()`) as { id: number; isCoin: boolean; stackSize: number; coinValue: number } | null;
      check('real-click-selects', !!coin && coin.id === pyreal.guid && coin.isCoin, JSON.stringify(coin));
      check('real-stack-widgets', s.entryDisplay === 'block' && s.sliderDisplay === 'block' && s.glowMode === 'stack', JSON.stringify({ e: s.entryDisplay, sl: s.sliderDisplay, g: s.glowMode }));
      const coinLabel = await page.evaluate(`(() => {
        const ui = window.__ac.gameUI;
        const c = ui.targetNameHost.firstChild;
        if (!c || c.tagName !== 'CANVAS') return null;
        const t = ui.hudState.target;
        const expText = t.stackSize + ' ' + t.name + ' (of ' + ui.hudState.coinValue + ')';
        const exp = ui.fontRenderer.renderTextToCanvas(expText, '#ffffff', 1);
        return { got: c.width, expected: exp.width, expText };
      })()`) as { got: number; expected: number; expText: string } | null;
      check('real-coin-label', !!coinLabel && coinLabel.got === coinLabel.expected && coinLabel.got > 0, JSON.stringify(coinLabel));
      check('real-seeded-full', s.split.splitSize === s.split.maxSplitSize && s.split.maxSplitSize === (coin?.stackSize ?? -1), JSON.stringify(s.split));
      await page.screenshot({ path: join(OUT, 'core10a-real-pyreal-selected.png') });
      const tb = await rect(page, '#hud-toolbar-window');
      if (tb) {
        await page.screenshot({
          path: join(OUT, 'core10a-real-pyreal-toolbar.png'),
          clip: { x: tb.x, y: tb.y, width: tb.w, height: tb.h },
        });
      }
    }
  }

  await browser.close();
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
