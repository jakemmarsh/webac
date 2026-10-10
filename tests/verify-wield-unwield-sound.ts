/**
 * FAITHFUL.419 → BUG.duplicate-local-sounds (2026-09-28) — wield / unwield
 * play NO local chime.
 *
 * FAITHFUL.419 played Sound.WieldObject on every WieldObject event and
 * Sound.UnwieldObject on a Wielder=0 broadcast. ACE already sends both as a
 * Sound message on the player — Player_Inventory.cs:306 (wield), :405
 * (unwield), :1831 (wield from the ground), Creature_Equipment.cs:360 / :436 —
 * which onSound plays from our own table at our position, so the local copy
 * doubled every one. The retail client plays neither by itself
 * (audio/RetailLocalSounds).
 */
import { describe, it, expect } from 'vitest';
import { Sound } from '@ac/shared';
import { applyServerWieldObject } from '../packages/renderer/src/inventory/ServerWieldObject.js';
import { isRetailClientLocalSound } from '../packages/renderer/src/audio/RetailLocalSounds.js';

describe('onWieldObject: equip, no chime (BUG.duplicate-local-sounds)', () => {
  const run = (carried: boolean) => {
    const calls: string[] = [];
    const item = { id: 0x80000400 };
    const deps = {
      respond: () => true,
      containIn: () => null,
      playerId: 0x50000001,
      getItem: (guid: number) => (carried && guid === item.id ? item : undefined),
      addItem: () => { calls.push('add'); },
      removeWorldObject: () => { calls.push('remove'); },
      equip: (it: { id: number }, location: number) => { calls.push(`equip:${it.id.toString(16)}@${location.toString(16)}`); },
      confirmEquip: () => { calls.push('confirm'); },
      markInventoryDirty: () => { calls.push('inventoryDirty'); },
    };
    const touched: string[] = [];
    const spy = new Proxy(deps, { get(t, p, r) { if (typeof p === 'string') touched.push(p); return Reflect.get(t, p, r); } });
    applyServerWieldObject(spy, 0x80000400, 0x20);
    return { calls, touched };
  };

  it('the server-confirmed wield equips, confirms and dirties the inventory — nothing else', () => {
    expect(run(true).calls).toEqual(['equip:80000400@20', 'confirm', 'inventoryDirty']);
    expect(run(false).calls).toEqual([]);
  });

  it('reaches for no sound dependency', () => {
    expect(run(true).touched.filter((k) => /sound|chime/i.test(k))).toEqual([]);
  });

  it('WieldObject / UnwieldObject are server sounds, not retail client-local ones', () => {
    expect(isRetailClientLocalSound(Sound.WieldObject)).toBe(false);
    expect(isRetailClientLocalSound(Sound.UnwieldObject)).toBe(false);
  });
});
