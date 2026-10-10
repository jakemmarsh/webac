/**
 * LinkStatusModel — the retail Link Indicator's four-state model, CORE.17.k.
 *
 * Retail signals connection trouble ONLY through the LinkStatus strip
 * element (0x100000f8, gmUIElement_LinkStatusIndicator), never as chat text.
 * Decompiled EoL client (reference/client-eol/decomp/acclient-decompiled.c):
 *
 *  - `LinkStatusHolder::GetConnectionStatus` @ 00411380 returns the seconds
 *    since the last packet from the current server (Timer::cur_time -
 *    m_tLastHeardFromCurServer) and whether the holder is in
 *    LinkStatus_Connected.
 *  - `gmUIElement_LinkStatusIndicator::UpdateLinkState` @ 004e6730:
 *      connected && dt <= UNCERTAIN_LINK_TIME → state 1
 *      connected && dt <= BAD_LINK_TIME       → state 2
 *      connected && dt <= LOST_LINK_TIME      → state 3
 *      otherwise (or not connected)           → state 4
 *  - `SetLinkState` @ 004e65e0 switches the element to state media 0x11 /
 *    0x12 / 0x13 / 0x14 for states 1-4 and stamps m_ttLastFlash on entering 3.
 *  - `UseTime` @ 004e67c0 re-evaluates every CHECK_LINK_STATUS_INTERVAL and,
 *    while in state 3, flips the displayed media between 0x12 and 0x13 every
 *    FLASH_INTERVAL.
 *
 * Constants read from acclient.exe .rdata (objdump of UpdateLinkState /
 * UseTime → fcom operands 0x7c1230..0x7c1250, doubles):
 *   CHECK_LINK_STATUS_INTERVAL = 4.0   FLASH_INTERVAL = 0.75
 *   UNCERTAIN_LINK_TIME = 5.0   BAD_LINK_TIME = 20.0   LOST_LINK_TIME = 40.0
 * They agree with the retail help text (string 0x38fabf3 in table
 * 0x23000001, reference/images/hud/link-status.jpg): "YELLOW = no packets for
 * at least 5 sec. RED = no packets for at least 20 sec. If approximately
 * forty seconds pass without receiving a packet, you will be disconnected".
 *
 * DAT (indicator strip layout 0x21000071, element 0x100000f8): state 0x11 →
 * texture 0x06007498 (green), 0x12 → 0x06007499 (yellow), 0x13 and 0x14 →
 * 0x0600749a (red).
 */

export const CHECK_LINK_STATUS_INTERVAL_S = 4.0;
export const FLASH_INTERVAL_S = 0.75;
export const UNCERTAIN_LINK_TIME_S = 5.0;
export const BAD_LINK_TIME_S = 20.0;
export const LOST_LINK_TIME_S = 40.0;

export enum LinkState {
  /** Unset — retail's m_eLinkState before the first UpdateLinkState. */
  None = 0,
  Good = 1,
  Uncertain = 2,
  Bad = 3,
  Lost = 4,
}

/** Element state ids SetLinkState switches 0x100000f8 to, by LinkState. */
export const LINK_STATE_MEDIA: Readonly<Record<LinkState, number>> = {
  [LinkState.None]: 0,
  [LinkState.Good]: 0x11,
  [LinkState.Uncertain]: 0x12,
  [LinkState.Bad]: 0x13,
  [LinkState.Lost]: 0x14,
};

/** Texture behind each element state (layout 0x21000071 / 0x100000f8 state media). */
export const LINK_STATE_TEXTURES: Readonly<Record<number, number>> = {
  0x11: 0x06007498,
  0x12: 0x06007499,
  0x13: 0x0600749a,
  0x14: 0x0600749a,
};

export interface LinkSample {
  /** LinkStatusHolder state == LinkStatus_Connected. */
  connected: boolean;
  /** Seconds since the last packet from the current server. */
  secondsSinceLastPacket: number;
}

/** gmUIElement_LinkStatusIndicator::UpdateLinkState — the threshold ladder. */
export function computeLinkState(sample: LinkSample): LinkState {
  const dt = sample.secondsSinceLastPacket;
  if (!sample.connected) return LinkState.Lost;
  if (dt <= UNCERTAIN_LINK_TIME_S) return LinkState.Good;
  if (dt <= BAD_LINK_TIME_S) return LinkState.Uncertain;
  if (dt <= LOST_LINK_TIME_S) return LinkState.Bad;
  return LinkState.Lost;
}

/**
 * The indicator element's timing: a 4-second re-evaluation cadence plus the
 * 0.75-second yellow/red flash while the link is Bad. `tick()` returns the
 * element state id (0x11..0x14) the strip should currently show.
 */
export class LinkStatusIndicatorModel {
  private state: LinkState = LinkState.None;
  private displayed = 0;
  private lastUpdateS = Number.NEGATIVE_INFINITY;
  private lastFlashS = 0;

  get linkState(): LinkState { return this.state; }
  get displayedState(): number { return this.displayed; }

  /** SetLinkState: only a CHANGE re-paints; entering Bad restarts the flash clock. */
  setLinkState(next: LinkState, nowS: number): void {
    if (this.state === next) return;
    this.state = next;
    this.displayed = LINK_STATE_MEDIA[next];
    if (next === LinkState.Bad) this.lastFlashS = nowS;
  }

  /** Force the next tick to re-evaluate regardless of the 4-second cadence. */
  invalidate(): void {
    this.lastUpdateS = Number.NEGATIVE_INFINITY;
  }

  reset(): void {
    this.state = LinkState.None;
    this.displayed = 0;
    this.invalidate();
    this.lastFlashS = 0;
  }

  /** gmUIElement_LinkStatusIndicator::UseTime for one frame. */
  tick(nowS: number, sample: LinkSample): number {
    if (nowS - this.lastUpdateS > CHECK_LINK_STATUS_INTERVAL_S) {
      this.setLinkState(computeLinkState(sample), nowS);
      this.lastUpdateS = nowS;
    }
    if (this.state === LinkState.Bad && nowS - this.lastFlashS >= FLASH_INTERVAL_S) {
      this.displayed = this.displayed === 0x12 ? 0x13 : 0x12;
      this.lastFlashS = nowS;
    }
    return this.displayed;
  }
}
