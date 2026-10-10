/**
 * BUG.ui-buttonpress-on-every-button — the press sound comes from the
 * pressed element's own LayoutDesc media, not from every button.
 *
 * Retail has no "button click" sound call. A UI element plays a sound only
 * through `MediaMachine::Update_Sound @ 004658b0`, when the element enters
 * a state whose (base-chain-resolved) media list carries an MD_Data_Sound:
 * the SoundType from the media's table (m_file, a 0x20 SoundTable), or its
 * raw wave when the SoundType is 0. In the EoL layouts every such item is
 * UI_ButtonPress from 0x2000004B on state 3 (Pressed), AUTHORED on three
 * template buttons (0x21000006 / 0x2100006f el 0x10000014, 0x21000040
 * el 0x1000047f) and reached by 301 element ids through base inheritance
 * (`LayoutDesc::InqFullDesc @ 0069a520` → `ElementDesc::Incorporate
 * @ 0069b5a0`, which concatenates the base media;
 * `npx tsx tools/scan-layout-sounds.ts --resolved`). Sixty other elements
 * have a Pressed state and no sound (the inventory gem 0x10000328, the
 * indicator strip's 0x100000f2-f8, the chargen spin arrows 0x10000364-366,
 * …) and are silent in retail.
 *
 * When the state is entered — `UIElement_Button::MouseDown @ 00471ff0` sets
 * mousePressedOnButton and `UpdateState_ @ 00471cf0` moves the button to
 * 3 (Pressed), or 8 when its 0xe "selected" flag is set (a toggle that is
 * on: 6 normal / 7 rollover / 8 pressed), or 0xd while disabled (no
 * press). So the sound is on mouse-DOWN, whether or not the click
 * completes, and a hotkey that toggles a panel plays nothing.
 *
 * This module resolves a pressed DOM node to its layout element (the
 * `data-element-id` chain up to the `data-layout-id` render root that
 * LayoutRenderer stamps, or a hand-built node tagged `data-ac-press` by
 * {@link tagLayoutElement} / GameUI.datTooltipAttrs, or naming its desc with
 * `data-ac-desc`) and returns the sound media of the state the press enters.
 */
import { MediaType } from '@ac/dat-parser';
import type { ElementDesc, LayoutDescData } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { UI_STATE_DISABLED, UI_STATE_PRESSED, UI_STATE_SELECTED, descRef, parseDescRef } from './DatTextStyle.js';

/** One MD_Data_Sound: `table` = m_file, `sound` = m_stype (0 → `table` is a raw wave). */
export interface LayoutSoundMedia { table: number; sound: number }

/** A toggle that is on presses into 6 + 2 (UpdateState_ @ 00471cf0). */
export const UI_STATE_SELECTED_PRESSED = UI_STATE_SELECTED + 2;

/**
 * The state a mouse-down moves a button into (`UIElement_Button::UpdateState_
 * @ 00471cf0`), from the state it shows now: disabled (0xd) → no press;
 * selected (6 / 7 / 8) → 8; otherwise 3.
 */
export function pressStateFor(currentState: number | undefined): number | null {
  if (currentState === UI_STATE_DISABLED) return null;
  if (currentState !== undefined && currentState >= UI_STATE_SELECTED && currentState <= UI_STATE_SELECTED_PRESSED) {
    return UI_STATE_SELECTED_PRESSED;
  }
  return UI_STATE_PRESSED;
}

/** The Sound media an element plays on entering `stateId` (MediaMachine::Update_Sound). */
export function stateSoundMedia(desc: ElementDesc, stateId: number): LayoutSoundMedia[] {
  const media = [...(desc.states.get(stateId)?.media ?? [])];
  if (desc.stateId === stateId && desc.stateId !== 0) media.push(...desc.media);
  return media
    .filter((m) => m.type === MediaType.Sound && ((m.sType ?? 0) !== 0 || (m.file ?? 0) !== 0))
    .map((m) => ({ table: (m.file ?? 0) >>> 0, sound: m.sType ?? 0 }));
}

function findAll(el: ElementDesc, id: number, out: ElementDesc[]): void {
  if (el.elementId === id) out.push(el);
  for (const c of el.children.values()) findAll(c, id, out);
}

/**
 * The resolved desc for a DOM element path inside a layout: `path` runs
 * outermost → innermost (the render may start at a subtree, so the first id
 * is searched anywhere). Falls back to the first element with the innermost
 * id when the chain does not match the desc tree (a hand-tagged node).
 */
export function findPressElement(layout: LayoutDescData, path: number[]): ElementDesc | null {
  if (path.length === 0) return null;
  const starts: ElementDesc[] = [];
  for (const el of layout.elements.values()) findAll(el, path[0], starts);
  for (const start of starts) {
    let cur: ElementDesc | undefined = start;
    for (let i = 1; cur && i < path.length; i++) {
      cur = [...cur.children.values()].find((c) => c.elementId === path[i]);
    }
    if (cur) return cur;
  }
  const last: ElementDesc[] = [];
  for (const el of layout.elements.values()) findAll(el, path[path.length - 1], last);
  return last[0] ?? null;
}

/**
 * Tag a hand-built DOM node as the layout element `path` (outermost → the
 * element) of `layoutId`: `data-ac-press`, a descRef string. (A node that
 * already names its desc with `data-ac-desc` — a DAT text run, the patch
 * Cancel — resolves the same way.)
 */
export function tagLayoutElement(node: HTMLElement, layoutId: number, ...path: number[]): void {
  node.dataset.acPress = descRef(layoutId, ...path);
}

/** The attribute form of {@link tagLayoutElement}, for innerHTML templates. */
export function layoutPressAttr(layoutId: number, ...path: number[]): string {
  return `data-ac-press="${descRef(layoutId, ...path)}"`;
}

const parseHex = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const v = parseInt(s, 16);
  return Number.isFinite(v) ? v : undefined;
};

/** The layout id + element-id chain (outermost first) a LayoutRenderer node sits in. */
export function layoutPathOf(node: Element | null): { layoutId: number; nodes: HTMLElement[]; path: number[] } | null {
  const nodes: HTMLElement[] = [];
  for (let n = node as HTMLElement | null; n; n = n.parentElement) {
    if (n.dataset?.elementId) nodes.unshift(n);
    const layoutId = parseHex(n.dataset?.layoutId);
    if (layoutId !== undefined) {
      if (nodes.length === 0) return null;
      return { layoutId, nodes, path: nodes.map((x) => parseHex(x.dataset.elementId) ?? 0) };
    }
  }
  return null;
}

/** The resolved desc one DOM node stands for, if any. */
function descOfNode(
  n: HTMLElement,
  getResolvedLayout: (layoutId: number) => LayoutDescData | null,
): ElementDesc | null {
  const ref = parseDescRef(n.dataset.acPress ?? n.dataset.acDesc);
  if (ref) {
    const layout = getResolvedLayout(ref.layoutId);
    return layout ? findPressElement(layout, ref.path) : null;
  }
  if (n.dataset.elementId) {
    const chain = layoutPathOf(n);
    const layout = chain ? getResolvedLayout(chain.layoutId) : null;
    return chain && layout ? findPressElement(layout, chain.path) : null;
  }
  return null;
}

/**
 * The sounds a mouse-down on `node` plays: walking out from the node, the
 * first element (a LayoutRenderer node, or a hand-built one tagged with
 * `data-ac-press` / `data-ac-desc`) whose desc HAS a Pressed state is the
 * button being pressed — children without one (labels, glyphs) pass the
 * press up; its sound media on the state the press enters, or [] (silent)
 * when it has none. Nothing on the way → silent.
 */
export function pressSoundsFor(
  node: Element | null,
  getResolvedLayout: (layoutId: number) => LayoutDescData | null,
): LayoutSoundMedia[] {
  for (let n = node as HTMLElement | null; n; n = n.parentElement) {
    if (!n.dataset) continue;
    const desc = descOfNode(n, getResolvedLayout);
    if (!desc) continue;
    if (!desc.states.has(UI_STATE_PRESSED) && !desc.states.has(UI_STATE_SELECTED_PRESSED)) continue;
    const state = pressStateFor(parseHex(n.dataset.acState));
    return state === null ? [] : stateSoundMedia(desc, state);
  }
  return [];
}
