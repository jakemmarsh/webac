/**
 * SWEEP1006B.message-reactions.login-our-own-createobject-resets
 *
 * Retail SmartBox::HandleCreateObject @ 00454c80 (own-player branch, decomp
 * :87922) never writes vitals; the bars show the PlayerDescription's current
 * values. Drive the PD vitals into a real PlayerState, then the own-player
 * first-spawn step, and assert the hurt/tired/drained values survive.
 */
import { describe, it, expect } from 'vitest';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { applyOwnFirstSpawn } from '../packages/renderer/src/player/ownFirstSpawn.js';
import { VitalId } from '@ac/shared';

function playerAfterPlayerDescription(): PlayerState {
  const ps = new PlayerState();
  ps.initFromCreation({
    name: '', heritage: 1, gender: 1,
    attributes: { strength: 100, endurance: 100, coordination: 100, quickness: 10, focus: 10, self: 100 },
    skills: [],
  } as never);
  // The PD handler's setCurrent calls with below-max values.
  ps.vitals.setCurrent(VitalId.Health, 7, ps.attributes);
  ps.vitals.setCurrent(VitalId.Stamina, 3, ps.attributes);
  ps.vitals.setCurrent(VitalId.Mana, 1, ps.attributes);
  return ps;
}

describe('own-player first-spawn CreateObject keeps PlayerDescription vitals', () => {
  it('does not reset current vitals to max', () => {
    const ps = playerAfterPlayerDescription();
    expect(ps.health.current).toBeLessThan(ps.health.max);
    applyOwnFirstSpawn(ps, '+TestChar');
    expect(ps.health.current).toBe(7);
    expect(ps.stamina.current).toBe(3);
    expect(ps.mana.current).toBe(1);
  });

  it('records the character name from the CreateObject', () => {
    const ps = playerAfterPlayerDescription();
    applyOwnFirstSpawn(ps, '+TestChar');
    expect(ps.name).toBe('+TestChar');
  });
});
