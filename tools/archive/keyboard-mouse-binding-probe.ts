/**
 * keyboard-mouse-binding-probe — RECON.keyboard-dialog live check (one-off).
 * Enters the world, opens Keyboard Config, and drives REAL Playwright mouse
 * input through the MapInstructions capture:
 *   1. the Camera tab's Toggle Mouselook Mapping 1 reads "Button 2" (DAT DefaultMap);
 *   2. a bare left click while the capture is up binds nothing (dialog stays);
 *   3. a right click binds Jump's Mapping 2 to "Button 1" and its context menu does not erase it;
 *   4. Ctrl+left binds Show/Hide Inventory Panel's Mapping 3, OK commits, and a
 *      Ctrl+left click over the 3D world then toggles the inventory;
 *   5. the middle button over the world still mouse-looks.
 * Usage: npx tsx tools/archive/keyboard-mouse-binding-probe.ts
 * Writes verification/keyboard-mouse/<utc>/{*.png,result.json}.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { REPO, enterWorld } from '../lib/game-session.ts';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(REPO, 'verification/keyboard-mouse', stamp);
mkdirSync(OUT, { recursive: true });
const result: Record<string, unknown> = {};
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(OUT, `${name}.png`) });

const { browser, page } = await enterWorld({ settleMs: 3000 });
try {
  // Start from the shipped defaults (this browser profile may carry a saved keymap).
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.keybindRegistry.resetToDefaults(); })()`);

  const openTab = (cls: number) => page.evaluate(`(() => { const ui = window.__ac.gameUI;
    if (!ui.isKeyboardConfigOpen()) ui.toggleKeyboardConfigPanel(); ui.keyboardConfigTab = ${cls}; ui.refreshKeyboardTabs(); })()`);
  const btn = (row: string, slot: number) =>
    page.locator(`[data-keybind-row="${row}"] [data-keybind-slot="${slot}"]`);
  const scrollTo = (row: string) => page.evaluate(`(() => { const r = document.querySelector('[data-keybind-row="${row}"]');
    const vp = r.closest('[data-keybind-list]'); vp.scrollTop = parseFloat(r.style.top); })()`);
  const dialogUp = () => page.evaluate(`!!document.getElementById('ac-keyboard-map-dialog')`);

  // 1. Camera tab (ActionClass.Camera = 2)
  await openTab(2);
  await page.waitForTimeout(500);
  await scrollTo('Toggle Mouselook');
  result.toggleMouselookLabel = await btn('Toggle Mouselook', 0).getAttribute('data-keybind-label');
  await shot(page, '1-camera-tab');

  // 2 + 3. Movement tab (1): Jump Mapping 2
  await openTab(1);
  await page.waitForTimeout(300);
  await scrollTo('Jump');
  await btn('Jump', 1).click();
  await page.waitForTimeout(300);
  await shot(page, '2-map-instructions');
  await page.mouse.click(780, 600); // bare left click: ignored
  result.dialogUpAfterLeftClick = await dialogUp();
  const box = await btn('Jump', 1).boundingBox();
  // right-click ON the Mapping button: the bound press's context menu must not erase it
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });
  await page.waitForTimeout(300);
  result.jumpAfterRightClick = await page.evaluate(`window.__ac.gameUI.keybindRegistry.getMappings(
    Number('0x' + document.querySelector('[data-keybind-row="Jump"]').dataset.keybindAction))`);
  result.jumpLabelSlot2 = await btn('Jump', 1).getAttribute('data-keybind-label');
  result.dialogUpAfterRightClick = await dialogUp();
  await shot(page, '3-jump-bound-button1');

  // 4. UI tab (3): Show/Hide Inventory Panel Mapping 3 ← Ctrl+left
  await openTab(3);
  await page.waitForTimeout(300);
  const INV = 'Show/Hide Inventory Panel';
  await scrollTo(INV);
  await btn(INV, 2).click();
  await page.waitForTimeout(300);
  await page.keyboard.down('Control');
  await page.mouse.click(780, 600);
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  result.inventoryLabelSlot3 = await btn(INV, 2).getAttribute('data-keybind-label');
  await shot(page, '4-inventory-bound-ctrl-left');
  // OK (0x1000002c) commits
  await page.evaluate(`window.__ac.gameUI.closeKeyboardConfigPanel(true)`);
  await page.waitForTimeout(500);
  const invOpen = () => page.evaluate(`window.__ac.gameUI.inventoryVisible`);
  result.inventoryBefore = await invOpen();
  // Ctrl+left over the 3D world (the canvas, away from the HUD)
  await page.keyboard.down('Control');
  await page.mouse.click(780, 300);
  await page.keyboard.up('Control');
  await page.waitForTimeout(800);
  result.inventoryAfterCtrlClick = await invOpen();
  await shot(page, '5-world-ctrl-click-inventory');
  await page.keyboard.down('Control');
  await page.mouse.click(780, 300);
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
  result.inventoryAfterSecondCtrlClick = await invOpen();

  // 5. middle button over the world still mouse-looks
  await page.mouse.move(780, 300);
  await page.mouse.down({ button: 'middle' });
  await page.waitForTimeout(200);
  result.mouseLookWhileMiddleHeld = await page.evaluate(`window.__ac.cameraController.isMouseLookActive`);
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(200);
  result.mouseLookAfterRelease = await page.evaluate(`window.__ac.cameraController.isMouseLookActive`);

  // leave the shared account's profile on the defaults
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.keybindRegistry.resetToDefaults(); })()`);
} finally {
  writeFileSync(resolve(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log('wrote', OUT);
  await browser.close();
}
