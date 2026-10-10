/**
 * SpewBoxModel — the retail client's transient notice strip over the 3D
 * view (gmSpewBoxUI), CORE.17.k.
 *
 * Retail routing of client-originated notices (decompiled EoL client,
 * reference/client-eol/decomp/acclient-decompiled.c):
 *
 *  - ~96 UI call sites (BeginTeleportAnimation's "In Portal Space - Please
 *    Wait..." @ 207505 among them) raise `ECM_UI::SendNotice_DisplayStringInfo
 *    (0x1a, str)`. The receiver `ClientCommunicationSystem::
 *    RecvNotice_DisplayStringInfo` @ 0056e890 forwards to `ClientSystem::
 *    AddTextToScroll` @ 00563c50, which special-cases text type 0x1a: no
 *    timestamp prefix, not written to the chat log file, then
 *    `SendNotice_DisplayFinalStringInfo(0x1a, ...)`.
 *  - Every chat window is a ChatInterface whose constructor @ 004f4550
 *    seeds its 64-bit type filter to ~0 and then `&= 0xfbffffff` — bit 0x1a
 *    is the ONE bit cleared. `ChatInterface::RecvNotice_DisplayFinalStringInfo`
 *    @ 004f4640 shows an untargeted line only when `TypeIsActive` @ 004f2f10
 *    (`(1 << type) & filter`), so UNTARGETED type-0x1a text never reaches a
 *    chat window unless the player ticks Chat Options > "Errors" (mask
 *    0x4000000, the same bit — see FloatyChatModel.CHAT_FILTER_CHANNELS).
 *    A line TARGETED at a window id skips that check: chat-command feedback
 *    targets the window the command was typed in (ClientNotices.ts), so
 *    "@reply" with no text shows in the main chat too
 *    (BUG.main-chat-shows-error-lines-in-retail).
 *  - The only other receiver, `gmSpewBoxUI::RecvNotice_DisplayFinalStringInfo`
 *    @ 004d60a0, accepts EXACTLY type 0x1a and queues the string; `Update`
 *    @ 004d5df0 (per UseTime tick) turns each queued string into a text
 *    item, right-trims it, drops the current top item when its text is
 *    identical, inserts the new item at index 0 and deletes the last item
 *    when the list exceeds `m_maxConcurrentItems` (list property 0x10000028).
 *    `ListenToElementMessage` @ 004d57c0 deletes an item when it raises
 *    element message 0x10000003.
 *
 * DAT (client_local_English.dat, layout 0x21000011):
 *  - 0x10000048 type 0x10000016 (gmSpewBoxUI) 450x72, edges L3/T1/R3/B2.
 *  - 0x10000049 type 5 (ListBox) 450x72, property 0x10000028 = 4 items.
 *  - 0x1000004a item template 450x18: properties 0x14 / 0x15 (horizontal /
 *    vertical justification) = 1 → centred both ways (UIElement_Text::
 *    CalcJustification @ 00467260: 1 halves the free space); default state
 *    0x10000002 carries font colour 0x1b = ARGB 0xFFFF0000 and two media:
 *    a 5-second timer (min = max = 5) followed by element message 0x10000003
 *    — the item lives 5 s and then deletes itself.
 *  - The template's base element is 0x2100003f:0x10000377 (type 12, the
 *    UIElement_Text base), whose p26 font is 0x40000001 = Palatino_Linotype_18.
 *    gmSpewBoxUI::Update @ 004d5df0 instantiates it by layout enum
 *    0x10000012 (UILAYOUT mapper → 0x21000011 "classic_spewbox") and only
 *    calls SetText, so the row draws in that inherited font — not the
 *    UIElement_Text ctor default GetByEnum(0x18, 9) = "Default" 0x40000002,
 *    nor our general UI font 0x40000000
 *    (VISUAL.spew-row-text-narrower-than-retail, 2026-09-29: the EoR frames'
 *    "Use comma after the name for targeted chat." spans 270 px, as
 *    0x40000001 measures it; 0x40000000 measured 222).
 *  - BUT the end-of-retail exe draws the rows YELLOW, not the DAT red
 *    (BUG.spew-text-color-yellow-in-retail, 2026-09-28). A/B under Wine on
 *    the same DATs + ACE: the ac1_sep13 build our decomp comes from draws
 *    ff0000, and ff0000ff (blue) once the template's p27 is patched to it,
 *    so that build honours the DAT; the EoR build 00.00.11.6096 draws ffff00
 *    with the stock DAT AND with the blue patch, so the shipped client
 *    overrides the template colour in code (RGBAColor_Yellow {1,1,0}; the
 *    black halo stays). Main-chat copies of the same 0x1a line stay red in
 *    both builds (the chat colour table). The fidelity target is EoR, so the
 *    strip uses the yellow.
 *  - Hosted by the 3D-view layout 0x2100000f pane 0x10000046 at (0,20)
 *    450x72, edges L3/T1/R3/B2 → centred horizontally, 20px from the top.
 *
 * The 2026-06 pre-world audit's retail reference portal-space-web1.jpg shows
 * exactly this: "In Portal Space - Please Wait" red, centred near the top of
 * the frame, no chat line. GAP.81 (2026-07-20) read the AddTextToScroll hop
 * as "a plain chat line" and moved the text INTO the chat scroll; that
 * refutation missed the 0x1a filter bit and the spew box, and is reversed
 * here.
 */

export const SPEW_BOX_LAYOUT = 0x21000011;
export const SPEW_BOX_ELEMENT = 0x10000048;
export const SPEW_BOX_ELEMENT_TYPE = 0x10000016;
export const SPEW_BOX_LIST = 0x10000049;
export const SPEW_ITEM_TEMPLATE = 0x1000004a;
/** 3D-view layout + the pane inside it that hosts the spew box. */
export const SPEW_HOST_LAYOUT = 0x2100000f;
export const SPEW_HOST_PANE = 0x10000046;

export const SPEW_BOX_WIDTH = 450;
export const SPEW_BOX_HEIGHT = 72;
export const SPEW_BOX_TOP = 20;
export const SPEW_ITEM_HEIGHT = 18;
/** p26 of the template's base element 0x2100003f:0x10000377: Palatino_Linotype_18. */
export const SPEW_TEXT_FONT_DID = 0x40000001;
/** ListBox property 0x10000028 on 0x10000049. */
export const SPEW_MAX_ITEMS = 4;
/** Timer media on the item template's default state: 5 s, then message 0x10000003. */
export const SPEW_ITEM_LIFETIME_MS = 5000;
/** Item template font colour property 0x1b (DAT ARGB) — honoured by ac1_sep13, overridden by EoR. */
export const SPEW_TEXT_COLOR_ARGB = 0xffff0000;
/** What the end-of-retail exe draws the rows in: RGBAColor_Yellow {1,1,0} (see the header). */
export const SPEW_TEXT_COLOR_EOR_ARGB = 0xffffff00;
/** The text type every DisplayStringInfo notice carries ("Errors" in Chat Options). */
export const ERROR_TEXT_TYPE = 0x1a;
/** The element message the item's timer media raises when it expires. */
export const SPEW_ITEM_EXPIRE_MESSAGE = 0x10000003;

/** DAT ARGB colour property → CSS hex (alpha dropped; the DAT value is opaque). */
export function argbToCssHex(argb: number): string {
  return '#' + (argb & 0xffffff).toString(16).padStart(6, '0');
}

/** The spew row text colour: the EoR build's yellow, not the template's p27 red. */
export const SPEW_TEXT_COLOR = argbToCssHex(SPEW_TEXT_COLOR_EOR_ARGB);
/**
 * The same 0x1a line as a chat-log row: red in the real client (Wine frames
 * of both builds, fe0000 / ff0000). Retail colours chat rows from the chat
 * colour table, not the spew template; which window gets it is
 * BUG.main-chat-shows-error-lines-in-retail (ClientNotices.ts).
 */
export const ERROR_TEXT_CHAT_COLOR = argbToCssHex(SPEW_TEXT_COLOR_ARGB);
/**
 * CORE.17.k.b.b — the item template's default state 0x10000002 also sets
 * p33 (UIElement_Text::SetOutline) with no p34, so the row is outlined in
 * m_curOutlineColor's seed RGBAColor_Black (docs/retail-client-symbols.md).
 */
export const SPEW_TEXT_OUTLINE_COLOR = argbToCssHex(0xff000000);

export interface SpewItem {
  text: string;
  /** Wall-clock ms at which the item's 5-second timer fires. */
  expiresAt: number;
}

export interface SpewPushResult {
  /** The item that was inserted at the top. */
  item: SpewItem;
  /** Items removed by this push: the identical top item and/or the overflow tail. */
  removed: SpewItem[];
}

/**
 * Horizontal origin of a leftEdge=3/rightEdge=3 child (UIElement::
 * UpdateForParentSizeChange @ 00462640: floor(parentW/2) - floor(childW/2)).
 */
export function spewBoxLeft(parentWidth: number, boxWidth = SPEW_BOX_WIDTH): number {
  return Math.floor(parentWidth / 2) - Math.floor(boxWidth / 2);
}

/** Retail right-trims the notice (PStringBase::trim(false, true)). */
export function normalizeSpewText(text: string): string {
  return text.replace(/\s+$/u, '');
}

export class SpewBoxModel {
  /** Newest first (retail inserts at index 0). */
  readonly items: SpewItem[] = [];

  constructor(
    private readonly maxItems: number = SPEW_MAX_ITEMS,
    private readonly lifetimeMs: number = SPEW_ITEM_LIFETIME_MS,
  ) {}

  /** gmSpewBoxUI::Update for one pending string. */
  push(rawText: string, nowMs: number): SpewPushResult {
    const text = normalizeSpewText(rawText);
    const removed: SpewItem[] = [];
    // Identical text at the top: retail deletes that item before inserting.
    if (this.items.length > 0 && this.items[0].text === text) {
      removed.push(this.items.shift()!);
    }
    const item: SpewItem = { text, expiresAt: nowMs + this.lifetimeMs };
    this.items.unshift(item);
    while (this.items.length > this.maxItems) {
      removed.push(this.items.pop()!);
    }
    return { item, removed };
  }

  /** Items whose 5-second timer has fired (message 0x10000003 → DeleteItem). */
  expire(nowMs: number): SpewItem[] {
    const expired: SpewItem[] = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].expiresAt <= nowMs) expired.push(...this.items.splice(i, 1));
    }
    return expired;
  }

  /** Earliest pending expiry, or null when empty. */
  nextExpiry(): number | null {
    if (this.items.length === 0) return null;
    return Math.min(...this.items.map((i) => i.expiresAt));
  }

  clear(): void {
    this.items.length = 0;
  }
}
