/**
 * CORE.18.b.a.a.a.a.a.b.a — live check of the Gameplay page's "Use Mouse
 * Turning Settings" button (gmGameplayOptionsUI element 0x100005cc → global
 * message 0xc). Enters the world, shows the wheel leaves the camera alone at
 * the retail defaults, presses the button, records the chat lines, the Config
 * values and the key map, then shows the wheel zooms and the Keyboard dialog
 * names the new mappings. Evidence → verification/mouse-turning-button/.
 *
 *   npx tsx tools/probe-mouse-turning-button.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { enterWorld, REPO } from './lib/game-session.js';
import { ActionClass } from '../packages/renderer/src/input/KeybindActionClass.js';

const CAMERA_CLASS = ActionClass.Camera;

const OUT = join(REPO, 'verification', 'mouse-turning-button');

const { browser, page } = await enterWorld();
try {
  await page.waitForTimeout(4000);
  const dist = (): Promise<number> => page.evaluate('window.__ac.cameraController.cameraDistance') as Promise<number>;
  const wheelOverWorld = async (deltaY: number): Promise<void> => {
    await page.mouse.move(784, 300);
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(600);
  };
  const d0 = await dist();
  await wheelOverWorld(300);
  const dAfterDefaultWheel = await dist();

  await page.click('#tb-opt');
  await page.waitForTimeout(800);
  await page.click('[data-options-tab="gameplay"]');
  await page.waitForTimeout(800);
  const chatMark = await page.evaluate(`(() => { const c = document.getElementById('chat-messages'); if (c) for (const e of c.children) e.dataset.mtSeen = '1'; return !!c; })()`);
  await page.click('[data-element-id="0x100005cc"]');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(OUT, 'after-button.png') });
  const lines = await page.evaluate(`(() => { const c = document.getElementById('chat-messages');
    return c ? [...c.children].filter((e) => !e.dataset.mtSeen).map((e) => ((e.dataset && e.dataset.chatText) || e.textContent || '').trim()) : []; })()`) as string[];
  const state = await page.evaluate(`(() => { const ui = window.__ac.gameUI; const o = ui.optionsSettings; const r = ui.keybindRegistry;
    return { cameraStiffness: o.cameraStiffness, cameraAdjustmentSpeed: o.cameraAdjustmentSpeed, mouseLookSensitivity: o.mouseLookSensitivity,
      alignCameraToSlope: o.alignCameraToSlope, invertMouseLookYAxis: o.invertMouseLookYAxis, useMouseTurning: o.useMouseTurning,
      zoomIn: r.getMappings(0x33), zoomOut: r.getMappings(0x34), wheelZoom: window.__ac.cameraController.wheelZoom,
      savedKeymapHasWheel: (localStorage.getItem('ac_keybinds_v2') || '').includes('MouseWheelUp') }; })()`);

  // Close the options panel so the pointer is over the world again.
  await page.click('#tb-opt');
  await page.waitForTimeout(800);
  const d1 = await dist();
  await wheelOverWorld(300); // wheel down → Zoom Camera Out
  const dOut = await dist();
  await wheelOverWorld(-600); // wheel up → Zoom Camera In
  const dIn = await dist();
  // A Closer tick scales the boom by 1 − (1/fps)·AdjustmentSpeed·0.2; at a
  // SwiftShader frame rate (< 10 fps at speed 50) that is ≤ 0 and retail's
  // CameraSet refuses the step, so the in-direction is also checked with the
  // meter pinned at 60 fps (the real-GPU rate).
  const fps = await page.evaluate('window.__ac.cameraController.frameRate.fps') as number;
  await page.evaluate('(() => { const c = window.__ac.cameraController; c.__realFps = c.frameRate; c.frameRate = { fps: 60, push() {} }; })()');
  await wheelOverWorld(-300);
  const dIn60 = await dist();
  await page.evaluate('(() => { const c = window.__ac.cameraController; c.frameRate = c.__realFps; })()');
  await page.screenshot({ path: join(OUT, 'after-wheel-zoom.png') });

  // The Keyboard dialog's Camera tab shows the new Mapping 1 labels.
  await page.evaluate('window.__ac.gameUI.toggleKeyboardConfigPanel()');
  await page.waitForTimeout(1500);
  const camTab = await page.evaluate(`(() => { const t = [...document.querySelectorAll('[data-keybind-tab]')].find((e) => /camera/i.test(e.textContent || '') || e.dataset.keybindTab === String(CAMERA_CLASS)); if (!t) return false; t.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`.replace('CAMERA_CLASS', String(CAMERA_CLASS)));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'keyboard-dialog.png') });

  const result = { camTab, chatMark, d0, dAfterDefaultWheel, lines, state, d1, dOut, dIn, fps, dIn60 };
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
