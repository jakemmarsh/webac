/**
 * LayoutPaintOrder — the retail paint order of a DAT LayoutDesc element's
 * children. DOM-light (only style writes on elements handed in), so the
 * layout scan tooling can share it with LayoutRenderer.
 */
import type { ElementDesc } from '@ac/dat-parser/file-types/LayoutDesc.js';

/**
 * BUG.layout-zlevel-semantics-inverted — the retail paint order of one
 * parent's children, back → front (as indices into `descs`, which are in
 * creation order).
 *
 * `UIRegion::AddChild @ 006a0760` walks `m_children` from the tail and
 * inserts the new child after the first node whose comparator (vtable slot
 * +0x38, called on the EXISTING node with the new one) returns >= 0, else
 * pushes it at the head; `UIRegion::DrawChildren @ 0069fca0` paints head →
 * tail. For a UIElement that slot is `UIElement::CompareZLevel @ 0045fc60`
 * (UIElement vftable 0x79bf20 +0x38, read from acclient.exe; the bare
 * UIRegion vftable 0x801718 +0x38 is `UIRegion::CompareZLevel @ 0069f000`):
 * the SIGNED m_zlevel compare (`long` — `StateDesc` Archive-reads it as a
 * long, so 0xffffffff is -1, the lowest), and on a zLevel tie the
 * `m_desc.m_uiReadOrder` compare (unsigned). The list is therefore sorted
 * DESCENDING by zLevel, then ASCENDING by read order: the HIGHEST zLevel
 * paints FIRST (furthest back), -1 last (frontmost), and among equal
 * zLevels the higher read order is in front. A full tie inserts after the
 * existing equals (the later-added child in front), so a stable sort over
 * creation order is exact.
 */
export function retailPaintOrder(descs: ReadonlyArray<Pick<ElementDesc, 'zLevel' | 'uiReadOrder'>>): number[] {
  return descs
    .map((_, i) => i)
    .sort((a, b) =>
      ((descs[b].zLevel | 0) - (descs[a].zLevel | 0))
      || ((descs[a].uiReadOrder >>> 0) - (descs[b].uiReadOrder >>> 0))
      || (a - b));
}

/**
 * Apply {@link retailPaintOrder} to rendered sibling elements (given in
 * creation order, all already children of `parent`): re-append them to
 * `parent` back → front, so DOM order IS the retail paint order. Rendered
 * layout elements are positioned with z-index auto, and positioned z-auto
 * siblings paint in DOM order — so no CSS z-index is needed, none of the
 * DAT's zLevel magnitudes (9999, 1000, 900, …) can leak out of the parent
 * into a caller's stacking context, and overlays a caller appends later
 * still land in front with whatever z-index they choose. Nodes that are
 * not in `children` (an element's own .layout-text, drawn before its
 * children — DrawHere's DrawSelf precedes DrawChildren) keep their place
 * ahead of them.
 */
export function applyRetailPaintOrder(
  parent: HTMLElement,
  children: ReadonlyArray<{ el: HTMLElement; desc: Pick<ElementDesc, 'zLevel' | 'uiReadOrder'> }>,
): void {
  if (children.length < 2) return;
  const order = retailPaintOrder(children.map((c) => c.desc));
  if (order.every((idx, rank) => idx === rank)) return;
  for (const idx of order) parent.appendChild(children[idx].el);
}

/**
 * Element attribute 0xcd (205, an enum). `UIElement::OnSetAttribute @
 * 00462d80` case 0xcd: `SetShouldOwnObject(value != 0)` — a non-zero value
 * gives the element its OWN UIObject (`UIElement::SetUIObject @ 00461ac0`
 * → `RenderUI::LinkObject @ 004491e0`), which `RenderUI::RenderObjects @
 * 00448700` renders as a separate object instead of compositing the element
 * into its window's 2D surface.
 */
export const OWN_UI_OBJECT_PROPERTY = 0xcd;

/** Whether a desc sets attribute 0xcd non-zero (see {@link OWN_UI_OBJECT_PROPERTY}). */
export function ownsUIObject(desc: Pick<ElementDesc, 'properties'>): boolean {
  const p = desc.properties?.get(OWN_UI_OBJECT_PROPERTY);
  return !!p && (p.valueEnum ?? 0) !== 0;
}

/**
 * Base CSS z-index of a lifted owned-object element ({@link liftedOwnedObjects}).
 * Above the per-element `.layout-text` wrappers (5) and scrollbar tracks (10)
 * LayoutRenderer puts in the same stacking context, which belong to the
 * window's 2D surface the object draws over.
 */
export const OWNED_OBJECT_Z_BASE = 100;

type OwnedObjectDesc = Pick<ElementDesc, 'zLevel' | 'uiReadOrder' | 'properties' | 'type' | 'baseElement'>
  & Partial<Pick<ElementDesc, 'x' | 'y' | 'width' | 'height'>> & {
  children: ReadonlyMap<number, OwnedObjectDesc>;
};

/**
 * VISUAL.ui-owned-object-layers(.a) — the elements of a rendered tree that own
 * a UIObject (attribute 0xcd), each of which draws OVER the 2D surface it sits
 * in, with its rank in retail render order (0 = drawn first).
 *
 * `UIElement::SetUIObject @ 00461ac0` links a new object by m_nDepth (the
 * element's m_zlevel, [esi+0x94]) through `RenderUI::LinkObject @ 004491e0`,
 * but that order lasts only until the next frame: `UIElementManager::UseTime
 * @ 0045cfd0` calls `DrawDirtyRegions @ 0045b820`, which walks every window
 * under the manager root in paint order and recurses `DrawRegion @ 0045b7c0`
 * (visible elements only, the element before its children, children head →
 * tail). For each element holding an object (flag 0x10000, set by
 * SetUIObject) with a parent (vtable +0xa0 = `mov eax,[ecx+0xac]`), `DrawRegion
 * WithObject @ 0045ac70` unlinks it and `LinkObjectAfter @ 00449290` relinks it
 * after the previous one. `RenderUI::RenderObjects @ 00448700` draws head →
 * tail, so every object draws in that pre-order walk: the window's surface
 * first, then each owner in paint order, whatever its zLevel. This is why the
 * EoR examine frame (verification/retail-client/ab/retail-examine-npc.png)
 * shows model 0x10000148 (z99) undimmed over page 0x10000140's (z0) alpha-175
 * 0x06004cc2 scrims, where the LinkObject depth order alone would put it
 * behind them (torso 0.31x, measured as ours 4,29,45 vs retail 10,83,123).
 */
export function liftedOwnedObjects<T extends OwnedObjectDesc>(roots: ReadonlyArray<T>): Array<{ desc: T; rank: number }> {
  const found: Array<{ desc: T; rank: number }> = [];
  const walk = (sibs: ReadonlyArray<T>): void => {
    for (const i of retailPaintOrder(sibs)) {
      const d = sibs[i];
      if (d.type === 11 && d.baseElement !== 0) continue; // rendered hidden (LayoutRenderer)
      if (ownsUIObject(d)) found.push({ desc: d, rank: found.length });
      walk([...d.children.values()] as T[]);
    }
  };
  for (const r of retailPaintOrder(roots)) walk([...roots[r].children.values()] as T[]);
  return found;
}

/**
 * Give each {@link liftedOwnedObjects} element of a rendered tree its CSS
 * z-index ({@link OWNED_OBJECT_Z_BASE} + rank) and isolate `container`, so
 * the stacking stays inside the render. Returns how many were lifted.
 */
export function applyOwnedObjectLayers<T extends OwnedObjectDesc>(
  container: HTMLElement,
  roots: ReadonlyArray<T>,
  domByDesc: ReadonlyMap<T, HTMLElement>,
): number {
  let n = 0;
  const lifted = liftedOwnedObjects(roots);
  for (const { desc, rank } of lifted) {
    const el = domByDesc.get(desc);
    if (!el) continue;
    el.style.zIndex = String(OWNED_OBJECT_Z_BASE + rank);
    n++;
  }
  // The lift is a paint order only: keep retail's hit order for the
  // buttons it would otherwise bury (see hitTargetsOverOwnedObjects).
  for (const { desc, rank } of hitTargetsOverOwnedObjects(roots)) {
    const el = domByDesc.get(desc);
    if (el) el.style.zIndex = String(OWNED_OBJECT_Z_BASE + lifted.length + rank);
  }
  if (n) container.style.isolation = 'isolate';
  return n;
}

/** `UIElement_Button` — the DAT element type of a push button. */
const BUTTON_ELEMENT_TYPE = 1;

/**
 * The buttons a {@link liftedOwnedObjects} element would cover, with their
 * rank in tree order. Retail picks the element under the mouse from the
 * element tree, not from the object draw order: `MouseHitTester<…>::Recurse
 * @ 00459370` walks each element's children tail → head (front first, the
 * same order DrawChildren paints) and descends into the first one the point
 * is over. So a button that comes after an owner in the pre-order paint walk
 * (in front of it in the tree, and not inside it) takes the click even where
 * the owner's object draws over it. A CSS z-index moves the hit order along
 * with the paint order, so these buttons go above the lifted layers: the main
 * chat's maximize box 0x1000046f (368,5 16x16) sits inside the log text
 * 0x10000011 (21,5 368x73, attribute 0xcd) and was unclickable under it
 * (webac#1). Rects are the DAT's x/y/width/height, relative to the parent.
 */
export function hitTargetsOverOwnedObjects<T extends OwnedObjectDesc>(roots: ReadonlyArray<T>): Array<{ desc: T; rank: number }> {
  type Placed = { desc: T; x: number; y: number; w: number; h: number; inLifted: boolean; owner: boolean; ownerEnd: number };
  const seq: Placed[] = [];
  const walk = (sibs: ReadonlyArray<T>, ox: number, oy: number, inLifted: boolean): void => {
    for (const i of retailPaintOrder(sibs)) {
      const d = sibs[i];
      if (d.type === 11 && d.baseElement !== 0) continue; // rendered hidden (LayoutRenderer)
      const x = ox + (d.x ?? 0), y = oy + (d.y ?? 0);
      const owner = ownsUIObject(d);
      const p: Placed = { desc: d, x, y, w: d.width ?? 0, h: d.height ?? 0, inLifted, owner, ownerEnd: 0 };
      seq.push(p);
      walk([...d.children.values()] as T[], x, y, inLifted || owner);
      p.ownerEnd = seq.length; // seq[index+1 .. ownerEnd) are this element's descendants
    }
  };
  for (const r of retailPaintOrder(roots)) walk([...roots[r].children.values()] as T[], roots[r].x ?? 0, roots[r].y ?? 0, false);

  const found: Array<{ desc: T; rank: number }> = [];
  for (let b = 0; b < seq.length; b++) {
    const btn = seq[b];
    if (btn.desc.type !== BUTTON_ELEMENT_TYPE || btn.inLifted || btn.owner || btn.w <= 0 || btn.h <= 0) continue;
    const covered = seq.slice(0, b).some((o) => o.owner && o.ownerEnd <= b && o.w > 0 && o.h > 0
      && btn.x < o.x + o.w && o.x < btn.x + btn.w && btn.y < o.y + o.h && o.y < btn.y + btn.h);
    if (covered) found.push({ desc: btn.desc, rank: found.length });
  }
  return found;
}
