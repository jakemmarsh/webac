/**
 * RECON.death-flow-behavioral-tests — death → lifestone → revive, driven
 * through the real PlayerState (the vital path PrivateUpdateVital takes in
 * main.ts) and the edge checkPlayerDeath acts on
 * (player/deathTransition.ts).
 *
 * ACE Player_Death.cs: Health 0 on death (PlayerKilled +
 * VictimNotification); the server teleports the player to the lifestone
 * and restores the vitals, the client only follows Health.
 */
import { describe, it, expect } from 'vitest';
import { VitalId } from '@ac/shared';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { deathTransition } from '../packages/renderer/src/player/deathTransition.js';

describe('death → revive follows the server Health (deathTransition + PlayerState)', () => {
  it('alive → 0 Health is "died" once; the restored Health is "revived" once; no edge otherwise', () => {
    const ps = new PlayerState();
    let dead = false;
    const step = (health: number): string | null => {
      ps.vitals.setCurrent(VitalId.Health, health, ps.attributes);
      const t = deathTransition(dead, ps.isDead);
      if (t === 'died') dead = true;
      if (t === 'revived') dead = false;
      return t;
    };
    expect(step(40)).toBeNull();
    expect(step(12)).toBeNull();
    expect(step(0)).toBe('died');
    expect(step(0)).toBeNull();          // still dead: no second "died"
    expect(step(30)).toBe('revived');    // the server's restored vitals at the lifestone
    expect(step(30)).toBeNull();
  });

  it('the pure edge', () => {
    expect(deathTransition(false, true)).toBe('died');
    expect(deathTransition(true, false)).toBe('revived');
    expect(deathTransition(true, true)).toBeNull();
    expect(deathTransition(false, false)).toBeNull();
  });
});

describe('a denied corpse loot (ACE Corpse.Open without HasPermission)', () => {
  it('ACE sends only a TransientString (no ViewContents, so no panel opens); it lands on the 0x1a spew strip verbatim', async () => {
    const { transientStringLine } = await import('../packages/renderer/src/ui/ServerMessageText.js');
    // Corpse.cs:126-135 — the three refusals.
    for (const text of [
      'You do not yet have the right to loot the Corpse of Drudge Skulker.',
      'You may not loot the Corpse of Bob because the death was caused by a player killer.',
      'You may not loot the Corpse of Drudge because the Corpse of Drudge has generated a rare item.',
    ]) {
      expect(transientStringLine(text)).toEqual({ text, type: 0x1a });
    }
  });
});
