/**
 * CORE.17.k.b.b.a.f — the chargen profession page's attribute rows as
 * gmCGProfessionPage + CharGenState drive them (decompiled EoL client): the
 * lock toggle 0x100002ec, the credit balancing the lock exists for, and the
 * slider 0x100002ee's geometry (UIElement_Scrollbar).
 *
 * Ground truth (docs/retail-client-symbols.md, CORE.17.k.b.b.a.f):
 *  - CharGenState indexes attributes 1 Strength, 2 Endurance, 3 Quickness,
 *    4 Coordination, 5 Focus, 6 Self (GetAttribute @ 005c39b0);
 *    gmCGProfessionPage::GetSliderIndex @ 00481f90 maps the rows
 *    0x100003e6/e7/e9/e8/ea/eb → 1/2/3/4/5/6, so the screen order top to
 *    bottom is Str, End, Coord, Quick, Focus, Self.
 *  - GetAbsRemainingCredits(i) @ 005c3b20: totalAtrbCredits − Σ_j (locked[j]
 *    || j == i ? value[j] : 10) — the credits attribute i could still take
 *    if every unlocked other attribute fell to its floor of 10.
 *  - SetStrength … SetSelf @ 005c4660–005c48e0 (value, balance): an increase
 *    is refused when GetAbsRemainingCredits(i) == 0; otherwise the value is
 *    stored, BalanceAttributes(i) runs when `balance` is set, and
 *    remainingAtrbCredits = total − Σ.
 *  - BalanceAttributes(i) @ 005c3df0: over = Σ − total; while over > 0 take
 *    one point at a time from the unlocked attributes above 10 other than
 *    i, in the order Str → End → Coord → Quick → Focus → Self, starting at
 *    the STATIC `startAtrb` slot and continuing round-robin; when the last
 *    point is taken from a slot, startAtrb becomes the next slot (Self → Str).
 *    The static persists for the client's life.
 *  - gmCGProfessionPage::SetAttribValue @ 00482890: a rise past
 *    GetAbsRemainingCredits(i) is clamped to current + that; then
 *    Set<Attr>(value, 1) and UpdateAttributeValues.
 *  - SetLock @ 00482000: flips bLocked; the lock button AND the slider
 *    (when it carries p134) go to state 0x10000019 locked / 0x10000018
 *    unlocked; CharGenState::LockAttribute(i, locked). ClearLocks @ 004820d0
 *    (ResetAttributeLock + SetLock on every locked row) runs from
 *    UpdateToDefaultAttributes — every profession row click (SetTemplate +
 *    ApplyTemplate @ 005c5080 also zeroes bAttribLocked).
 *  - ListenToElementMessage @ 004829c0: 0x100002ec message 1 (click) →
 *    SetLock(row); 0x100002ee message 10 (the scrollbar's position change)
 *    → value = ftol(position × 100) floored at 10 → SetAttribValue.
 *  - UpdateAttributeValues @ 00482450: each slider's p134 (0x86) =
 *    value × 0.01 (___real_3c23d70a); the value text; Health / Stamina /
 *    Mana; FitTemplateToCharacter + UpdateProfession.
 *  - UIElement_Scrollbar: UpdateScrollingArea @ 00470aa0 = the whole
 *    element (no page buttons here); ComputeActiveSize @ 004702a0 = the
 *    area less the widget when p126 (0x7e) is off; PositionToWidgetX0Y0 @
 *    004709a0 puts the widget at ftol(position × active); PointToPosition @
 *    00470890: (x − widget/2) held to [0, active − 1] over (active − 1);
 *    SetScrollbarPosition @ 00470ec0 clamps [0, 1], stores p134, broadcasts
 *    message 10. p123 (0x7b) horizontal, p124 (0x7c) move-to-touched (a
 *    press on the track jumps the widget there), p131 (0x83) smooth
 *    movement, p134 (0x86) the position.
 *  - Layout 0x2100004c: 0x100002ea (the slider template, 100x39): widget
 *    0x1 (0,0) 37x39 media 0x06004d34 (the gold diamond), bar 0x4 (0,0)
 *    100x39 edges 1112 (stretches with the width) with state media
 *    0x10000018 → 0x06004d39 / 0x10000019 → 0x06004d3a (7x39 strips);
 *    0x100002eb (the row, 487x39): lock 0x100002ec (4,4) 15x24 p11, states
 *    0x10000018 → 0x06004d3b / 0x10000019 → 0x06004d3c, tooltip p73
 *    222843554; slider 0x100002ee (148,0) 291x39 edges 1111; value
 *    0x100002ef (440,0) 47x39 edges 1111. The page's rows 0x100003e6–eb are
 *    480 wide, so the slider draws 284 wide and the value 40 wide.
 *
 * CORE.17.k.b.b.a.f.a — the value box 0x100002ef is an EDIT field:
 *  - DAT: type 12 (UIElement_Text), p22 SetEditable, p39 SetSelectable, p30
 *    m_nMaxCharacters = 3, p203 SetLoseFocusOnEscape, p204
 *    SetLoseFocusOnAcceptInput (UIElement_Text::OnSetAttribute @ 0046a640
 *    cases 0x16 / 0x27 / 0x1e / 0xcb / 0xcc); font p26 0x4000000d, colour
 *    p27 white, p20 = 3 right-justified, p21 = 1 centred.
 *  - gmCGProfessionPage::ListenToElementMessage @ 004829c0 case 0x100002ef:
 *    message 0x2f (UIElementManager::SetFocusElement @ 0045b890 — dwParam1
 *    1 on the element gaining focus, 0 on the one losing it): gained →
 *    UIElement_Text::SelectAll @ 004678d0; lost → PStringBase::to_uint32
 *    (wcstoul base 0 — a leading 0 reads as OCTAL) of the text, held to
 *    [10, 100] (v < 101 ? max(10, v) : 100) → SetAttribValue. Messages 0x12
 *    (UIElement_Text::CharacterHandler @ 00469b90 — every key, the accepted
 *    ones after AddText_Internal) and 0x44 (DeleteSection @ 00469800) →
 *    the slider's p133 (0x85) = clamp(to_float(text) × 0.01, 0.1, 1.0).
 *  - p133 is a dead write here: UIElement_Scrollbar::OnSetAttribute @
 *    004714d0 case 0x85 → StartAnimation @ 00470550 when p131 smooth
 *    movement is on (it is), and StartAnimation returns before touching
 *    p134 unless p132 (0x84, the duration) reads non-zero — 0x100002ea has
 *    no p132, the MasterProperty gives it no default, and only
 *    0x21000021 sets it anywhere. So the widget does NOT follow the typing;
 *    it moves when the value lands on focus loss (UpdateAttributeValues).
 *  - The typed characters: CharacterHandler refuses control characters and
 *    what m_filter refuses; InitializePage @ 00482d50 assigns
 *    NumberInputFilter @ 004663f0 (isdigit) — to pAttribText (0x100002ed,
 *    the read-only name), never to pAttibValue, so the value box itself
 *    takes any printable character through the DAT's 3-character cap;
 *    to_uint32 then reads the leading digits (0 for none → 10).
 *  - UIElement_Text::OnAction @ 0046a260: action 0x25 (accept, Enter) with
 *    bit 0x2000 (p204) and action 0x27 (Escape) with bit 0x1000 (p203) both
 *    release the focus — either key commits the text; nothing reverts it.
 *  - Selection: UIElement_Text::DrawSelf @ 00467aa0 draws a selected glyph
 *    box with SurfaceWindow::NotColorBits — the pixels under the glyph box
 *    are inverted; there is no selection colour.
 */

/** CharGenState's attribute slots, index 1..6 (0 unused). */
export const ATTRIBUTE_SLOT_KEYS = [null, 'strength', 'endurance', 'quickness', 'coordination', 'focus', 'self'] as const;
export type AttributeKey = Exclude<(typeof ATTRIBUTE_SLOT_KEYS)[number], null>;

/** The CharGenState index of each attribute (GetAttribute @ 005c39b0). */
export const ATTRIBUTE_SLOT: Readonly<Record<AttributeKey, number>> = {
  strength: 1, endurance: 2, quickness: 3, coordination: 4, focus: 5, self: 6,
};

/** BalanceAttributes' drain order — the screen order (GetSliderIndex's rows top to bottom). */
export const BALANCE_ORDER: readonly number[] = [1, 2, 4, 3, 5, 6];

/** The rows of 0x21000047 by CharGenState slot (GetSliderIndex @ 00481f90). */
export const ATTRIBUTE_ROW_ELEMENT: Readonly<Record<number, number>> = {
  1: 0x100003e6, 2: 0x100003e7, 3: 0x100003e9, 4: 0x100003e8, 5: 0x100003ea, 6: 0x100003eb,
};

export const ATTRIBUTE_FLOOR = 10;
export const ATTRIBUTE_CEILING = 100;

// The 0x2100004c row template's children.
export const ATTRIBUTE_ROW_TEMPLATE_LAYOUT = 0x2100004c;
export const ATTRIBUTE_ROW_TEMPLATE = 0x100002eb;
export const ATTRIBUTE_LOCK_ELEMENT = 0x100002ec;
export const ATTRIBUTE_NAME_ELEMENT = 0x100002ed;
export const ATTRIBUTE_SLIDER_ELEMENT = 0x100002ee;
export const ATTRIBUTE_VALUE_ELEMENT = 0x100002ef;
export const ATTRIBUTE_SLIDER_TEMPLATE = 0x100002ea;
export const ATTRIBUTE_LOCK_TOOLTIP_STRING = 222843554;

/** The lock / slider states SetLock @ 00482000 writes. */
export const ATTRIBUTE_STATE_UNLOCKED = 0x10000018;
export const ATTRIBUTE_STATE_LOCKED = 0x10000019;

export const ATTRIBUTE_LOCK_RECT = { x: 4, y: 4, width: 15, height: 24 } as const;
export const ATTRIBUTE_LOCK_MEDIA: Readonly<Record<number, number>> = {
  [ATTRIBUTE_STATE_UNLOCKED]: 0x06004d3b,
  [ATTRIBUTE_STATE_LOCKED]: 0x06004d3c,
};
export const ATTRIBUTE_SLIDER_BAR_MEDIA: Readonly<Record<number, number>> = {
  [ATTRIBUTE_STATE_UNLOCKED]: 0x06004d39,
  [ATTRIBUTE_STATE_LOCKED]: 0x06004d3a,
};
export const ATTRIBUTE_SLIDER_WIDGET_MEDIA = 0x06004d34;
/** The slider as the 480-wide page rows draw it (the template's 291 less the 7 px the row lost). */
export const ATTRIBUTE_SLIDER_RECT = { x: 148, y: 0, width: 284, height: 39 } as const;
export const ATTRIBUTE_SLIDER_WIDGET_SIZE = { width: 37, height: 39 } as const;
export const ATTRIBUTE_VALUE_RECT = { x: 440, y: 0, width: 40, height: 39 } as const;

/** UpdateAttributeValues' p134: value × 0.01. */
export const SLIDER_POSITION_PER_POINT = 0.01;

export function attributeStateId(locked: boolean): number {
  return locked ? ATTRIBUTE_STATE_LOCKED : ATTRIBUTE_STATE_UNLOCKED;
}

/** The mutable attribute state CharGenState keeps (index 1..6; slot 0 unused). */
export interface AttributeCreditsState {
  /** totalAtrbCredits — the heritage's AttributeCredits (330 for the humans). */
  totalCredits: number;
  /** strength … self by CharGenState slot. */
  values: number[];
  /** bAttribLocked by slot. */
  locked: boolean[];
}

export function createAttributeCreditsState(totalCredits: number, floor = ATTRIBUTE_FLOOR): AttributeCreditsState {
  return {
    totalCredits,
    values: [0, floor, floor, floor, floor, floor, floor],
    locked: [false, false, false, false, false, false, false],
  };
}

/** Σ strength … self. */
export function attributeSum(state: AttributeCreditsState): number {
  let sum = 0;
  for (let i = 1; i <= 6; i++) sum += state.values[i];
  return sum;
}

/** remainingAtrbCredits — total − Σ (negative while an overspend is unbalanced). */
export function remainingCredits(state: AttributeCreditsState): number {
  return state.totalCredits - attributeSum(state);
}

/**
 * CharGenState::GetAbsRemainingCredits @ 005c3b20: the credits slot `index`
 * could still absorb — total less its own value, less every LOCKED other
 * attribute's value, less the floor for every unlocked other attribute.
 */
export function absRemainingCredits(state: AttributeCreditsState, index: number): number {
  let credits = state.totalCredits;
  for (let j = 1; j <= 6; j++) {
    credits -= (state.locked[j] || j === index) ? state.values[j] : ATTRIBUTE_FLOOR;
  }
  return credits;
}

/**
 * The static `startAtrb` BalanceAttributes reads and writes — the slot the
 * next drain starts at, so successive moves spread the cost round-robin.
 * Retail keeps it for the client's life (never reset between chargens).
 */
let balanceStartSlot = 1;

export function getBalanceStartSlot(): number {
  return balanceStartSlot;
}

/** Test hook: the static's value at client start. */
export function resetBalanceStartSlot(slot = 1): void {
  balanceStartSlot = slot;
}

/**
 * CharGenState::BalanceAttributes @ 005c3df0 — while Σ exceeds the total,
 * take one point per pass from each unlocked attribute above the floor
 * other than `movedIndex`, in BALANCE_ORDER from the static start slot,
 * wrapping; the slot after the one that took the last point becomes the
 * next start. Returns the drains applied, in order (slot per point).
 *
 * The caller guarantees the overspend is absorbable (SetAttribValue's
 * clamp / Set<Attr>'s refusal) — retail's loop never terminates otherwise.
 * Ours refuses up front, before touching anything, when the unlocked
 * others' headroom above the floor cannot cover the whole overspend
 * (CORE.17.k.b.b.a.f.e — a partly absorbable overspend used to drain what
 * it could and then spin for ever), and stops on a pass that takes nothing.
 */
export function balanceAttributes(state: AttributeCreditsState, movedIndex: number): number[] {
  const drained: number[] = [];
  let over = attributeSum(state) - state.totalCredits;
  if (over <= 0) return drained;
  const canTake = (slot: number): boolean =>
    slot !== movedIndex && !state.locked[slot] && state.values[slot] > ATTRIBUTE_FLOOR;
  let headroom = 0;
  for (const slot of BALANCE_ORDER) {
    if (slot !== movedIndex && !state.locked[slot]) headroom += Math.max(state.values[slot] - ATTRIBUTE_FLOOR, 0);
  }
  if (headroom < over) {
    throw new Error(`BalanceAttributes: the unlocked attributes can absorb ${headroom} of the ${over}-credit overspend (the caller must clamp first)`);
  }
  let started = false;
  for (;;) {
    const fullPass = started; // the first pass starts mid-order at the start slot
    let progressed = false;
    for (let k = 0; k < BALANCE_ORDER.length; k++) {
      const slot = BALANCE_ORDER[k];
      if (!started && slot !== balanceStartSlot) continue;
      started = true;
      if (!canTake(slot)) continue;
      state.values[slot] -= 1;
      drained.push(slot);
      progressed = true;
      over -= 1;
      if (over < 1) {
        balanceStartSlot = BALANCE_ORDER[(k + 1) % BALANCE_ORDER.length];
        return drained;
      }
    }
    // Unreachable after the headroom check (every pass takes a point while
    // headroom remains) — the guard keeps a future caller from hanging the page.
    if (fullPass && !progressed) {
      throw new Error('BalanceAttributes: a full pass absorbed nothing (the caller must clamp first)');
    }
  }
}

/**
 * CharGenState::Set<Attr>(value, balance) @ 005c4660…: refuses a rise when
 * GetAbsRemainingCredits is 0, else stores the value and balances the
 * others when asked. Returns the stored value (the old one when refused).
 */
export function setAttributeSlot(state: AttributeCreditsState, index: number, value: number, balance: boolean): number {
  const current = state.values[index];
  if (current < value && absRemainingCredits(state, index) === 0) return current;
  state.values[index] = value;
  if (balance) balanceAttributes(state, index);
  return value;
}

/**
 * gmCGProfessionPage::SetAttribValue @ 00482890: a rise beyond
 * GetAbsRemainingCredits is clamped to current + that, then
 * Set<Attr>(value, 1). Returns the value stored.
 */
export function setAttributeFromPage(state: AttributeCreditsState, index: number, value: number): number {
  const current = state.values[index];
  let target = value;
  if (target - current >= 0) {
    const room = absRemainingCredits(state, index);
    if (room < target - current) target = current + room;
  }
  return setAttributeSlot(state, index, target, true);
}

/** ListenToElementMessage's message 10: ftol(position × 100), floored at 10. */
export function sliderValueFromPosition(position: number): number {
  const value = Math.trunc(position * 100 + 1e-9);
  return value < ATTRIBUTE_FLOOR ? ATTRIBUTE_FLOOR : value;
}

/** UpdateAttributeValues' p134 for a value. */
export function sliderPositionForValue(value: number): number {
  return value * SLIDER_POSITION_PER_POINT;
}

/** ComputeActiveSize with p126 off: the scrolling area less the widget. */
export function sliderActiveWidth(trackWidth: number = ATTRIBUTE_SLIDER_RECT.width, widgetWidth: number = ATTRIBUTE_SLIDER_WIDGET_SIZE.width): number {
  return trackWidth - widgetWidth;
}

/** PositionToWidgetX0Y0: the widget's left edge at ftol(position × active). */
export function sliderWidgetX(position: number, trackWidth: number = ATTRIBUTE_SLIDER_RECT.width, widgetWidth: number = ATTRIBUTE_SLIDER_WIDGET_SIZE.width): number {
  return Math.trunc(position * sliderActiveWidth(trackWidth, widgetWidth) + 1e-6);
}

/**
 * VISUAL.chargen-profession-sliders — UIElement_Scrollbar::UpdateLayout
 * @ 004710d0 sizes the bar child 0x4 from the track's left edge to the
 * widget's centre (MoveTo(0, 0), ResizeTo(widgetX + widgetW / 2, h)): the
 * strip fills only up to the diamond; no trailing child 0x6 in 0x100002ea.
 */
export function sliderBarWidth(position: number, trackWidth: number = ATTRIBUTE_SLIDER_RECT.width, widgetWidth: number = ATTRIBUTE_SLIDER_WIDGET_SIZE.width): number {
  return sliderWidgetX(position, trackWidth, widgetWidth) + Math.trunc(widgetWidth / 2);
}

/**
 * PointToPosition: the press x (track-relative) less half the widget, held
 * to [0, active − 1], over active − 1 (0 when active < 2).
 */
export function sliderPointToPosition(x: number, trackWidth: number = ATTRIBUTE_SLIDER_RECT.width, widgetWidth: number = ATTRIBUTE_SLIDER_WIDGET_SIZE.width): number {
  const active = sliderActiveWidth(trackWidth, widgetWidth);
  const span = active - 1;
  if (span < 1) return 0;
  let px = Math.trunc(x) - Math.trunc(widgetWidth / 2);
  if (px < 0) px = 0;
  else if (px > span) px = span;
  return px / span;
}

/** SetScrollbarPosition's [0, 1] clamp. */
export function clampSliderPosition(position: number): number {
  return position < 0 ? 0 : position > 1 ? 1 : position;
}

// ─── CORE.17.k.b.b.a.f.c — the widget drag as UIElement_Scrollbar runs it ──
//
// Ground truth (decompiled EoL client, docs/retail-client-symbols.md
// CORE.17.k.b.b.a.f.c):
//  - UIElement::MouseDown @ 00460f10 / MouseMove @ 00463310 / MouseUp @
//    00463940 broadcast messages 0x1c / 0x1e / 0x1d with ptElement = the
//    mouse less the element's screen origin; UIElementManager::
//    MouseDownEvent @ 0045db60 captures the mouse on the pressed element,
//    so every move until the release reaches the scrollbar (or its widget)
//    wherever the pointer is. GetScrollbarPositionFromMessage @ 00470260
//    adds the widget's offset when the message is the widget's — every
//    point below is in the SCROLLBAR's coordinates.
//  - ListenToElementMessage @ 00471870: 0x1c on the widget, or on the bar
//    with p124 move-to-touched (bit 0x40) → StartWidgetDrag @ 00470fb0:
//    with bit 0x40 ScrollToPoint @ 00470f50 (PointToPosition →
//    SetScrollbarPosition, whether the press is on the widget or the bar —
//    the widget is recentred under the mouse); then m_ptDragStart = the
//    point, m_fResetPosition = p134, m_bWidgetDragActive = true. The
//    message-10 broadcast inside a broadcast is QUEUED (BroadcastElement
//    Message @ 0045ab40 m_bBroadcastingMessage), so m_fResetPosition is the
//    press's own PointToPosition, before gmCGProfessionPage's clamp.
//  - 0x1e while the pressing action is held on the element: the secondary
//    coordinate (y for a horizontal bar, GetSecondaryCoordinate @
//    004704f0) must satisfy |y| < 0x65 — a band from 100 px above the
//    bar's TOP edge to 100 px below it. Inside: with bit 0x40 ScrollToPoint
//    (the widget recentres), without it ScrollNPixelsFromReset @ 00471020
//    (m_fResetPosition + Δprimary / ComputeActiveSize); active = true.
//    Outside with the drag active: SetScrollbarPosition(m_fResetPosition)
//    — the widget snaps back to the press position — and active = false;
//    coming back inside resumes. 0x1d ends the drag (active = false).
//  - m_nMouseWidgetXOffset / YOffset are written in the constructor
//    (0046fff0) and never read — no widget-relative grab offset exists.
//  - p131 smooth movement only animates a p133 write (OnSetAttribute @
//    004714d0 case 0x85 → StartAnimation @ 00470550), which returns without
//    p132; SetScrollbarPosition writes p134 directly — a press or a drag
//    never eases. The 0x100002ea slider has p123 / p124 / p131 and no p132.

/** |secondary coordinate| must be below this for a move to drive the bar (0x65). */
export const SCROLLBAR_DRAG_BAND = 0x65;

/** UIElement_Scrollbar's drag fields: m_ptDragStart, m_fResetPosition, m_bWidgetDragActive. */
export interface ScrollbarDragState {
  dragStart: { x: number; y: number };
  resetPosition: number;
  widgetDragActive: boolean;
}

export interface ScrollbarGeometry {
  /** p124 — a press on the bar (or the widget) recentres the widget under the mouse. */
  moveToTouched?: boolean;
  /** p123 — the bar runs along x (the chargen slider does). */
  horizontal?: boolean;
  trackWidth?: number;
  widgetWidth?: number;
}

const CHARGEN_SLIDER: Required<ScrollbarGeometry> = {
  moveToTouched: true, horizontal: true, trackWidth: ATTRIBUTE_SLIDER_RECT.width, widgetWidth: ATTRIBUTE_SLIDER_WIDGET_SIZE.width,
};

/** GetSecondaryCoordinate @ 004704f0: y for a horizontal bar, x otherwise. */
export function scrollbarSecondaryCoordinate(point: { x: number; y: number }, horizontal = true): number {
  return horizontal ? point.y : point.x;
}

/** The primary coordinate — the one PointToPosition / ScrollNPixelsFromReset read. */
function scrollbarPrimaryCoordinate(point: { x: number; y: number }, horizontal: boolean): number {
  return horizontal ? point.x : point.y;
}

/**
 * ScrollToPoint @ 00470f50: PointToPosition of the point (in the bar's
 * coordinates) → SetScrollbarPosition's [0, 1] clamp.
 */
export function scrollbarScrollToPoint(point: { x: number; y: number }, geometry: ScrollbarGeometry = {}): number {
  const g = { ...CHARGEN_SLIDER, ...geometry };
  return clampSliderPosition(sliderPointToPosition(scrollbarPrimaryCoordinate(point, g.horizontal), g.trackWidth, g.widgetWidth));
}

/**
 * ScrollNPixelsFromReset @ 00471020: m_fResetPosition + Δprimary / the
 * active size (0 when the active size is 0), clamped by SetScrollbarPosition.
 */
export function scrollbarScrollNPixelsFromReset(state: ScrollbarDragState, delta: { x: number; y: number }, geometry: ScrollbarGeometry = {}): number {
  const g = { ...CHARGEN_SLIDER, ...geometry };
  const active = sliderActiveWidth(g.trackWidth, g.widgetWidth);
  if (active === 0) return 0;
  return clampSliderPosition(scrollbarPrimaryCoordinate(delta, g.horizontal) / active + state.resetPosition);
}

/**
 * StartWidgetDrag @ 00470fb0 on message 0x1c: with p124 the widget goes to
 * the point first (ScrollToPoint); then the drag start, the reset position
 * (p134 as it reads inside the broadcast — the press's own position when
 * p124 moved it, the position before the press otherwise) and the active
 * flag. Returns the state and the position the press set (`moved` false
 * when p124 is off and nothing was set).
 */
export function startWidgetDrag(
  point: { x: number; y: number }, positionBeforePress: number, geometry: ScrollbarGeometry = {},
): { state: ScrollbarDragState; position: number; moved: boolean } {
  const g = { ...CHARGEN_SLIDER, ...geometry };
  const position = g.moveToTouched ? scrollbarScrollToPoint(point, g) : clampSliderPosition(positionBeforePress);
  return {
    state: { dragStart: { x: point.x, y: point.y }, resetPosition: position, widgetDragActive: true },
    position,
    moved: g.moveToTouched,
  };
}

/**
 * ListenToElementMessage @ 00471870 case 0x1e while the press is held:
 * inside the ±100 px band the bar follows the point (ScrollToPoint with
 * p124, ScrollNPixelsFromReset without) and the drag is active; the first
 * move outside it with the drag active snaps the bar back to the reset
 * position and deactivates it; further moves outside set nothing. Returns
 * the position SetScrollbarPosition receives, or null when nothing is set.
 */
export function scrollbarDragMove(state: ScrollbarDragState, point: { x: number; y: number }, geometry: ScrollbarGeometry = {}): number | null {
  const g = { ...CHARGEN_SLIDER, ...geometry };
  if (Math.abs(Math.trunc(scrollbarSecondaryCoordinate(point, g.horizontal))) < SCROLLBAR_DRAG_BAND) {
    state.widgetDragActive = true;
    if (g.moveToTouched) return scrollbarScrollToPoint(point, g);
    return scrollbarScrollNPixelsFromReset(state, { x: point.x - state.dragStart.x, y: point.y - state.dragStart.y }, g);
  }
  if (state.widgetDragActive) {
    state.widgetDragActive = false;
    return state.resetPosition;
  }
  return null;
}

/** Case 0x1d: the release ends the drag. */
export function endWidgetDrag(state: ScrollbarDragState): void {
  state.widgetDragActive = false;
}

// ─── CORE.17.k.b.b.a.f.a — the value box 0x100002ef as an edit field ────

/** The value box's DAT element type (UIElement_Text). */
export const ATTRIBUTE_VALUE_ELEMENT_TYPE = 12;
/** p30 — m_nMaxCharacters: the box holds three characters. */
export const ATTRIBUTE_VALUE_MAX_CHARS = 3;
/** The UIElement_Text properties the value box sets (OnSetAttribute @ 0046a640). */
export const ATTRIBUTE_VALUE_PROPS = {
  editable: 22, maxCharacters: 30, selectable: 39, loseFocusOnEscape: 203, loseFocusOnAcceptInput: 204,
} as const;
/** The focus-loss commit's bounds: v < 101 ? max(10, v) : 100. */
export const ATTRIBUTE_VALUE_COMMIT_CEILING = 100;

/**
 * UIElement_Text::CharacterHandler @ 00469b90 — a character reaches the
 * text unless it is a control character (< 0x20), DEL (0x7f), or refused by
 * m_filter; the value box has no filter (InitializePage gives
 * NumberInputFilter to the NAME text 0x100002ed, not to pAttibValue).
 */
export function valueBoxCharAllowed(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

/** The typed text as the box keeps it: refused characters dropped, cut to p30's three. */
export function filterValueBoxInput(text: string, maxChars = ATTRIBUTE_VALUE_MAX_CHARS): string {
  return Array.from(text).filter(valueBoxCharAllowed).slice(0, maxChars).join('');
}

/**
 * PStringBase<unsigned_short>::to_uint32 @ 00478780 = wcstoul(text, 0, 0):
 * leading whitespace, an optional sign, "0x" → hexadecimal, a leading "0" →
 * OCTAL, else decimal; 0 when no digit follows; a negative value wraps
 * modulo 2^32; an overflow saturates at ULONG_MAX.
 */
export function wcstoulBase0(text: string): number {
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++;
  let negative = false;
  if (text[i] === '+' || text[i] === '-') { negative = text[i] === '-'; i++; }
  let base = 10;
  if (text[i] === '0') {
    if ((text[i + 1] === 'x' || text[i + 1] === 'X') && /[0-9a-fA-F]/.test(text[i + 2] ?? '')) { base = 16; i += 2; }
    else base = 8;
  }
  const digits = base === 16 ? /[0-9a-fA-F]/ : base === 8 ? /[0-7]/ : /[0-9]/;
  let value = 0;
  let any = false;
  for (; i < text.length && digits.test(text[i]); i++) {
    value = value * base + parseInt(text[i], base);
    any = true;
    if (value > 0xffffffff) value = 0xffffffff;
  }
  if (!any) return 0;
  if (negative) value = (0x100000000 - value) % 0x100000000;
  return value;
}

/**
 * ListenToElementMessage @ 004829c0, 0x100002ef on message 0x2f without
 * dwParam1 (focus lost): to_uint32 of the text held to [10, 100] — the
 * value SetAttribValue then clamps to the credits and balances.
 */
export function attributeValueFromText(text: string): number {
  const v = wcstoulBase0(text);
  if (v > ATTRIBUTE_VALUE_COMMIT_CEILING) return ATTRIBUTE_VALUE_COMMIT_CEILING;
  return v < ATTRIBUTE_FLOOR ? ATTRIBUTE_FLOOR : v;
}

/**
 * The same case on messages 0x12 / 0x44 (a key, a deletion): the slider's
 * p133 = clamp(to_float(text) × 0.01, 0.1, 1.0) — wcstod of the leading
 * decimal number (0 when there is none). Retail never shows it (see the
 * header: StartAnimation needs the absent p132), so this is the recorded
 * target, not a widget position.
 */
export function sliderTargetFromText(text: string): number {
  const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text);
  const f = m ? Number.parseFloat(m[0]) : 0;
  const target = (Number.isFinite(f) ? f : 0) * SLIDER_POSITION_PER_POINT;
  return target < 0.1 ? 0.1 : target > 1 ? 1 : target;
}
