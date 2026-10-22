/**
 * RECON.keyboard-dialog — the mouse controls a key binding can name.
 *
 * Both retail KeyMaps list two devices: index 0 GUID_SysKeyboard (type 1) and
 * index 1 GUID_SysMouse (type 2). A mouse ControlSpecification's control is
 * the DIMOFS_* data offset ControlNameMapper::LoadSemantics @ 0068b820
 * registers (DIMOFS_X 0, DIMOFS_Y 4, DIMOFS_Z / DIMOFS_WHEEL 8,
 * DIMOFS_BUTTON0-7 0xc-0x13) and its device word's high byte the
 * sub-control (sci_PositiveAxis 1 / sci_NegativeAxis 2 for the wheel). The
 * DAT DefaultMap 0x14000002 binds DIMOFS_BUTTON2 (the middle button) to
 * Toggle Mouselook 0x3d in input map 5.
 *
 * Canonical registry codes: "MouseButton<N>" for DIMOFS_BUTTON<N> (N is
 * DirectInput's button index: 0 left, 1 right, 2 middle, 3 / 4 the side
 * buttons) and "MouseWheelUp" / "MouseWheelDown" for the wheel's two
 * sub-controls, with the same "Ctrl+" / "Alt+" / "Shift+" prefixes keys take.
 */

/** Device index 1 in both retail KeyMaps is GUID_SysMouse. */
export const MOUSE_DEVICE = 1;
export const DIMOFS_WHEEL = 0x8;
export const DIMOFS_BUTTON0 = 0xc;
export const DIMOFS_BUTTON7 = 0x13;

export const WHEEL_UP = 'MouseWheelUp';
export const WHEEL_DOWN = 'MouseWheelDown';
export const MOUSE_BUTTON_PREFIX = 'MouseButton';

/** The canonical code for one mouse control (no meta), or null for the X / Y axes and unknown offsets. */
export function mouseControlToCode(control: number, subControl: number): string | null {
  if (control === DIMOFS_WHEEL) {
    if (subControl === 1) return WHEEL_UP;
    if (subControl === 2) return WHEEL_DOWN;
    return null;
  }
  if (control >= DIMOFS_BUTTON0 && control <= DIMOFS_BUTTON7 && subControl === 0) {
    return MOUSE_BUTTON_PREFIX + (control - DIMOFS_BUTTON0);
  }
  return null;
}

/**
 * MouseEvent.button → DirectInput button index. The browser numbers the
 * middle button 1 and the right 2; DirectInput's system mouse reports the
 * right button as Button 1 and the middle as Button 2.
 */
export function browserButtonToDirectInput(button: number): number | null {
  switch (button) {
    case 0: return 0;
    case 1: return 2;
    case 2: return 1;
    case 3: return 3;
    case 4: return 4;
    default: return null;
  }
}

export interface MouseLike {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

function metaPrefix(e: MouseLike): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return mods.length ? mods.join('+') + '+' : '';
}

/** Canonical code for a mouse-button event (modifier-prefixed), or null for an unknown button. */
export function mouseEventToCode(e: MouseLike & { button: number }): string | null {
  const idx = browserButtonToDirectInput(e.button);
  if (idx === null) return null;
  return metaPrefix(e) + MOUSE_BUTTON_PREFIX + idx;
}

/** Canonical code for a wheel event: deltaY < 0 is the positive-axis (Up) sub-control. */
export function wheelEventToCode(e: MouseLike & { deltaY: number; deltaMode?: number }): string | null {
  // COMPAT.wheel-deltamode: touch deltaMode before deltaY, so Firefox keeps
  // the event in its native line units for every later listener
  // (ui/wheelScroll.ts readWheel).
  void e.deltaMode;
  const dy = e.deltaY;
  if (dy === 0) return null;
  return metaPrefix(e) + (dy < 0 ? WHEEL_UP : WHEEL_DOWN);
}

/** The code with its meta prefixes removed ("Ctrl+MouseButton0" → "MouseButton0"). */
export function baseOfCode(code: string): string {
  const i = code.lastIndexOf('+');
  return i < 0 ? code : code.slice(i + 1);
}

/** Whether a canonical code names a mouse control (button or wheel). */
export function isMouseCode(code: string): boolean {
  const base = baseOfCode(code);
  return base.startsWith(MOUSE_BUTTON_PREFIX) || base === WHEEL_UP || base === WHEEL_DOWN;
}

/**
 * UIOption_ActionKeyMap::KeyHitHandler @ 00489570's filter on the control it
 * is handed while the MapInstructions dialog is up: a mouse (device type 2)
 * DIMOFS_X / DIMOFS_Y movement never binds, and neither does a bare
 * DIMOFS_BUTTON0 (the left click, metamode 0); a meta-qualified left click,
 * every other button and the wheel bind like a key.
 */
export function isCapturableMouseCode(code: string): boolean {
  if (!isMouseCode(code)) return false;
  return code !== MOUSE_BUTTON_PREFIX + '0';
}

/**
 * Swallow the rest of a mouse press that was consumed as a binding: the
 * release, and the click / auxclick / contextmenu the browser derives from it
 * (contextmenu fires on press on some platforms, after release on others), so
 * none reaches the element under the pointer. Ends one task after the release.
 */
export function swallowMouseRelease(target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): void {
  const types = ['mouseup', 'click', 'auxclick', 'contextmenu'] as const;
  const stop = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
  for (const t of types) target.addEventListener(t, stop, true);
  const done = () => {
    target.removeEventListener('mouseup', done, true);
    setTimeout(() => { for (const t of types) target.removeEventListener(t, stop, true); }, 0);
  };
  target.addEventListener('mouseup', done, true);
}
