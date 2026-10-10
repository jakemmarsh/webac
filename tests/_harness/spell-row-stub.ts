/**
 * Stub-layout support for the spellbook's DAT rows
 * (VISUAL.spellbook-scrollbar-and-order). renderMagicPanel renders each
 * spell row from the UIItem 0x21000037:0x10000343 (selected overlay
 * 0x10000342, name 0x10000344, icon 0x1000033b).
 * A permissive stub layout handle has no DAT, so wrap its `render` with
 * `withSpellRowTemplate`: a call for that subtree builds the row's element
 * tree (data-element-id nodes), and every other call goes to `render`.
 */
export const SPELL_ROW_TEMPLATE = 0x10000343;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSpellRowTemplate(render: (id: number, parent: HTMLElement, opts?: any) => unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (id: number, parent: HTMLElement, opts?: any): unknown => {
    if (opts?.subtreeElementId !== SPELL_ROW_TEMPLATE) return render(id, parent, opts);
    const doc = parent.ownerDocument;
    const mk = (eid: number, into: HTMLElement): HTMLElement => {
      const el = doc.createElement('div');
      el.dataset.elementId = `0x${eid.toString(16)}`;
      into.appendChild(el);
      return el;
    };
    const root = mk(SPELL_ROW_TEMPLATE, parent);
    const elements = new Map<number, HTMLElement>([[SPELL_ROW_TEMPLATE, root], [0x10000342, mk(0x10000342, root)], [0x10000344, mk(0x10000344, root)], [0x1000033b, mk(0x1000033b, root)]]);
    return { root, elements, setState: () => {}, setText: () => {}, onClick: () => {}, close: () => root.remove() };
  };
}
