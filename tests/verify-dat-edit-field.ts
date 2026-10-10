// @vitest-environment happy-dom
/**
 * RECON.dom-chrome-sweep — DatEditField draws an edit field the way
 * UIElement_Text does: DAT glyph advances for the caret / click / scroll
 * (DrawSelf @ 00467aa0, FindPosFromLineAndPixels @ 004732d0,
 * IsPositionInView @ 00468aa0 / ScrollToPosition @ 004691b0) and the
 * Global_Loop @ 00469fc0 blink.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  attachDatEditField, caretOffset, indexAtX, scrollForCaret, selectionSpan, CaretBlink, CARET_BLINK_MS,
  pinCaretBlink, type DatEditFont,
} from '../packages/renderer/src/ui/DatEditField.js';

/** A font whose glyphs are 6 px wide, except 'i' (3 px) and 'W' (10 px). */
function fakeFont(): DatEditFont & { rendered: string[] } {
  const adv = (c: string): number => (c === 'i' ? 3 : c === 'W' ? 10 : 6);
  const rendered: string[] = [];
  return {
    rendered,
    lineHeight: 12,
    outlinePadding: { x: 1, y: 1 },
    measureText: (t: string) => Array.from(t).reduce((n, c) => n + adv(c), 0),
    renderTextToCanvas: (t: string) => {
      rendered.push(t);
      const c = document.createElement('canvas');
      c.dataset.text = t;
      return c;
    },
  };
}

describe('DatEditField geometry', () => {
  const font = fakeFont();

  it('places the caret at the DAT advance of the glyphs before it', () => {
    expect(caretOffset(font, 'aiW', 0)).toBe(0);
    expect(caretOffset(font, 'aiW', 2)).toBe(9);
    expect(caretOffset(font, 'aiW', 3)).toBe(19);
    expect(caretOffset(font, 'aiW', 99)).toBe(19);
  });

  it('hit-tests a click per FindPosFromLineAndPixels: before a glyph up to its half width', () => {
    // 'aW': a = 0..6, W = 6..16.
    expect(indexAtX(font, 'aW', 0)).toBe(0);
    expect(indexAtX(font, 'aW', 3)).toBe(0); // rem 3 <= 6/2
    expect(indexAtX(font, 'aW', 4)).toBe(1);
    expect(indexAtX(font, 'aW', 11)).toBe(1); // rem 5 <= 10/2
    expect(indexAtX(font, 'aW', 12)).toBe(2);
    expect(indexAtX(font, 'aW', 16)).toBe(2);
    // Past the line width, and left of the origin (the unsigned compare), land at the end.
    expect(indexAtX(font, 'aW', 40)).toBe(2);
    expect(indexAtX(font, 'aW', -1)).toBe(2);
  });

  it('scrolls only when the cursor leaves the view, by ScrollToPosition\'s rule', () => {
    // In view: scroll <= x && x + 2 <= scroll + width.
    expect(scrollForCaret(0, 50, 100)).toBe(0);
    expect(scrollForCaret(0, 98, 100)).toBe(0);
    // Off the right: x + 2 - width.
    expect(scrollForCaret(0, 99, 100)).toBe(1);
    expect(scrollForCaret(0, 150, 100)).toBe(52);
    // Off the left: x.
    expect(scrollForCaret(52, 30, 100)).toBe(30);
    // Deleting back inside the view leaves the scroll where it was.
    expect(scrollForCaret(52, 140, 100)).toBe(52);
  });

  it('spans the selected run, in either direction', () => {
    expect(selectionSpan(font, 'abcd', 1, 3)).toEqual({ x: 6, width: 12 });
    expect(selectionSpan(font, 'abcd', 3, 1)).toEqual({ x: 6, width: 12 });
    expect(selectionSpan(font, 'abcd', 2, 2)).toBeNull();
  });

  it('blinks every 530 ms and a cursor move brings it back on', () => {
    expect(CARET_BLINK_MS).toBe(530);
    const b = new CaretBlink();
    b.reset(0);
    expect(b.tick(100)).toBe(true);
    expect(b.tick(530)).toBe(false);
    expect(b.tick(1060)).toBe(true);
    expect(b.tick(1600)).toBe(false);
    b.reset(1700);
    expect(b.tick(1701)).toBe(true);
    expect(b.tick(1700 + 3 * 530)).toBe(false);
    expect(b.tick(1700 + 4 * 530)).toBe(true);
  });

  it('holds the caret lit while capture tooling pins the blink', () => {
    const b = new CaretBlink();
    b.reset(0);
    pinCaretBlink(true);
    try {
      expect(b.tick(530)).toBe(true);
      expect(b.tick(1600)).toBe(true);
    } finally { pinCaretBlink(false); }
    expect(b.tick(5 * 530)).toBe(false); // unpinned: the blink runs on its own clock again
  });
});

describe('attachDatEditField', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; document.body.innerHTML = ''; });

  const mount = (opts: Partial<Parameters<typeof attachDatEditField>[2]> = {}) => {
    const host = document.createElement('div');
    host.style.position = 'relative';
    document.body.appendChild(host);
    const input = document.createElement('input');
    host.appendChild(input);
    const font = fakeFont();
    let t = 0;
    const handle = attachDatEditField(input, host, { font, color: 'rgb(255, 255, 255)', marginLeft: 2, marginRight: 2, now: () => t, ...opts })!;
    cleanup = () => handle.destroy();
    return { host, input, font, handle, setTime: (v: number) => { t = v; } };
  };

  it('hides the browser glyphs and caret and paints the value in the DAT font', () => {
    const { input, font, handle } = mount();
    expect(input.style.color).toBe('transparent');
    expect(input.style.caretColor).toBe('transparent');
    input.value = 'hello';
    expect(font.rendered).toContain('hello');
    expect(handle.layer.querySelector('canvas')?.dataset.text).toBe('hello');
  });

  it('repaints on a programmatic clear, as chat does after a send', () => {
    const { input, font, handle } = mount();
    input.value = 'say hi';
    input.value = '';
    expect(input.value).toBe('');
    expect(handle.layer.querySelector('canvas')).toBeNull();
    expect(font.rendered).toEqual(['say hi']);
  });

  it('draws a 1-px caret in the font colour while focused, at the DAT offset', () => {
    const { input, handle } = mount();
    input.value = 'aiW';
    input.focus();
    input.setSelectionRange(2, 2);
    handle.refresh();
    const caret = handle.layer.querySelector('.ac-dat-edit-caret') as HTMLElement;
    expect(caret.style.display).toBe('block');
    expect(caret.style.width).toBe('1px');
    expect(caret.style.height).toBe('12px');
    expect(caret.style.left).toBe('9px');
    expect(caret.style.background).toContain('255');
    input.blur();
    expect(caret.style.display).toBe('none');
  });

  it('places the cursor from a click by DAT advances', () => {
    const { input, handle } = mount();
    input.value = 'aW';
    // The layer's left edge is the host's + marginLeft (2) — happy-dom reports 0 rects, so x is text space.
    input.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 12, bubbles: true }));
    expect(input.selectionStart).toBe(2);
    input.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 4, bubbles: true }));
    expect(input.selectionStart).toBe(1);
    expect(handle.layer.dataset.acCaret).toBe('1');
  });

  it('shows the selection as an inverted box over the selected glyphs', () => {
    const { input, handle } = mount();
    input.value = 'abcd';
    input.focus();
    input.setSelectionRange(1, 3);
    handle.refresh();
    const sel = handle.layer.querySelector('.ac-dat-edit-selection') as HTMLElement;
    // The blend must reach the field's art: no stacking context on the layer.
    expect(sel.style.mixBlendMode).toBe('difference');
    expect(handle.layer.style.zIndex).toBe('');
    expect(sel.style.display).toBe('block');
    expect(sel.style.left).toBe('6px');
    expect(sel.style.width).toBe('12px');
    expect(sel.style.mixBlendMode).toBe('difference');
  });

  // RECON.dom-chrome-sweep.b.a — DrawSelf inverts the selection whenever
  // GetSelection holds, with no focus test (the chargen summary SelectAlls
  // its prompt), and a focus loss Deselects (ListenToElementMessage 0x2f).
  it('draws a selection set on an unfocused field', () => {
    const { input, handle } = mount();
    input.value = '[ Name ]';
    input.setSelectionRange(0, input.value.length);
    handle.refresh();
    expect(document.activeElement).not.toBe(input);
    const sel = handle.layer.querySelector('.ac-dat-edit-selection') as HTMLElement;
    expect(sel.style.display).toBe('block');
    expect([sel.style.left, sel.style.width]).toEqual(['0px', '48px']);
    // No caret without focus.
    expect((handle.layer.querySelector('.ac-dat-edit-caret') as HTMLElement).style.display).toBe('none');
  });

  it('drops the selection on focus loss and keeps the cursor where it was', () => {
    const { input, handle } = mount();
    input.value = 'abcd';
    input.focus();
    input.setSelectionRange(1, 3, 'backward');
    handle.refresh();
    const sel = handle.layer.querySelector('.ac-dat-edit-selection') as HTMLElement;
    expect(sel.style.display).toBe('block');
    input.blur();
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
    expect(sel.style.display).toBe('none');
    expect(handle.layer.dataset.acCaret).toBe('1');
    // Focusing again does not bring it back.
    input.focus();
    handle.refresh();
    expect(sel.style.display).toBe('none');
  });

  it('does nothing without a DAT font (DAT-less boot keeps the plain input)', () => {
    const host = document.createElement('div');
    const input = document.createElement('input');
    host.appendChild(input);
    expect(attachDatEditField(input, host, { font: null, color: '#fff' })).toBeNull();
    expect(input.style.color).toBe('');
  });

  /** Document listeners attachDatEditField holds right now, by event type. */
  const docListeners = () => {
    const live = new Map<string, number>();
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    const spyAdd = (type: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => { live.set(type, (live.get(type) ?? 0) + 1); add(type, fn, o); };
    const spyRemove = (type: string, fn: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => { if (live.get(type)) live.set(type, live.get(type)! - 1); remove(type, fn, o); };
    document.addEventListener = spyAdd as typeof document.addEventListener;
    document.removeEventListener = spyRemove as typeof document.removeEventListener;
    return { count: () => [...live.values()].reduce((a, b) => a + b, 0), restore: () => { document.addEventListener = add; document.removeEventListener = remove; } };
  };

  it('holds no document listener while idle, so a rebuilt panel\'s old field can be collected (PERF soak 2026-10-07)', () => {
    const spy = docListeners();
    try {
      const { input } = mount();
      expect(spy.count()).toBe(0);
      // A press-drag holds mousemove / mouseup until the release, and still extends the selection.
      input.value = 'abcd';
      input.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 2, bubbles: true }));
      expect(spy.count()).toBe(3); // mousemove + mouseup, + selectionchange from the focus
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, bubbles: true }));
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(3);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(spy.count()).toBe(1);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 4, bubbles: true }));
      expect(input.selectionEnd).toBe(3); // no drag after the release
      input.blur();
      expect(spy.count()).toBe(0);
    } finally { spy.restore(); }
  });

  it('restores the native value property on destroy', () => {
    const { input, handle } = mount();
    handle.destroy();
    cleanup = null;
    expect(Object.getOwnPropertyDescriptor(input, 'value')).toBeUndefined();
    input.value = 'x';
    expect(input.value).toBe('x');
  });
});
