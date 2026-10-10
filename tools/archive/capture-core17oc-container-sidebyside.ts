/**
 * CORE.17.o.c — side-by-side evidence for the external-container panel's
 * SURFACE: our old 260x300 "Loot" frame (0x2100001a + Take All) vs the
 * rebuild on retail's layout 0x21000008 (gmExternalContainerUI: the 110-px
 * strip at y 400 across the display — the container's own cell, the
 * nested-container list, the close box, ONE 32-px item row + its bar).
 *
 * Composes (no browser driving — the live frames come from
 * `npx tsx tools/capture-ui-screens.ts --scenes <scene>` on the pre-fix and
 * fixed builds, saved under verification/core17oc/):
 *
 *   core17oc-container-sidebyside.png
 *     row 1: ours BEFORE (2x crop of the old frame) | ours AFTER (2x crop of
 *            the strip's left 780 px) — the live ACE bookshelf 1115, empty
 *     row 2: AFTER, a live chest (ACE 143) STOCKED over ACE (items in the
 *            row; ACE refuses the sack, so the nested list is the seeded
 *            chest's) | AFTER, the seeded
 *            chest (-1 padding, seven items, a nested pouch)
 *     row 3: the whole screens before | after (the empty shelf)
 *
 * Retail: the corpus holds no frame of an open container; the retail side
 * rests on the DAT (layout 0x21000008's element tree) + the decomp
 * (gmExternalContainerUI::PostInit @ 004cbde0 / SetGroundObject @ 004cbbd0 /
 * ListenToElementMessage @ 004cbad0: the close box is its only button).
 *
 * Ours (1568x775 capture, HUD at 1:1): the old frame at x 268..534,
 * y 178..484; the strip at y 400..510 across the width.
 *
 * Usage: npx tsx tools/capture-core17oc-container-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17oc');
const BEFORE = join(OUT, 'before-hud-container-bookshelf-over-world.png');
const AFTER = join(OUT, 'after-hud-container-bookshelf-over-world.png');
const STOCKED = join(OUT, 'after-hud-container-chest-stocked-over-world.png');
const CHEST = join(OUT, 'after-hud-container-chest-contents-over-world.png');
const ZOOM = 2;
const OLD_PANEL = { x: 268, y: 178, w: 266, h: 306 };
const STRIP = { x: 0, y: 396, w: 780, h: 118 };
const STRIP_RIGHT = { x: 1568 - 300, y: 396, w: 300, h: 118 };

function dataUrl(file: string): string {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}
function crop(file: string, label: string, r: { x: number; y: number; w: number; h: number }, z = ZOOM): string {
  return `<div class="cell"><div class="lbl">${label}</div>
    <div class="clip" style="width:${r.w * z}px;height:${r.h * z}px">
      <img src="${dataUrl(file)}" style="position:absolute;left:${-r.x * z}px;top:${-r.y * z}px;transform-origin:0 0;transform:scale(${z});image-rendering:pixelated"/>
    </div></div>`;
}

async function main(): Promise<void> {
  for (const f of [BEFORE, AFTER]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const haveStocked = existsSync(STOCKED);
  const haveChest = existsSync(CHEST);
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1400 } });
  const css = `<style>
    body{background:#111;color:#ddd;font:14px sans-serif;margin:12px}
    h1{font-size:16px;margin:0 0 8px}
    .row{display:flex;gap:12px;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{font-size:13px;color:#ccc;max-width:1560px}
    .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
    img.full{width:1170px;border:1px solid #444}
    .note{font-size:12px;color:#aaa;max-width:2300px;margin-bottom:10px}
  </style>`;
  await page.setContent(`${css}<h1>CORE.17.o.c — the external-container panel rebuilt on retail's layout 0x21000008 (gmExternalContainerUI): the 110-px strip at y 400 — the container's own cell, the nested-container list, the close box, ONE 32-px item row + its bar; no "Loot" title, no Take All</h1>
    <div class="note">Retail: no frame of an open container exists in the reference corpus. The retail side rests on the DAT (0x21000008's element tree: root 0x10000063 800x110 at (0,400), edges L1 T1 R1 B2, zLevel 1000; cell 0x10000064 36x36; list 0x10000067 680x36 with the arrow pair 0x10000070; close 0x10000068 25x23 right-anchored; item row 0x1000006a 784x32; bar 0x1000006b 784x16 = the vendor list's template) and the decompiled EoL client (PostInit @ 004cbde0 resolves the three ItemLists and chains the one item row to both upper lists; ListenToElementMessage @ 004cbad0 handles only the close box; "Take All" does not occur in acclient.exe). Live frames: the ACE stack, SwiftShader, 1568x775.</div>
    <div class="row">
      ${crop(BEFORE, 'ours BEFORE (2x) — the 260x300 "Loot" frame on 0x2100001a with a six-column grid and a Take All button retail never had', OLD_PANEL)}
      ${crop(AFTER, 'ours AFTER (2x, the strip\'s left 780 px) — the live bookshelf 1115: its own icon cell, the empty nested-container list, ONE row of exactly its ten cells (CORE.17.o.b) as empty tiles inside the bordered frame; the bar hidden while the row fits', STRIP)}
      ${crop(AFTER, 'ours AFTER (2x, the strip\'s right end) — the close box rides the display\'s right edge (L2)', STRIP_RIGHT)}
    </div>
    ${haveStocked || haveChest ? `<div class="row">
      ${haveStocked ? crop(STOCKED, 'ours AFTER (2x) — a live chest (ACE 143, -1 capacity) STOCKED over ACE: apples / bread / arrows in the row with their stack counts beside the chest\'s own cell (ACE refuses the sack: chest 143 takes no packs)', STRIP) : ''}
      ${haveChest ? crop(CHEST, 'ours AFTER (2x) — a seeded chest (-1 → the row\'s visible cells padded): seven occupied cells with stack counts, the nested Sack in the container list, the chest\'s cell marked open', STRIP) : ''}
    </div>` : ''}
    <h1>whole screens (1568x775): ours BEFORE | ours AFTER (the empty shelf)</h1>
    <div class="row">
      <div class="cell"><div class="lbl">ours BEFORE</div><img class="full" src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER</div><img class="full" src="${dataUrl(AFTER)}"/></div>
    </div>
    ${haveStocked ? `<div class="row"><div class="cell"><div class="lbl">ours AFTER — the stocked chest, whole screen</div><img class="full" src="${dataUrl(STOCKED)}"/></div>${haveChest ? `<div class="cell"><div class="lbl">ours AFTER — the seeded chest, whole screen</div><img class="full" src="${dataUrl(CHEST)}"/></div>` : ''}</div>` : ''}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17oc-container-sidebyside.png'), fullPage: true });
  console.log(`[core17oc] wrote ${join(OUT, 'core17oc-container-sidebyside.png')}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
