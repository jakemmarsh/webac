/**
 * FAITHFUL.468 — drop orphan target-bar helper chain.
 *
 *  Pre-fix GameUI defined:
 *    - private contextCallbacks: { onUse?, onExamine?, onAttack? } = {}
 *    - setContextCallbacks(callbacks)
 *    - useSelectedTarget()
 *    - examineSelectedTarget()
 *    - attackSelectedTarget()
 *
 *  But main.ts never called setContextCallbacks, so contextCallbacks
 *  stayed empty and every helper silently no-op'd. main.ts uses the
 *  direct sendAttackAction / sendIdentifyAction / sendUseAction paths
 *  from its own keybind (A=attack, E=examine) and dblclick (use)
 *  handlers — bypassing the helpers entirely.
 *
 *  Per FAITHFUL.437 drop-dead-code principle: removed. If a future
 *  target-bar UI ships, the helpers can be re-added then.
 *
 *  DEBT.test-harness-hygiene: converted from a GameUI.ts source pin to
 *  absence checks on the real class and a constructed instance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.468 — orphan helpers removed', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let proto: any;
  beforeAll(async () => {
    H = await mountGameUI();
    proto = H.mod.GameUI.prototype;
  });
  afterAll(() => H.teardown());

  it('contextCallbacks field is gone (not initialised on a constructed GameUI)', () => {
    expect('contextCallbacks' in H.ui).toBe(false);
  });

  it.each(['setContextCallbacks', 'useSelectedTarget', 'examineSelectedTarget', 'attackSelectedTarget'])(
    '%s is gone', (name) => {
      expect(proto[name]).toBeUndefined();
      expect(H.ui[name]).toBeUndefined();
    },
  );
});
