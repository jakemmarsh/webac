/**
 * VISUAL3.20 — the gold-chain vertical scrollbar's thumb (used by the
 * spellbook list and the character-select skills list, GameUI.ts renderMagicPanel
 * / renderCharacterInfoPanel) decodes to a navy-blue body with gold-trimmed
 * caps, not the green body seen in reference/images/hud/spellbook-panel.jpg
 * and character-panel-skills.jpg.
 *
 * That is NOT a texture-ID bug. Tracing the real LayoutDesc chain:
 *   Magic panel (0x21000032) el 0x10000296 (the scrollbar column)
 *     -> baseElement 0x10000367 / baseLayout 0x2100003e
 *     -> child el=1 (elementId 0x1) — confirmed to be the scrollbar's
 *        draggable thumb by the decompiled retail client:
 *        `UIElement_Scrollbar::UpdateLayout` does
 *        `this->m_pWidget = UIElement::GetChild((UIElement*)this, 1);`
 *        i.e. child elementId 1 IS m_pWidget, the resizable/movable puck.
 *     -> grandchildren 0x10000364 (top cap) / 0x10000365 (mid) / 0x10000366
 *        (bottom cap), default state 0x1 -> Image media files
 *        0x06004c60 / 0x06004c63 / 0x06004c66.
 *
 * Byte-level DAT evidence settles the color question: the top/bottom caps
 * and the up/down "gem" buttons (0x06004c69/0x06004c6c) all carry
 * iteration=1 (date 2005-05-27, the original release), but the MID piece
 * (0x06004c63) carries iteration=1458, date 2013-06-05 — i.e. it was
 * deliberately recolored in a patch after the 2012 dark-UI rebrand that
 * docs/era-determination.md pins as our EoL target. The reference
 * screenshots predate that specific asset update (they show the pre-2013
 * green), so they are the wrong-era source here even though
 * REFERENCE_NOTES.md merely labels them "later UI" — see
 * reference/images/hud/REFERENCE_NOTES.md for the added caveat.
 *
 * This test pins the DAT-derived facts so a future cycle doesn't repeat the
 * same wrong-premise "fix" back to the pre-2013 green: the LayoutDesc chain
 * resolves to the exact texture IDs GameUI.ts already renders, and the mid
 * piece's iteration/date postdates the top/bottom caps.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DatDatabase,
  DatReader,
  parseMasterProperty,
  setMasterPropertyTypes,
  parseLayoutDesc,
  Texture,
} from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

const MAGIC_PANEL_LAYOUT = 0x21000032;
const SCROLL_COLUMN_ELEMENT = 0x10000296;
const SCROLLBAR_TEMPLATE_LAYOUT = 0x2100003e;

const THUMB_TOP = 0x06004c60;
const THUMB_MID = 0x06004c63;
const THUMB_BOT = 0x06004c66;
const ARROW_UP = 0x06004c69;
const ARROW_DOWN = 0x06004c6c;

function findElement(elements: Map<number, { elementId: number; children: Map<number, unknown> }>, id: number): any {
  for (const [, el] of elements) {
    const e = el as any;
    if (e.elementId === id) return e;
    const found = findElement(e.children, id);
    if (found) return found;
  }
  return null;
}

describe.skipIf(!hasDats)('VISUAL3.20: spellbook scrollbar thumb texture IDs are DAT-derived, not a load bug', () => {
  let portalDb: DatDatabase;
  let langDb: DatDatabase;

  beforeAll(() => {
    portalDb = openDat(PORTAL_DAT);
    langDb = openDat(LANG_DAT);

    const mpData = portalDb.getFileData(0x39000001);
    setMasterPropertyTypes(parseMasterProperty(new DatReader(mpData!)));
  });

  it('Magic panel layout resolves the scroll column to the shared scrollbar template', () => {
    const layoutData = langDb.getFileData(MAGIC_PANEL_LAYOUT);
    expect(layoutData).not.toBeNull();
    const layout = parseLayoutDesc(new DatReader(layoutData!));

    const scrollCol = findElement(layout.elements, SCROLL_COLUMN_ELEMENT);
    expect(scrollCol).not.toBeNull();
    expect(scrollCol.baseLayout).toBe(SCROLLBAR_TEMPLATE_LAYOUT);
  });

  it("the template's child elementId 1 (UIElement_Scrollbar's m_pWidget, GetChild(this,1)) resolves to GameUI's thumb texture IDs", () => {
    const scrollCol = findElement(
      parseLayoutDesc(new DatReader(langDb.getFileData(MAGIC_PANEL_LAYOUT)!)).elements,
      SCROLL_COLUMN_ELEMENT,
    );
    const templateLayout = parseLayoutDesc(new DatReader(langDb.getFileData(scrollCol.baseLayout)!));
    const template = findElement(templateLayout.elements, scrollCol.baseElement);
    expect(template).not.toBeNull();

    const widget = template.children.get(0x1);
    expect(widget, 'template child elementId 0x1 = m_pWidget').toBeDefined();

    // GameUI.ts reads the "normal" state (key 0x1) directly for all three
    // pieces; the ElementDesc's own defaultState field is 0x0 (no state 0x0
    // exists in the states map — the client resolves defaultState 0
    // externally, not by direct key lookup).
    const getDefaultImageFile = (childId: number): number => {
      const child = widget.children.get(childId);
      const state = child.states.get(0x1);
      const imageMedia = state.media.find((m: any) => m.type === 5 /* Image */);
      return imageMedia.file;
    };

    expect(getDefaultImageFile(0x10000364)).toBe(THUMB_TOP);
    expect(getDefaultImageFile(0x10000365)).toBe(THUMB_MID);
    expect(getDefaultImageFile(0x10000366)).toBe(THUMB_BOT);
  });

  it('the mid piece was recolored in a 2013 patch (post-2012-rebrand), unlike the top/bottom caps and gem buttons', () => {
    const topEntry = portalDb.getFileEntry(THUMB_TOP)!;
    const midEntry = portalDb.getFileEntry(THUMB_MID)!;
    const botEntry = portalDb.getFileEntry(THUMB_BOT)!;
    const upEntry = portalDb.getFileEntry(ARROW_UP)!;
    const downEntry = portalDb.getFileEntry(ARROW_DOWN)!;

    // Original 2005 release iteration for the caps + gem buttons.
    expect(topEntry.iteration).toBe(1);
    expect(botEntry.iteration).toBe(1);
    expect(upEntry.iteration).toBe(1);
    expect(downEntry.iteration).toBe(1);

    // The mid piece was touched much later — a deliberate post-rebrand recolor,
    // not an artifact of a stale/mismatched DAT fetch.
    expect(midEntry.iteration).toBeGreaterThan(1);
    const midDate = new Date(midEntry.date * 1000);
    expect(midDate.getUTCFullYear()).toBeGreaterThanOrEqual(2012);
  });

  it('all three thumb pieces decode to real, non-empty RGBA art (not a load failure)', () => {
    for (const id of [THUMB_TOP, THUMB_MID, THUMB_BOT]) {
      const data = portalDb.getFileData(id);
      expect(data, `texture 0x${id.toString(16)} present in portal.dat`).not.toBeNull();
      const rgba = Texture.read(new DatReader(data!)).toRGBA();
      expect(rgba.width).toBeGreaterThan(0);
      expect(rgba.height).toBeGreaterThan(0);
      const opaquePixels = Array.from({ length: rgba.width * rgba.height }, (_, i) => rgba.data[i * 4 + 3]).filter((a) => a > 200).length;
      expect(opaquePixels, `texture 0x${id.toString(16)} has real opaque pixel coverage`).toBeGreaterThan(0);
    }
  });
});
