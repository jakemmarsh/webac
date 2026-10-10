/**
 * CORE.17.o.a — side-by-side evidence for the openable side-pack grid.
 *
 * Composes (no browser driving — the live frames come from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-inventory-sidepack-over-world`
 * on the pre-fix and fixed builds, saved as
 * verification/core17oa/{before,after}-hud-inventory-sidepack-over-world.png):
 *
 *   core17oa-sidepack-sidebyside.png
 *     nearest retail reference (reference/images/hud/inventory-panel.jpg —
 *       ToD-era, MAIN pack open; the corpus holds no retail frame of a side
 *       pack open, so the side-pack row count rests on the decomp:
 *       ItemList_UpdateContainerListSize @ 004e39e0 → UpdateFixedSlots @
 *       004e3910, and UpdateEmptySlots @ 004e3700 padding only at -1)
 *     | ours BEFORE (2x panel crop: the pack padded to 9 visible rows)
 *     | ours AFTER (2x: the ACE backpack's 24 cells = 4 rows, blank below)
 *     then the whole screens before | after.
 *
 * Ours (1568x775 capture, 1024x768 HUD at 1.0): the docked panel is at
 * x 1266..1568, y 140..675.
 *
 * Usage: npx tsx tools/capture-core17oa-sidepack-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17oa');
const TOD_REF = join(REPO, 'reference/images/hud/inventory-panel.jpg');
const BEFORE = join(OUT, 'before-hud-inventory-sidepack-over-world.png');
const AFTER = join(OUT, 'after-hud-inventory-sidepack-over-world.png');
const ZOOM = 2;
const PANEL = { x: 1266, y: 140, w: 302, h: 535 };

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
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
    .lbl{font-size:13px;color:#ccc;max-width:620px}
    .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
    img.full{width:1170px;border:1px solid #444}
    .note{font-size:12px;color:#aaa;max-width:2300px;margin-bottom:10px}
  </style>`;
  await page.setContent(`${css}<h1>CORE.17.o.a — openable side pack: fixed ItemsCapacity grid (retail: ItemList_UpdateContainerListSize @ 004e39e0 → UpdateFixedSlots @ 004e3910; UpdateEmptySlots @ 004e3700 pads only at attribute -1)</h1>
    <div class="note">Retail: no frame of a side pack open exists in the reference corpus; the nearest retail reference is the ToD-era main-pack panel. The row count rests on the decompiled EoL client: an Openable container's pwd._itemsCapacity (ACE backpack 136 = 24, signed char on the wire) becomes attribute 0x10000015 and the list is sized to exactly that many UIItem cells; the visible-area padding runs only while the attribute is -1.</div>
    <div class="row">
      <div class="cell"><div class="lbl">nearest retail reference — ToD-era inventory-panel.jpg (MAIN pack open; wrong-era chrome per CORE.17.l)</div><img src="${dataUrl(TOD_REF)}" style="border:1px solid #444"/></div>
      ${existsSync(TOD_REF) ? '' : ''}
      ${cropCell(BEFORE, 'ours BEFORE (2x) — "Contents of Pack": the empty backpack padded to 9 visible rows (54 cells) + a scrollbar')}
      ${cropCell(AFTER, 'ours AFTER (2x) — "Contents of Pack": exactly the backpack\'s 24 cells (4 rows), blank list region below, no bar')}
    </div>
    <h1>whole screens (1568x775, SwiftShader, live ACE stack): ours BEFORE | ours AFTER</h1>
    <div class="row">
      <div class="cell"><div class="lbl">ours BEFORE</div><img class="full" src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER</div><img class="full" src="${dataUrl(AFTER)}"/></div>
    </div>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17oa-sidepack-sidebyside.png'), fullPage: true });
  console.log(`[core17oa] wrote ${join(OUT, 'core17oa-sidepack-sidebyside.png')}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
