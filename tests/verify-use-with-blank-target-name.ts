/**
 * BUG.use-with-blank-target-name (every era) — Coldeve, 2026-11-24 ~22:05Z: an armed use-with
 * (a kit) pressed on an object outside the 3D world and the pack printed "Cannot use the <item>
 * with the " — consumePendingUseWithTarget took a caller-supplied name / ItemType and three
 * callers fell back to '' / 0 (an item cell of an open corpse or chest, a vendor's merchandise, a
 * trade partner's item, a fellow out of sight on the Fellowship panel).
 *
 * Retail ItemHolder::TargetCompatibleWithObject @ 00587520 looks both objects up first
 * (ClientObjMaintSystem::GetWeenieObject) and returns false with no line when either is
 * unknown. Ours now resolves the target from the one weenie the client keeps for it
 * (input/UseTargetObject.ts) and refuses an unknown one silently.
 */
import { describe, it, expect } from 'vitest';
import { ItemType, ObjectDescriptionFlag } from '../packages/shared/src/index.js';
import { resolveUseTarget, type UseTargetSources, type UseTargetRecord } from '../packages/renderer/src/input/UseTargetObject.js';
import { targetCompatibleWithObject } from '../packages/renderer/src/input/TargetCompatible.js';
import { OpenContainerTracker } from '../packages/renderer/src/world/OpenContainerTracker.js';
import { WorldObjectRecords } from '../packages/renderer/src/network/objectSubjectRouting.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';

const PLAYER = 0x50000001;
const CORPSE = 0x80001000;
const CORPSE_ITEM = 0x80001001;
const WORLD_DRUDGE = 0x80002000;
const VENDOR_ITEM = 0x80003000;
const TRADE_ITEM = 0x80004000;
const PACK_ITEM = 0x80005000;
const UNKNOWN = 0x80009999;

const ERAS = ['eor', 'classicace-customdm', 'classic-dereth', 'ac1999-retail'] as const;
const textOf = (id: string) => eraClientRules(eraProfile(id)).useWithTargetText;

// A healing kit: source contained (8); target remote | self (0x20 | 0x2 << 16); creatures only.
const healingKit = { name: 'Healing Kit', useability: ((0x20 | 0x2) << 16) | 0x8, targetType: ItemType.Creature, ownedByPlayer: true };

function sources(): { s: UseTargetSources; open: OpenContainerTracker; records: WorldObjectRecords } {
  const open = new OpenContainerTracker();
  open.viewContents(CORPSE, [{ guid: CORPSE_ITEM, containerType: 0 }]);
  open.trackCreateObject({ guid: CORPSE_ITEM, containerId: CORPSE, name: 'Pyreal Mace', iconDid: 0x06001234, stackSize: 1, itemType: ItemType.MeleeWeapon });
  const records = new WorldObjectRecords();
  const world = new Map<number, UseTargetRecord>([
    [WORLD_DRUDGE, { name: 'Drudge Skulker', itemType: ItemType.Creature, objectDescFlags: ObjectDescriptionFlag.Attackable }],
  ]);
  const held = new Map<number, UseTargetRecord>([[PACK_ITEM, { name: 'Pyreal', pluralName: 'Pyreals', stackSize: 25, itemType: ItemType.Money }]]);
  const vendor = new Map<number, UseTargetRecord>([[VENDOR_ITEM, { name: 'Leather Boots', itemType: ItemType.Armor }]]);
  const trade = new Map<number, UseTargetRecord>([[TRADE_ITEM, { name: 'Iron Shield', itemType: ItemType.Armor }]]);
  const s: UseTargetSources = {
    playerGuid: PLAYER, playerName: 'Claude Bulwark',
    held: (g) => held.get(g),
    others: [
      (g) => world.get(g),
      (g) => records.sourceOf(g) as UseTargetRecord | null,
      (g) => open.items().find((i) => i.guid >>> 0 === g),
      (g) => trade.get(g),
      (g) => vendor.get(g),
    ],
  };
  return { s, open, records };
}

describe('BUG.use-with-blank-target-name — resolveUseTarget (GetWeenieObject for a use-with target)', () => {
  it('knows every kind of object the client keeps, each with its own name and ItemType', () => {
    const { s } = sources();
    expect(resolveUseTarget(PLAYER, s)).toMatchObject({ name: 'Claude Bulwark', itemType: ItemType.Creature, ownedByPlayer: true, isPlayer: true });
    expect(resolveUseTarget(WORLD_DRUDGE, s)).toMatchObject({ name: 'Drudge Skulker', itemType: ItemType.Creature, ownedByPlayer: false, isPlayer: false });
    // The corpse's item lives with the open container, never in the ServerObjectManager.
    expect(resolveUseTarget(CORPSE_ITEM, s)).toMatchObject({ name: 'Pyreal Mace', itemType: ItemType.MeleeWeapon, ownedByPlayer: false });
    expect(resolveUseTarget(VENDOR_ITEM, s)).toMatchObject({ name: 'Leather Boots', itemType: ItemType.Armor, ownedByPlayer: false });
    expect(resolveUseTarget(TRADE_ITEM, s)).toMatchObject({ name: 'Iron Shield', ownedByPlayer: false });
    // GetObjectNameWide(…, NAME_APPROPRIATE): a stack reads as its plural.
    expect(resolveUseTarget(PACK_ITEM, s)).toMatchObject({ name: 'Pyreals', ownedByPlayer: true, stackSize: 25 });
  });

  it('an object the client does not know (or id 0) is null, never a blank name', () => {
    const { s } = sources();
    expect(resolveUseTarget(UNKNOWN, s)).toBeNull();
    expect(resolveUseTarget(0, s)).toBeNull();
  });

  it('an owned item is owned even when the 3D world also holds a copy (a wielded item)', () => {
    const { s } = sources();
    const both: UseTargetSources = { ...s, held: (g) => (g === WORLD_DRUDGE ? { name: 'Drudge Skulker', itemType: ItemType.Creature } : null) };
    expect(resolveUseTarget(WORLD_DRUDGE, both)?.ownedByPlayer).toBe(true);
  });

  it('a WorldObjectRecords record (a corpse item, flags kept) resolves with its bitfield', () => {
    const { s, records } = sources();
    const G = 0x80001002;
    records.remember(G, { guid: G, name: 'Mana Stone', stackSize: 1, itemType: ItemType.ManaStone, objectDescFlags: 0 } as never);
    expect(resolveUseTarget(G, s)).toMatchObject({ name: 'Mana Stone', itemType: ItemType.ManaStone, objectDescFlags: 0 });
  });
});

describe('BUG.use-with-blank-target-name — ItemHolder::TargetCompatibleWithObject on the resolved target (every era)', () => {
  for (const era of ERAS) {
    const T = textOf(era);
    it(`${era}: a kit pressed on a corpse's item names it (step 5), never "with the "`, () => {
      const { s } = sources();
      const r = targetCompatibleWithObject(healingKit, resolveUseTarget(CORPSE_ITEM, s), PLAYER, T);
      expect(r.ok).toBe(false);
      expect(r.line).toBe(T.cannotUseWith.replace('%s', 'Healing Kit').replace('%s', 'Pyreal Mace'));
      expect(r.line).not.toMatch(/with the $/);
    });
    it(`${era}: an unknown target is refused silently (no line), as retail's GetWeenieObject == 0`, () => {
      const { s } = sources();
      expect(targetCompatibleWithObject(healingKit, resolveUseTarget(UNKNOWN, s), PLAYER, T)).toEqual({ ok: false, line: null });
    });
    it(`${era}: a valid use still passes — the kit on a known creature and on yourself`, () => {
      const { s } = sources();
      const drudge = targetCompatibleWithObject(healingKit, resolveUseTarget(WORLD_DRUDGE, s), PLAYER, T);
      expect(drudge).toEqual({ ok: true, line: `${T.using.replace('%s', 'Healing Kit')}${T.usingWith}Drudge Skulker` });
      const self = targetCompatibleWithObject(healingKit, resolveUseTarget(PLAYER, s), PLAYER, T);
      expect(self).toEqual({ ok: true, line: `${T.using.replace('%s', 'Healing Kit')}${T.usingOn}Claude Bulwark` });
    });
  }

  it('the 1999 wording keeps its period on the ownership lines (EraFeatures)', () => {
    const { s } = sources();
    const stone = { name: 'Mana Stone', useability: (0x8 << 16) | 0x8, targetType: ItemType.Armor, ownedByPlayer: true };
    expect(targetCompatibleWithObject(stone, resolveUseTarget(VENDOR_ITEM, s), PLAYER, textOf('ac1999-retail')).line)
      .toBe("You can't use the Mana Stone on what you don't own.");
    expect(targetCompatibleWithObject(stone, resolveUseTarget(VENDOR_ITEM, s), PLAYER, textOf('eor')).line)
      .toBe("You can't use the Mana Stone on what you don't own");
  });
});
