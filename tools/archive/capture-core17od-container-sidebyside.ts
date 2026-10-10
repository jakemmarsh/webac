/**
 * CORE.17.o.d — side-by-side evidence for the external-container strip's
 * GUID-tracked open state (retail UIElement_ItemList parentContainerID /
 * openItemID) vs the pre-fix list-index tracking.
 *
 * Composes (no browser driving — the live frames come from
 * `npx tsx tools/capture-ui-screens.ts --scenes <scene>` on the pre-fix and
 * fixed builds, saved under verification/core17od/):
 *
 *   core17od-container-sidebyside.png
 *     rows 1-4: the live house Storage (ACE 9687, 26 fixed cells) on the ACE
 *       stack — a Sack stored, the Sack's cell clicked (open), the OPEN Sack
 *       taken back, the ground cell clicked — ours BEFORE | ours AFTER (2x
 *       crops of the strip's left 860 px)
 *     row 5: the seeded chest with two nested packs, the Pouch open, the
 *       Sack (first) taken — BEFORE (the index ran off the list: the chest's
 *       row + marker) | AFTER (the Pouch's row by guid, no marker)
 *     row 6: whole screens of the open-Sack-taken state, before | after
 *
 * Retail: no frame of an open container exists in the reference corpus; the
 * retail side rests on the decompiled EoL client + the exe's disassembly
 * (gmExternalContainerUI::RecvNotice_ServerSaysMoveItem @ 004cbb30,
 * UIElement_ItemList::ServerSaysMoveItem @ 004e5000, ItemList_Flush @
 * 004e3d60, ListenToElementMessage @ 004e4d50).
 *
 * Usage: npx tsx tools/capture-core17od-container-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17od');
const ZOOM = 2;
const STRIP = { x: 0, y: 396, w: 860, h: 118 };
const STATES: Array<{ key: string; label: string; before: string; after: string }> = [
  { key: 'storage-pack-stored', label: 'a Sack stored into the live Storage while its own row is open — BOTH: the sack in the nested list and as a row item; the storage cell keeps its marker (the top list never refreshes)',
    before: 'BEFORE: same', after: 'AFTER: same' },
  { key: 'storage-pack-open', label: 'the Sack\'s nested cell clicked — the row re-parented to the sack (its 24 fixed cells), the ONE marker moved from the storage cell to the sack\'s',
    before: 'BEFORE: same', after: 'AFTER: same' },
  { key: 'storage-open-pack-taken', label: 'the OPEN Sack taken back over the wire (ACE InventoryPut → player)',
    before: 'BEFORE: the row fell back to the storage (26 cells) with the storage cell marked open', after: 'AFTER (retail): nothing re-parents the row — still the sack\'s 24 cells; the nested list empty; NO marker anywhere (ItemList_Flush on the nested list; the storage cell\'s was cleared when the sack opened)' },
  { key: 'storage-ground-cell', label: 'the storage\'s own cell clicked afterwards',
    before: 'BEFORE: unchanged (already there)', after: 'AFTER: the row back on the storage — 26 cells — and its marker again' },
  { key: 'seeded-other-pack-taken', label: 'the seeded chest, two nested packs, the Pouch (second) open, then the Sack (first) leaves',
    before: 'BEFORE: the index-tracked slot ran off the shortened list — the chest\'s eight items + the chest cell marked', after: 'AFTER (retail): the row stays the Pouch\'s by GUID — ten fixed cells, the Ruby — with no marker (the nested list\'s refresh flushed it)' },
];

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
  const rows: string[] = [];
  for (const s of STATES) {
    const before = join(OUT, `before-hud-container-${s.key}-over-world.png`);
    const after = join(OUT, `after-hud-container-${s.key}-over-world.png`);
    for (const f of [before, after]) if (!existsSync(f)) throw new Error(`missing ${f}`);
    rows.push(`<h2>${s.label}</h2><div class="row">${crop(before, s.before, STRIP)}${crop(after, s.after, STRIP)}</div>`);
  }
  const wholeB = join(OUT, 'before-hud-container-storage-open-pack-taken-over-world.png');
  const wholeA = join(OUT, 'after-hud-container-storage-open-pack-taken-over-world.png');
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 3560, height: 1400 } });
  const css = `<style>
    body{background:#111;color:#ddd;font:14px sans-serif;margin:12px}
    h1{font-size:16px;margin:0 0 8px}
    h2{font-size:14px;margin:14px 0 4px;color:#eee;font-weight:normal}
    .row{display:flex;gap:12px;align-items:flex-start;margin-bottom:6px;flex-wrap:wrap}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{font-size:13px;color:#ccc;max-width:1720px}
    .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
    img.full{width:1720px;border:1px solid #444}
    .note{font-size:12px;color:#aaa;max-width:3500px;margin-bottom:10px}
  </style>`;
  await page.setContent(`${css}<h1>CORE.17.o.d — the external-container strip's open state is GUID-tracked like retail's UIElement_ItemList (parentContainerID / openItemID), never a list index; the nested list's refresh flushes its marker; nothing re-parents the row when its container leaves; the exe disassembly overturns the "re-open the first remaining nested container" premise</h1>
    <div class="note">Retail: no frame of an open container is in the reference corpus. The retail side rests on the decompiled EoL client + acclient.exe: gmExternalContainerUI::RecvNotice_ServerSaysMoveItem @ 004cbb30 (ecx = this + 0x5f8: [ecx+0x14] = m_itemList 0x60c, [ecx+0x10] = m_containerList 0x608, [ecx+0xc] = m_topContainer 0x604 — PostInit @ 004cbde0 stores 0x10000064 / 0x10000067 / 0x1000006a there) fires for the ITEM ROW's openItemID and calls ItemList_OpenFirstContainer on m_topContainer (the ground cell); UIElement_ItemList::ServerSaysMoveItem @ 004e5000 refreshes a container list whose parent a container moved into / out of (ItemList_SetParentContainer(this, parent, 1, 1) → ItemList_Flush @ 004e3d60: openItemID = 0 + UpdateOpenContainerIndicator(0); ItemList_AddItem @ 004e3e00 restores no marker); the row (containerList false) skips container moves and nothing re-parents it; ListenToElementMessage @ 004e4d50: message 7 on a container-list cell → ItemList_SetParentList (clears the other list's marker) + SetParentContainer(child) + openItemID; message 10 on a row cell → ItemHolder::UseObject. Live frames: the ACE stack, SwiftShader, 1568x775 — a house Storage (ACE 9687: ItemsCapacity 26, ContainersCapacity 1 — the one ground container ACE lets a pack into; opened through IgnoreHouseBarriers), and the seeded two-pack chest (acDebug.testContainer). Remaining difference: retail's row after the open pack left lists the moved pack's contents live (they are objects in the player's pack); ours keeps the last snapshot until a cell click.</div>
    ${rows.join('')}
    <h2>whole screens (1568x775) — the OPEN Sack taken back: ours BEFORE | ours AFTER</h2>
    <div class="row">
      <div class="cell"><div class="lbl">ours BEFORE</div><img class="full" src="${dataUrl(wholeB)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER</div><img class="full" src="${dataUrl(wholeA)}"/></div>
    </div>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17od-container-sidebyside.png'), fullPage: true });
  console.log(`[core17od] wrote ${join(OUT, 'core17od-container-sidebyside.png')}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
