/**
 * FAITHFUL.471 — setCharacterInfo orphan removed.
 *
 *  Pre-fix `setCharacterInfo(info: typeof GameUI.prototype.charInfo)`
 *  was a defined-but-uncalled setter. main.ts uses
 *  `syncFromPlayerState` (line ~10420) which fully replaces
 *  `this.charInfo` from a PlayerState — covering name/level/
 *  heritage/gender/XP/attributes/vitals/skills. setCharacterInfo
 *  offered no additional path.
 *
 *  Sibling of FAITHFUL.468/.469 orphan-helper cleanup. Per
 *  FAITHFUL.437 drop-dead-code principle.
 *
 *  DEBT.test-harness-hygiene: converted from a GameUI.ts source pin to
 *  behaviour on the real class (absence on the prototype; the surviving
 *  syncFromPlayerState path driven with a real PlayerState).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { Gender } from '@ac/shared';

describe('FAITHFUL.471 — setCharacterInfo removed', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it('setCharacterInfo no longer exists on GameUI', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((H.mod.GameUI.prototype as any).setCharacterInfo).toBeUndefined();
    expect(H.ui.setCharacterInfo).toBeUndefined();
  });

  it('syncFromPlayerState still exists and replaces this.charInfo from the PlayerState', () => {
    const state = new PlayerState();
    state.name = '+Fable';
    state.gender = Gender.Female;
    H.ui.syncFromPlayerState(state);
    expect(H.ui.charInfo.name).toBe('+Fable');
    expect(H.ui.charInfo.gender).toBe('Female');
  });
});
