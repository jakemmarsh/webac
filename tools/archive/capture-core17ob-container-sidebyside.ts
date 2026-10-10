/**
 * CORE.17.o.b — side-by-side evidence for the external-container panel grid.
 *
 * Composes (no browser driving — the live frames come from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-container-bookshelf-over-world`
 * on the pre-fix and fixed builds, saved as
 * verification/core17ob/{before,after}-hud-container-bookshelf-over-world.png):
 *
 *   core17ob-container-sidebyside.png
 *     ours BEFORE (2x panel crop: the open bookshelf drew no cells at all)
 *     | ours AFTER (2x: exactly the bookshelf's ten ItemsCapacity cells as
 *       empty tiles — two rows of six + four)
 *     then the whole screens before | after.
 *
 * Retail: the corpus holds no frame of an open container; the retail side
 * rests on the decomp (gmExternalContainerUI::SetGroundObject @ 004cbbd0 →
 * ItemList_OpenContainer @ 004e4ae0 → ItemList_SetParentContainer →
 * ItemList_UpdateContainerListSize @ 004e39e0 → UpdateFixedSlots @ 004e3910)
 * and the DAT (layout 0x21000008, the retail panel — CORE.17.o.c).
 *
 * Ours (1568x775 capture, 1024x768 HUD at 1.0): the panel is at x 268..534,
 * y 178..484.
 *
 * Usage: npx tsx tools/capture-core17ob-container-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17ob');
const BEFORE = join(OUT, 'before-hud-container-bookshelf-over-world.png');
const AFTER = join(OUT, 'after-hud-container-bookshelf-over-world.png');
const ZOOM = 2;
const PANEL = { x: 268, y: 178, w: 266, h: 306 };

function dataUrl(file: string): string {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}
function cropCell(file: string, label: string): string {
  const z = ZOOM;
  return `<div class="cell"><div class="lbl">${label}</div>
    <div class="clip" style="width:${PANEL.w * z}px;height:${PANEL.h * z}px">
      <img src="${dataUrl(file)}" style="position:absolute;left:${-PANEL.x * z}px;top:${-PANEL.y * z}px;transform-origin:0 0;transform:scale(${z});image-rendering:pixelated"/>
    </div></div>`;
}

async function main(): Promise<void> {
  for (const f of [BEFORE, AFTER]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1400 } });
  const css = `<style>
    body{background:#111;color:#ddd;font:14px sans-serif;margin:12px}
    h1{font-size:16px;margin:0 0 8px}
    .row{display:flex;gap:12px;align-items:flex-start;margin-bottom:16px}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{font-size:13px;color:#ccc;max-width:540px}
    .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
    img.full{width:1170px;border:1px solid #444}
    .note{font-size:12px;color:#aaa;max-width:2300px;margin-bottom:10px}
  </style>`;
  await page.setContent(`${css}<h1>CORE.17.o.b — external container (ACE bookshelf 1115, ItemsCapacity 10): the panel list is a fixed ten-cell grid (retail: SetGroundObject @ 004cbbd0 → ItemList_OpenContainer @ 004e4ae0 → ItemList_UpdateContainerListSize @ 004e39e0 → UpdateFixedSlots @ 004e3910)</h1>
    <div class="note">Retail: no frame of an open container exists in the reference corpus. The cell count rests on the decompiled EoL client: the ground container's pwd._itemsCapacity (bookshelf 10, signed char on the wire, Openable bit set by ACE on an unlocked Container) becomes attribute 0x10000015 of the item list and the list is sized to exactly that many UIItem cells; -1 (chests / corpses) pads the visible area. The panel's SURFACE is still ours, not retail's: retail hosts this list in layout 0x21000008 — an 800x110 strip at y 400 with the container's icon, the nested-container list, one 32-px item row + a bar, and a close box; no "Take All" (the string does not exist in acclient.exe) — filed as CORE.17.o.c.</div>
    <div class="row">
      ${cropCell(BEFORE, 'ours BEFORE (2x) — "Loot": the open bookshelf drew NO cells (only the occupied ones would draw; an empty list was blank) + our Take All')}
      ${cropCell(AFTER, 'ours AFTER (2x) — exactly the bookshelf\'s ten ItemsCapacity cells as empty recessed tiles (two rows: six + four), blank list region below')}
    </div>
    <h1>whole screens (1568x775, SwiftShader, live ACE stack): ours BEFORE | ours AFTER</h1>
    <div class="row">
      <div class="cell"><div class="lbl">ours BEFORE</div><img class="full" src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER</div><img class="full" src="${dataUrl(AFTER)}"/></div>
    </div>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17ob-container-sidebyside.png'), fullPage: true });
  console.log(`[core17ob] wrote ${join(OUT, 'core17ob-container-sidebyside.png')}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
