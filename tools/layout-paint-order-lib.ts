/**
 * layout-paint-order-lib.ts — BUG.layout-zlevel-semantics-inverted scan.
 *
 * For every parent in a resolved LayoutDesc, compares the sibling paint
 * order LayoutRenderer used before the fix (the DAT zLevel applied verbatim
 * as a CSS z-index — read unsigned — else z-index auto, ties in DOM order)
 * with the retail order (retailPaintOrder: zLevel descending signed, then
 * m_uiReadOrder ascending — UIElement::CompareZLevel @ 0045fc60), and
 * reports the sibling pairs whose relative order flipped AND whose rects
 * overlap: the places where the screen can look different.
 *
 * Shared by tools/scan-layout-paint-order.ts (CLI) and
 * tests/verify-layout-zlevel-paint-order.ts.
 */
import {
  MediaType,
  IncorporationFlags,
  type ElementDesc,
  type LayoutDescData,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { retailPaintOrder } from '../packages/renderer/src/ui/LayoutPaintOrder.js';

export interface PaintOrderFlip {
  layoutId: number;
  /** 0 = the layout's top level. */
  parentId: number;
  /** Retail-BACK element of the pair (painted first in retail). */
  back: { id: number; zLevel: number; readOrder: number; hasArt: boolean };
  /** Retail-FRONT element of the pair. */
  front: { id: number; zLevel: number; readOrder: number; hasArt: boolean };
}

/** Whether an element carries image media of its own (state 0 or resting state). */
export function hasOwnArt(el: ElementDesc): boolean {
  const img = (m: { type: number }) => m.type === MediaType.Image;
  if (el.media.some(img)) return true;
  const rest = el.defaultState ? el.states.get(el.defaultState) : el.states.get(1);
  return !!rest?.media.some(img);
}

/** Pre-fix CSS order: z-index = zLevel (uint) when flagged, else auto (0); DOM order breaks ties. */
export function legacyCssPaintOrder(descs: readonly ElementDesc[]): number[] {
  const z = (d: ElementDesc) => ((d.incorporationFlags & IncorporationFlags.ZLevel) !== 0 ? d.zLevel >>> 0 : 0);
  return descs.map((_, i) => i).sort((a, b) => (z(descs[a]) - z(descs[b])) || (a - b));
}

function overlaps(a: ElementDesc, b: ElementDesc): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** LayoutRenderer hides inherited scrollbar subtrees (type 11, baseElement != 0). */
function hidden(d: ElementDesc): boolean {
  return d.type === 11 && d.baseElement !== 0;
}

function scanSiblings(layoutId: number, parentId: number, sibs: ElementDesc[], out: PaintOrderFlip[]): void {
  if (sibs.length >= 2) {
    const retailRank = new Map<number, number>();
    retailPaintOrder(sibs).forEach((idx, rank) => retailRank.set(idx, rank));
    const oldRank = new Map<number, number>();
    legacyCssPaintOrder(sibs).forEach((idx, rank) => oldRank.set(idx, rank));
    for (let i = 0; i < sibs.length; i++) {
      for (let j = i + 1; j < sibs.length; j++) {
        const a = sibs[i], b = sibs[j];
        if (hidden(a) || hidden(b) || !overlaps(a, b)) continue;
        const retailAFirst = retailRank.get(i)! < retailRank.get(j)!;
        const oldAFirst = oldRank.get(i)! < oldRank.get(j)!;
        if (retailAFirst === oldAFirst) continue;
        const [bk, fr] = retailAFirst ? [a, b] : [b, a];
        const info = (d: ElementDesc) => ({ id: d.elementId, zLevel: d.zLevel | 0, readOrder: d.uiReadOrder >>> 0, hasArt: hasOwnArt(d) });
        out.push({ layoutId, parentId, back: info(bk), front: info(fr) });
      }
    }
  }
  for (const s of sibs) scanSiblings(layoutId, s.elementId, [...s.children.values()], out);
}

/** Every overlapping sibling pair of a RESOLVED layout whose paint order the fix flips. */
export function scanLayoutPaintOrderFlips(layoutId: number, resolved: LayoutDescData): PaintOrderFlip[] {
  const out: PaintOrderFlip[] = [];
  scanSiblings(layoutId, 0, [...resolved.elements.values()], out);
  return out;
}
