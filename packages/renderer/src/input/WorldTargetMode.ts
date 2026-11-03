/**
 * WorldTargetModeController — armed Examine/Use world-target mode (GAP.84).
 *
 * Mirrors retail's ClientUISystem::ExamineObject/UseObject/SetTargetMode
 * (decompiled acclient-eol, ~0x005649b0/~0x00564a10/~0x00564940): pressing
 * Examine/Use with a known target acts on it immediately (param_1 != 0
 * branch). Pressing with nothing currently selected instead arms
 * TARGET_MODE_EXAMINE/TARGET_MODE_USE and returns without acting; the next
 * world-object click is dispatched through ExecuteTargetModeForItem
 * (~0x00564b30), which executes the examine/use on whatever was clicked and
 * resets the mode to TARGET_MODE_NONE. A click that misses every object
 * leaves the mode armed — no decompiled evidence of auto-cancel-on-miss.
 * Escape (retail's m_bLeaveTargetMode flag) and session end
 * (OnEndCharacterSession) disarm an armed mode without acting.
 *
 * BUG.ac1999-fellowship-refusal-wording — the 1999 client's fellowship panel arms two more modes
 * through the same SetTargetMode (0x004d0220): 7 recruit and 8 dismiss (FellowPanel_ListenToMessage
 * @ 0x00535770); PanelUI_HandleMouseDownOnObject @ 0x004f83c0 sends the clicked object to
 * FellowPanel_RecruitObject / FellowPanel_DismissObject (arm()).
 *
 * Those two are one-click modes (isOneClickMode). SetTargetMode's arms 1-8 all call 0x00415890,
 * which sets the "target cursor up" flag 0x0063048c; the mouse dispatch 0x00414030 turns the next
 * left press ANYWHERE into the 'd' event and clears the flag (0x004158c0, the cursor back to normal).
 * So the very next left press ends the mode whatever it lands on: an object runs the mode, a miss
 * or any other control just ends it (the 'd' press does nothing there). BUG.ac1999-fellowship-target-mode-clicks:
 * read from the disassembly (0x004d0220's jump table at 0x004d033b).
 */
export type WorldTargetMode = 'none' | 'examine' | 'use' | 'recruit' | 'dismiss';

/** The 1999 fellowship modes: the next left press anywhere ends them (see above). */
export function isOneClickMode(mode: WorldTargetMode): mode is 'recruit' | 'dismiss' {
  return mode === 'recruit' || mode === 'dismiss';
}

/**
 * Where a left press goes while a one-click mode is armed. 'pass': the 3D view (Box3D_FoundObject →
 * PanelUI_HandleMouseDownOnObject @ 0x004f83c0), the radar (RadarUI_Global_MouseDown @ 0x00528e00,
 * the same call) and a fellow's row (0x00533e50) take the 'd' press and run the mode. 'end': every
 * other control gets a 'd' press it ignores (the pack @ InventoryPanel MouseDown and the shortcut bar
 * 0x00500fa0 act only on modes 1 / 2 / 4 / 5), so the press is swallowed and only ends the mode.
 */
export function oneClickPressRoute(target: Element | null, worldCanvas: Element | null): 'pass' | 'end' {
  if (!target) return 'end';
  if (worldCanvas && target === worldCanvas) return 'pass';
  return target.closest?.('#radar-canvas, [data-fellow-guid]') ? 'pass' : 'end';
}

/**
 * Swallow a press and the click that follows it: the 1999 'd' press does nothing on that control
 * (no button press, no selection). A press released elsewhere sends no click, so the next press
 * drops the click eater.
 */
export function swallowPress(e: Event, doc: Document): void {
  e.stopPropagation();
  e.preventDefault();
  const eat = (c: Event): void => { c.stopPropagation(); c.preventDefault(); };
  doc.addEventListener('click', eat, { capture: true, once: true });
  doc.addEventListener('mousedown', () => doc.removeEventListener('click', eat, true), { capture: true, once: true });
}

/**
 * A fellow's row under a one-click mode (FellowRegion 0x00533e50 takes the 'd' press): dismiss and
 * examine (mode 2 → 0x004e6b40) run on that fellow; recruit and use have no arm there, so the press only
 * ends the mode. Either way nothing is selected. null: no one-click mode, the row's ordinary click.
 */
export function fellowRowPress(c: WorldTargetModeController, guid: number): { run: 'dismiss' | 'examine' | null; guid: number } | null {
  const mode = c.current;
  if (!c.isOneClick(mode)) return null;
  c.disarm();
  return { run: mode === 'dismiss' || mode === 'examine' ? mode : null, guid };
}

export type TriggerResult =
  | { kind: 'act'; targetGuid: number }
  | { kind: 'armed' };

export type ClickResult =
  | { kind: 'not-armed' }
  | { kind: 'miss' }
  | { kind: 'executed'; mode: Exclude<WorldTargetMode, 'none'>; targetGuid: number };

export class WorldTargetModeController {
  private mode: WorldTargetMode = 'none';

  /**
   * BUG.ac1999-use-examine-one-click — whether use / examine follow the same one-click rule
   * (EraClientRules.oneClickTargetModes): the 1999 client's arms 1 / 2 set the same target-cursor flag,
   * so the next left press anywhere ends them too. End of retail (ExecuteTargetModeForItem) keeps them
   * armed through a miss.
   */
  constructor(private readonly useExamineOneClick = false) {}

  /** Whether `mode` ends on the next left press anywhere, hit or miss, and never selects. */
  isOneClick(mode: WorldTargetMode): boolean {
    if (isOneClickMode(mode)) return true;
    return this.useExamineOneClick && (mode === 'use' || mode === 'examine');
  }

  get current(): WorldTargetMode {
    return this.mode;
  }

  /** ACT.ExamineSelected / ACT.UseSelected keypress. */
  trigger(which: 'examine' | 'use', currentTargetGuid: number | null): TriggerResult {
    if (currentTargetGuid) return { kind: 'act', targetGuid: currentTargetGuid };
    this.mode = which;
    return { kind: 'armed' };
  }

  /** The 1999 fellowship panel's Recruit / Dismiss: arm the mode outright (SetTargetMode(7 / 8)). */
  arm(which: 'recruit' | 'dismiss'): void {
    this.mode = which;
  }

  /** Canvas click while a mode may be armed. `hitGuid` is null on a miss (a one-click mode ends on it). */
  consumeClick(hitGuid: number | null): ClickResult {
    if (this.mode === 'none') return { kind: 'not-armed' };
    if (hitGuid == null) {
      if (this.isOneClick(this.mode)) this.mode = 'none';
      return { kind: 'miss' };
    }
    const mode = this.mode;
    this.mode = 'none';
    return { kind: 'executed', mode, targetGuid: hitGuid };
  }

  /** Escape / session teardown. Returns whether an armed mode was cleared. */
  disarm(): boolean {
    if (this.mode === 'none') return false;
    this.mode = 'none';
    return true;
  }
}
