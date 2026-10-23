/**
 * The encumbrance notice (SWEEP1999.messages HC-9; every era). The burden indicator's art already
 * followed the load; no text did, in any era.
 *
 * End of retail: `CPlayerSystem::OnLoadChanged @ 0055f510` (decomp :343009) sends
 * DisplayStringInfo(0x1a) "You are severely encumbered!" when the load crosses up through 2.0, else
 * "You are encumbered!" when it crosses up through 1.0, once per crossing, then remembers the load
 * (m_fLoad starts at 0, so entering the world loaded says it too). The classic eras run that exe.
 *
 * 1999: `0x004fa610` (the load update) backdates the notice timer by 60 s when the load crosses up
 * through 1.0 or 2.0, and `PanelUI_Global_Loop @ 0x004f4e10` prints "You are encumbered" (load < 2)
 * or "You are severely encumbered" on the urgent status line whenever the load is at least 1.0 and
 * 60 s have passed since the last one: right away on crossing, then every minute while loaded.
 */

export interface EncumbranceNoticeRules {
  readonly encumbered: string;
  readonly severe: string;
  /** Seconds between repeats while loaded, or null for once per crossing (end of retail). */
  readonly repeatSeconds: number | null;
}

/** CPlayerSystem::OnLoadChanged's wide literals. */
export const EOR_ENCUMBRANCE_NOTICE: EncumbranceNoticeRules = Object.freeze({
  encumbered: 'You are encumbered!', severe: 'You are severely encumbered!', repeatSeconds: null,
});

/** PanelUI_Global_Loop's literals and its 60 s check (UI+0x400). */
export const AC1999_ENCUMBRANCE_NOTICE: EncumbranceNoticeRules = Object.freeze({
  encumbered: 'You are encumbered', severe: 'You are severely encumbered', repeatSeconds: 60,
});

export class EncumbranceNotice {
  private load = 0;
  /** 1999's UI+0x400, the last notice time (0 at start, so the first loaded check prints). */
  private lastShownSeconds = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly rules: EncumbranceNoticeRules,
    private readonly show: (text: string) => void,
  ) {}

  /** The load (burden / capacity) changed; `nowSeconds` is the client clock. */
  onLoad(load: number, nowSeconds: number): void {
    const old = this.load;
    if (load === old) return;
    this.load = load;
    const { rules } = this;
    if (rules.repeatSeconds === null) {
      if (old < 2 && load >= 2) this.show(rules.severe);
      else if (old < 1 && load >= 1) this.show(rules.encumbered);
      return;
    }
    // 0x004fa610: a crossing (strictly past the threshold) makes the next check print.
    if ((old < 2 && load > 2) || (old < 1 && load > 1)) this.lastShownSeconds = nowSeconds - rules.repeatSeconds;
    this.tick(nowSeconds);
  }

  /** Global_Loop's check (1999 only; end of retail prints from onLoad alone). */
  tick(nowSeconds: number): void {
    const { rules } = this;
    if (rules.repeatSeconds === null) return;
    if (this.load >= 1 && nowSeconds - this.lastShownSeconds >= rules.repeatSeconds) {
      this.show(this.load < 2 ? rules.encumbered : rules.severe);
      this.lastShownSeconds = nowSeconds;
    }
  }
}
