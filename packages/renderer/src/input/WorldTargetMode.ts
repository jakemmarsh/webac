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
 */
export type WorldTargetMode = 'none' | 'examine' | 'use';

export type TriggerResult =
  | { kind: 'act'; targetGuid: number }
  | { kind: 'armed' };

export type ClickResult =
  | { kind: 'not-armed' }
  | { kind: 'miss' }
  | { kind: 'executed'; mode: 'examine' | 'use'; targetGuid: number };

export class WorldTargetModeController {
  private mode: WorldTargetMode = 'none';

  get current(): WorldTargetMode {
    return this.mode;
  }

  /** ACT.ExamineSelected / ACT.UseSelected keypress. */
  trigger(which: 'examine' | 'use', currentTargetGuid: number | null): TriggerResult {
    if (currentTargetGuid) return { kind: 'act', targetGuid: currentTargetGuid };
    this.mode = which;
    return { kind: 'armed' };
  }

  /** Canvas click while a mode may be armed. `hitGuid` is null on a miss. */
  consumeClick(hitGuid: number | null): ClickResult {
    if (this.mode === 'none') return { kind: 'not-armed' };
    if (hitGuid == null) return { kind: 'miss' };
    const mode = this.mode as 'examine' | 'use';
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
