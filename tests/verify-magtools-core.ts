/**
 * Mag-Tools' UI-free core (@ac/shared magtools/, rebuilt from docs/plugin-specs/magtools.md):
 * item info on identify, the mana tracker, the `/mt` commands, the options and the combat
 * tracker, read against our own client's combat chat (formatAttackerChat / formatDefenderChat,
 * the evade lines) and each server family's kill lines.
 */
import { describe, expect, it } from 'vitest';
import {
  MtCombatParser, MtCombatTracker, MtCommands, MtIdentWatcher, MtManaTracker, MtObjectClass, MtOptions,
  MT_KILL_TEMPLATES_ACE, MT_KILL_TEMPLATES_GDLE, MT_OPTIONS, mtBuffedFloat, mtBuffedInt, mtItemInfo, mtItemInfoLine,
  mtLootVerdict, mtPrintsItem, mtShortNumber, mtShowsSpell, mtSuppressesSalvage, mtElementOf, mtSecondsPerBurn,
  type MtCombatEvent, type MtHost, type MtItemData, type MtObject, type MtOptionStorage, type MtPlayerEnchantment, type MtWornItem,
} from '../packages/shared/src/index.ts';
import { AttackConditions, DamageLocation, DamageType, PropertyFloat as PF, PropertyInt as PI, formatAttackerChat, formatDefenderChat } from '../packages/shared/src/index.ts';
import { evasionAttackerLine, evasionDefenderLine } from '../packages/renderer/src/ui/ServerMessageText.ts';

const item = (o: Partial<MtItemData> & Pick<MtItemData, 'name' | 'objectClass'>): MtItemData => ({ id: 1, int: {}, float: {}, spells: [], ...o });
const ON = { showBuffedValues: true, showValueAndBurden: true };

describe('item info on identify (spec §8)', () => {
  it('a loot two-hander: every weapon fragment in order, the spell filter and the tinked DoT', () => {
    const a = item({
      name: 'Spadone', objectClass: MtObjectClass.MeleeWeapon,
      int: { [PI.MaterialType]: 64, [PI.WeaponType]: 11, [PI.EquipmentSetId]: 13, [PI.ImbuedEffect]: 1 | 8, [PI.NumTimesTinkered]: 3,
        [PI.Damage]: 50, [PI.WieldRequirements]: 7, [PI.WieldSkillType]: 1, [PI.WieldDifficulty]: 150,
        [PI.ItemSkillLevelLimit]: 300, [PI.AppraisalItemSkill]: 41, [PI.ItemWorkmanship]: 8 },
      float: { [PF.DamageVariance]: 0.4, [PF.WeaponOffense]: 1.12, [PF.WeaponDefense]: 1.08, [PF.WeaponMagicDefense]: 1.055 },
      spells: [
        { id: 6089, name: 'Legendary Blood Thirst', family: 999, difficulty: 450 },
        { id: 4666, name: 'Epic Heart Thirst', family: 998, difficulty: 400 },
        { id: 4413, name: 'Incantation of Swift Killer', family: 158, difficulty: 400 },
        { id: 2604, name: 'Minor Impenetrability', family: 997, difficulty: 100 },
        { id: 1615, name: 'Blood Drinker V', family: 154, difficulty: 250 },
        { id: 1300, name: 'Strength Other VI', family: 1, difficulty: 300 },
        { id: 1111, name: 'Blade Bane VI', family: 37, difficulty: 300 },
      ],
    });
    // Buffed max 50 + 10 (Legendary Blood Thirst); 7 tinks left (imbued): 2 iron then 5 granite → DoT(86, 0.131) = 89.5.
    expect(mtItemInfo(a, ON)).toBe(
      'Steel Spadone (Two Handed Combat), Soldier\'s Set, CS SlashRend, Tinks 3, 30.00-50, +12%a, 8%md, 5.5%mgc.d, '
      + '(89.5/60 19.0/8.0), Legendary Blood Thirst, Epic Heart Thirst, Incantation of Swift Killer, Minor Impenetrability, '
      + 'Wield Lvl 150, Two Handed Combat 300 to Activate, Craft 8');
    expect(mtItemInfo(a, { showBuffedValues: false, showValueAndBurden: false })).not.toContain('(89.5');
  });

  it('a non-loot sword: active buffs stripped, its own cantrip added; all spells shown; value, burden and ratings', () => {
    const b = item({
      name: 'Shining Sword', objectClass: MtObjectClass.MeleeWeapon,
      int: { [PI.WeaponType]: 2, [PI.Damage]: 54, [PI.WieldRequirements]: 2, [PI.WieldSkillType]: 45, [PI.WieldDifficulty]: 250,
        [PI.ItemDifficulty]: 200, [PI.ItemWorkmanship]: 5, [PI.Value]: 5000, [PI.EncumbranceVal]: 300, [PI.GearDamage]: 2, [PI.GearCritDamage]: 1 },
      float: { [PF.DamageVariance]: 0.4 },
      spells: [{ id: 1616, name: 'Blood Drinker VI', family: 154, difficulty: 300 }, { id: 2586, name: 'Major Blood Thirst', family: 999, difficulty: 300 }],
      activeSpellIds: [1616, 2586],
    });
    expect(mtBuffedInt(b, PI.Damage)).toBe(34);
    // No material: no tinks; DoT(34 + 24, 0.4) = 58 × 0.92 = 53.36.
    expect(mtItemInfo(b, ON)).toBe('Shining Sword (Sword), 32.40-54, (53.4/34 ), Major Blood Thirst, Blood Drinker VI, '
      + 'Light Weapons 250, Diff 200, Craft 5, Value 5,000, BU 300, [D 2, CD 1]');
  });

  it('armour, salvage, keyrings, casters and bows', () => {
    const coat = item({
      name: 'Amuli Coat', objectClass: MtObjectClass.Armor,
      int: { [PI.MaterialType]: 52, [PI.EquipmentSetId]: 999, [PI.ArmorLevel]: 300, [PI.ImbuedEffect]: 0x20000000, [PI.ResistMagic]: 9999,
        [PI.UseRequiresLevel]: 100, [PI.UseRequiresSkill]: 6, [PI.UseRequiresSkillLevel]: 200, [PI.UseRequiresSkillSpec]: 17 },
      float: { [PF.ArmorModVsSlash]: 1.2, [PF.ArmorModVsPierce]: 1, [PF.ArmorModVsBludgeon]: 0.8, [PF.ArmorModVsCold]: 0.5,
        [PF.ArmorModVsFire]: 0.5, [PF.ArmorModVsAcid]: 0.4, [PF.ArmorModVsElectric]: 1.6 },
      spells: [{ id: 1111, name: 'Blade Bane VI', family: 37, difficulty: 300 }, { id: 2108, name: "Brogard's Defiance", family: 31, difficulty: 300 }],
    });
    expect(mtItemInfo(coat, ON)).toBe("Leather Amuli Coat, Unknown set 999, AL 300, MagicAbsorb, Brogard's Defiance, Blade Bane VI, "
      + 'Lvl 100, Melee Defense 200, Unknown skill spec: 17 200, [1.2/1.0/0.8/0.5/0.5/0.4/1.6]');
    // The same banes on an enchantable item are hidden.
    expect(mtShowsSpell({ ...coat, int: { ...coat.int, [PI.ResistMagic]: 0 } }, coat.spells[0]!)).toBe(false);

    const salvage = item({ name: 'Salvage', objectClass: MtObjectClass.Salvage, int: { [PI.MaterialType]: 61, [PI.ItemWorkmanship]: 37, [PI.NumItemsInMaterial]: 5 } });
    expect(mtItemInfo(salvage, ON)).toBe('Iron Salvage, Work 7.40');
    const ring = item({ name: 'Burning Sands Keyring', objectClass: MtObjectClass.Misc, int: { [PI.NumKeys]: 3, [PI.Structure]: 22 } });
    expect(mtItemInfo(ring, ON)).toBe('Burning Sands Keyring, Keys: 3, Uses: 22');
    const gem = item({ name: 'Odd Thing', objectClass: MtObjectClass.Misc, int: { [PI.MaterialType]: 9, [PI.WeaponType]: 12 } });
    expect(mtItemInfo(gem, ON)).toBe('unknown material 9 Odd Thing (Unknown mastery 12)');

    const wand = item({
      name: 'Wand', objectClass: MtObjectClass.WandStaffOrb,
      float: { [PF.ElementalDamageMod]: 1.15, [PF.ManaConversionMod]: 0.05, [PF.WeaponDefense]: 1.05 },
      spells: [{ id: 3250, name: 'Major Spirit Thirst', family: 999, difficulty: 300 }], activeSpellIds: [3250],
    });
    expect(mtItemInfo(wand, ON)).toBe('Wand, +15%vs. Monsters, 5%md, 5%mc, (15.0 5.0/5), Major Spirit Thirst');
    // A multiplier: Hermetic Link active on the item divides back out.
    expect(mtBuffedFloat(item({ name: 'Orb', objectClass: 31, float: { [PF.ManaConversionMod]: 0.06 }, activeSpellIds: [3200] }), PF.ManaConversionMod)).toBeCloseTo(0.05, 10);

    const bow = item({ name: 'Yumi', objectClass: MtObjectClass.MissileWeapon, int: { [PI.WeaponType]: 8, [PI.ElementalDamageBonus]: 10 }, float: { [PF.DamageMod]: 1.9 } });
    expect(mtItemInfo(bow, ON)).toBe('Yumi (Bow), +10, +90%, (40.0 )');
  });

  it('the loot-rule prefix through an injected matcher, and which lines print', () => {
    const it1 = item({ id: 77, name: 'Yumi', objectClass: MtObjectClass.MissileWeapon });
    const opts = { showBuffedValues: false, showValueAndBurden: false };
    expect(mtItemInfoLine(it1, opts, null)).toEqual({ itemId: 77, prefix: '', info: 'Yumi', text: 'Yumi' });
    const keep = mtLootVerdict({ action: 'keep', label: 'Bows', match: {} });
    expect(mtItemInfoLine(it1, opts, () => keep).text).toBe('+(Bows) Yumi');
    expect(mtItemInfoLine(it1, opts, () => mtLootVerdict(null)).text).toBe('- Yumi');
    expect(mtItemInfoLine(it1, opts, () => mtLootVerdict({ action: 'ignore', label: 'Junk', match: {} })).text).toBe('-(Junk) Yumi');
    const salv = mtLootVerdict({ action: 'salvage', match: {} });
    expect(salv).toEqual({ looted: true, rule: 'salvage', salvage: true });
    expect(mtPrintsItem(null, { containerScan: false })).toBe(true);
    expect(mtPrintsItem(mtLootVerdict(null), { containerScan: true })).toBe(false);
    expect(mtPrintsItem(salv, { containerScan: true, suppressSalvage: mtSuppressesSalvage('Large Chest') })).toBe(false);
    expect(mtPrintsItem(salv, { containerScan: true, suppressSalvage: mtSuppressesSalvage('Corpse of Drudge') })).toBe(true);
  });

  it('prints an appraisal only for a recent selection, never for portals or NPCs; left-click ident within 1 s', () => {
    const w = new MtIdentWatcher();
    expect(w.appraised(5, MtObjectClass.MeleeWeapon, 0)).toBe(false);
    w.leftClick(1000);
    expect(w.select(5, 1500, true)).toBe(true);
    expect(w.select(6, 3000, true)).toBe(false);
    expect(w.appraised(5, MtObjectClass.MeleeWeapon, 9000)).toBe(true);
    expect(w.appraised(5, MtObjectClass.MeleeWeapon, 9100)).toBe(false);
    w.select(7, 0, false);
    expect(w.appraised(7, MtObjectClass.Portal, 100)).toBe(false);
    w.select(8, 0, false);
    expect(w.appraised(8, MtObjectClass.Armor, 10_001)).toBe(false);
  });
});

describe('mana tracker (spec §5.1)', () => {
  const T0 = 1_000_000;
  const base = (o: Partial<MtWornItem>): MtWornItem => ({
    id: 0, name: '', validLocations: 1, wieldedLocation: 1, appraised: true, spells: [], curMana: 0, maxMana: 0, manaRate: 0,
    retained: false, enchantments: [], manaUpdatedAt: T0, ...o,
  });
  const worn: MtWornItem[] = [
    base({ id: 1, name: 'Gold Ring', spells: [{ id: 100, name: 'Minor Focus', family: 10, difficulty: 300 }], enchantments: [{ family: 10, difficulty: 300 }],
      curMana: 100, maxMana: 200, manaRate: -0.05, retained: true }),
    base({ id: 2, name: 'Silver Bracelet', spells: [{ id: 101, name: 'Minor Self', family: 11, difficulty: 300 }], curMana: 50, maxMana: 100, manaRate: -0.05 }),
    base({ id: 3, name: 'Robe', appraised: false }),
    base({ id: 4, name: 'Amulet', spells: [{ id: 102, name: 'Major Willpower', family: 12, difficulty: 350 }], curMana: 30, maxMana: 30, manaRate: 0, retained: true }),
    base({ id: 5, name: 'Cloak', validLocations: 0x08000000 }),
    base({ id: 6, name: 'Coalesced Aetheria', spells: [{ id: 103, name: 'Surge', family: 13, difficulty: 1 }], enchantments: [{ family: 13, difficulty: 1 }],
      curMana: 10, maxMana: 10, manaRate: -0.01, retained: true }),
    base({ id: 7, name: 'Pack Ring', wieldedLocation: 0, curMana: 1, maxMana: 500 }),
  ];
  const player: MtPlayerEnchantment[] = [{ family: 12, difficulty: 400, timeRemaining: -1 }, { family: 11, difficulty: 400, timeRemaining: 300 }];
  const t = new MtManaTracker({ worn: () => worn, playerEnchantments: () => player, now: () => T0 + 200_000 });

  it('rows: state, mana, time; sorted by time left; hidden rows flagged', () => {
    expect(mtSecondsPerBurn(worn[0]!)).toBe(20);
    const rows = t.rows();
    expect(rows.map((r) => [r.id, r.state, r.mana, r.time, r.hidden])).toEqual([
      [2, 'NotActive', '50 / 100', '0h00m', false],
      [6, 'Active', '8 / 10', '0h13m', true],
      [1, 'Active', '90 / 200', '0h30m', false],
      [4, 'Active', '30 / 30', '', false],
      [3, 'Unknown', '-', '-', false],
      [5, 'NotActivatable', '-', '-', true],
    ]);
    expect(rows.find((r) => r.id === 1)!.stateIcon).toBe(0x060011f9);
    expect(rows.find((r) => r.id === 3)!.stateIcon).toBe(0x060020b5);
  });

  it('footer and HUD texts; re-appraisal triggers from chat', () => {
    expect(t.manaNeededText()).toBe('Mana needed: 162');
    expect(t.unretainedText()).toBe('Unretained Items: 2');
    expect(t.hudText()).toBe('*0h13m');
    expect(t.reappraiseFor('Your Gold Ring is low on Mana.')).toEqual([1]);
    expect(t.reappraiseFor('The Mana Stone gives 4,000 points of mana to the following items: Silver Bracelet, Amulet')).toEqual([2, 4]);
    expect(t.reappraiseFor('You say, "Your Gold Ring is low on Mana."')).toEqual([]);
    expect(t.reappraiseFor('Bob says, "Your Gold Ring is low on Mana."')).toEqual([]);
  });
});

describe('options (spec §3, §4)', () => {
  class Mem implements MtOptionStorage { m = new Map<string, string>(); get(k: string) { return this.m.get(k); } set(k: string, v: string) { this.m.set(k, v); } }

  it('labels, defaults and tabs; dead Windows-only options are neither listed nor settable', () => {
    const o = new MtOptions(new Mem());
    expect(MT_OPTIONS.length).toBe(70);
    const live = o.list();
    expect(live.length).toBe(66);
    expect(live[0]).toMatchObject({ path: 'ItemInfoOnIdent.Enabled', label: 'Show Item Info On Ident', default: true, tab: 'Misc/Options', scope: 'global' });
    expect(o.list('Misc/Filters').map((d) => d.label).slice(-3)).toEqual(["Status Text: You're too busy!", 'Status Text: Casting ...', 'Status Text: All']);
    expect(o.def('Misc.MaxFPS')).toBeNull();
    expect(o.def('Misc.MaximizeChatOnLogin')).toBeNull();
    expect(o.get('CorpseTracker.TrackPermittedCorpses')).toBe(true);
    expect(o.get('Misc.OutputTargetWindow')).toBe(1);
  });

  it('a child switched on turns its parent on; text parses as bool.TryParse / int.TryParse', () => {
    const mem = new Mem();
    const o = new MtOptions(mem);
    o.set('ItemInfoOnIdent.Enabled', false);
    o.set('ItemInfoOnIdent.LeftClickIdent', true);
    expect(o.bool('ItemInfoOnIdent.Enabled')).toBe(true);
    o.set('ItemInfoOnIdent.LeftClickIdent', false);
    expect(o.bool('ItemInfoOnIdent.Enabled')).toBe(true);
    expect(mem.m.get('ItemInfoOnIdent.LeftClickIdent')).toBe('False');
    expect(o.setText('misc.outputtargetwindow', '3')).toBe(true);
    expect(o.int('Misc.OutputTargetWindow')).toBe(3);
    expect(o.setText('Misc.OutputTargetWindow', 'three')).toBe(false);
    expect(o.setText('Filters.SpellExpires', 'TRUE')).toBe(true);
    expect(o.text('Filters.SpellExpires')).toBe('True');
  });
});

describe('/mt commands (spec §10)', () => {
  class Mem implements MtOptionStorage { m = new Map<string, string>(); get(k: string) { return this.m.get(k); } set(k: string, v: string) { this.m.set(k, v); } }
  function rig(vendorOpen = false) {
    const calls: string[] = [];
    const inv: MtObject[] = [
      { id: 10, name: 'Healing Kit', kind: 'item' }, { id: 11, name: 'Bronze Sword', kind: 'item', equipped: true },
      { id: 12, name: 'Bronze Sword', kind: 'item' }, { id: 13, name: 'Mana Stone', kind: 'item' },
    ];
    const land: MtObject[] = [
      { id: 20, name: 'Drudge Skulker', kind: 'monster' }, { id: 21, name: 'Town Crier', kind: 'npc' },
      { id: 22, name: 'Shopkeeper Uenji', kind: 'vendor' }, { id: 23, name: 'Portal to Holtburg', kind: 'portal' },
      { id: 24, name: 'Healing Kit', kind: 'item' }, { id: 25, name: 'Bob', kind: 'player' },
    ];
    const host: MtHost = {
      inventory: () => inv,
      openContainer: () => ({ id: 30, name: 'Chest', items: [{ id: 31, name: 'Pyreal Mote', kind: 'item' }] }),
      landscape: () => land,
      spells: () => [{ id: 1, name: 'Strength Other I' }, { id: 2, name: 'Strength Self I' }],
      select: (id) => calls.push(`select ${id}`),
      use: (id) => calls.push(`use ${id}`),
      useOn: (a, b) => calls.push(`useOn ${a} ${b}`),
      give: (a, b) => calls.push(`give ${a} ${b}`),
      drop: (id) => calls.push(`drop ${id}`),
      cast: (s, t) => calls.push(`cast ${s} ${t}`),
      combatState: (s) => calls.push(`combat ${s}`),
      face: (d) => calls.push(`face ${d}`),
      logout: () => calls.push('logout'),
      clickDialog: (b) => { calls.push(`click ${b}`); return true; },
      fellowship: (a: string, x?: string | number) => calls.push(`fellow ${a}${x !== undefined ? ` ${x}` : ''}`),
      trade: (a: string, x?: number) => calls.push(`trade ${a}${x !== undefined ? ` ${x}` : ''}`),
      vendor: () => (vendorOpen ? { items: [{ id: 40, name: 'Plate Armor' }, { id: 41, name: 'Iron Helm' }] } : null),
      vendorAddBuy: (id, n) => calls.push(`addbuy ${id} ${n}`),
      vendorAddSell: (id) => calls.push(`addsell ${id}`),
      vendorAction: (a) => calls.push(`vendor ${a}`),
    };
    const mt = new MtCommands(host, new MtOptions(new Mem()));
    return { mt, calls };
  }

  it('finds by exact name (inventory, container, landscape), partial only for …p, and dispatches', () => {
    const { mt, calls } = rig();
    expect(mt.command('hello')).toBeNull();
    expect(mt.command('/mt test')).toEqual([]);
    expect(mt.command('/MT select healing kit')).toEqual([]);
    expect(mt.command('/mt select Pyreal Mote')).toEqual([]);
    expect(mt.command('/mt select Drudge')).toBeNull();
    expect(mt.command('/mt selectp Drudge')).toEqual([]);
    expect(mt.command('/mt usel healing kit')).toEqual([]);
    expect(mt.command('/mt use closestvendor')).toEqual([]);
    expect(mt.command('/mt use closestportal')).toEqual([]);
    expect(mt.command('/mt use Healing Kit on Bob')).toEqual([]);
    expect(mt.command('/mt usel Healing Kit on Bob')).toEqual([]);
    expect(mt.command('/mt equip Bronze Sword')).toEqual([]);
    expect(mt.command('/mt dequipp bronze')).toEqual([]);
    expect(mt.command('/mt givep mana to bob')).toEqual([]);
    expect(mt.command('/mt give Mana Stone to Nobody')).toBeNull();
    expect(mt.command('/mt loot Pyreal Mote')).toEqual([]);
    expect(mt.command('/mt drop Healing Kit')).toEqual([]);
    expect(calls).toEqual(['select 10', 'select 31', 'select 20', 'use 24', 'use 22', 'use 23', 'useOn 10 25', 'useOn 24 25',
      'use 12', 'use 11', 'give 13 25', 'use 31', 'drop 10']);
  });

  it('cast, combat state, face, logout, dialogs, fellowship and trade', () => {
    const { mt, calls } = rig();
    expect(mt.command('/mt cast 2')).toEqual([]);
    expect(mt.command('/mt cast Strength Other I on Bob')).toEqual([]);
    expect(mt.command('/mt castp self')).toEqual([]);
    expect(mt.command('/mt cast Unknown Spell')).toBeNull();
    expect(mt.command('/mt combatstate Melee')).toEqual([]);
    expect(mt.command('/mt combatstate sword')).toBeNull();
    expect(mt.command('/mt face 90')).toEqual([]);
    expect(mt.command('/mt logoff')).toEqual([]);
    expect(mt.command('/mt click yes')).toEqual([]);
    expect(mt.command('/mt click 100 200')).toBeNull();
    // Spec §12 #3: the fellowship name keeps its case.
    expect(mt.command('/mt fellow create The Hunting Party')).toEqual([]);
    expect(mt.command('/mt fellow recruit Bob')).toEqual([]);
    expect(mt.command('/mt fellow disband')).toEqual([]);
    expect(mt.command('/mt trade addp heal')).toEqual([]);
    expect(mt.command('/mt trade accept')).toEqual([]);
    expect(mt.command('/mt send enter')).toBeNull();
    expect(mt.command('/mt quit')).toBeNull();
    expect(calls).toEqual(['cast 2 null', 'cast 1 25', 'cast 2 null', 'combat melee', 'face 90', 'logout', 'click yes',
      'fellow create The Hunting Party', 'fellow recruit 25', 'fellow disband', 'trade add 10', 'trade accept']);
  });

  it('vendor commands only while a vendor is open', () => {
    expect(rig(false).mt.command('/mt vendor buy')).toBeNull();
    const { mt, calls } = rig(true);
    expect(mt.command('/mt vendor addbuy Iron Helm 3')).toEqual([]);
    expect(mt.command('/mt vendor addbuyp plate')).toEqual([]);
    expect(mt.command('/mt vendor addsell Mana Stone')).toEqual([]);
    expect(mt.command('/mt vendor sell')).toEqual([]);
    expect(calls).toEqual(['addbuy 41 3', 'addbuy 40 1', 'addsell 13', 'vendor sell']);
  });

  it('/mt opt prints <Group>.<Field> (spec §12 #1 fixed) and remembers for the session', () => {
    const { mt } = rig();
    expect(mt.command('/mt opt get inventorymanagement.keyringer')).toEqual(['<{Mag-Tools}>: InventoryManagement.KeyRinger = False']);
    expect(mt.command('/mt opt remember InventoryManagement.KeyRinger')).toEqual(['<{Mag-Tools}>: Remembered InventoryManagement.KeyRinger = False']);
    expect(mt.command('/mt opt set InventoryManagement.KeyRinger true')).toEqual(['<{Mag-Tools}>: Set InventoryManagement.KeyRinger = True']);
    expect(mt.command('/mt opt set InventoryManagement.KeyRinger maybe')).toEqual(['<{Mag-Tools}>: Failed to Set InventoryManagement.KeyRinger to maybe']);
    expect(mt.command('/mt opt restore InventoryManagement.KeyRinger')).toEqual(['<{Mag-Tools}>: Restored InventoryManagement.KeyRinger = False']);
    expect(mt.command('/mt opt restore Filters.CompUsage')).toEqual(['<{Mag-Tools}>: Failed to Restore Filters.CompUsage']);
    expect(mt.command('/mt opt get Nope.Nothing')).toBeNull();
    const list = mt.command('/mt opt list')!;
    expect(list.length).toBe(66);
    expect(list[0]).toBe('<{Mag-Tools}>: ItemInfoOnIdent.Enabled True');
    expect(list).toContain('<{Mag-Tools}>: Misc.OutputTargetWindow 1');
  });
});

describe('combat tracker (spec §5.2) on our client\'s own combat lines', () => {
  const ME = 'Hero';
  const parser = new MtCombatParser({ me: () => ME });

  it('reads every hit line our client formats (the same in every era: the client formats them)', () => {
    const given = formatAttackerChat('Drudge Skulker', DamageType.Slash, 0.3, 20, false);
    expect(parser.parse(given)).toMatchObject({ source: ME, target: 'Drudge Skulker', attackType: 'MeleeMissile', element: 'Slash', damage: 20, crit: false });
    // Our attacker crit prefix has Mag-Tools' two spaces; Sneak Attack and Recklessness are read too.
    const crit = formatAttackerChat('Drudge Skulker', DamageType.Pierce, 0.6, 50, true, AttackConditions.SneakAttack | AttackConditions.Recklessness);
    expect(crit.startsWith('Critical hit!  Sneak Attack! Recklessness! ')).toBe(true);
    expect(parser.parse(crit)).toMatchObject({ element: 'Pierce', damage: 50, crit: true });
    // Difference from Mag-Tools: our defender line says "Reckless! " (retail) where Mag-Tools expects only Overpower!.
    const recv = formatDefenderChat('Drudge Skulker', DamageType.Bludgeon, 0.05, 7, DamageLocation.Head, false, AttackConditions.Recklessness);
    expect(recv).toBe('Reckless! Drudge Skulker grazes your head for 7 points of bludgeoning damage!');
    expect(parser.parse(recv)).toMatchObject({ source: 'Drudge Skulker', target: ME, element: 'Bludge', damage: 7 });
    // No body part: "… you for …"; one point: "point".
    expect(parser.parse(formatDefenderChat('Fire Golem', DamageType.Cold, 0.9, 1, 99, true))).toMatchObject({ source: 'Fire Golem', element: 'Cold', damage: 1, crit: true });
    const all: Array<[number, string]> = [[DamageType.Slash, 'Slash'], [DamageType.Pierce, 'Pierce'], [DamageType.Bludgeon, 'Bludge'], [DamageType.Fire, 'Fire'],
      [DamageType.Cold, 'Cold'], [DamageType.Acid, 'Acid'], [DamageType.Electric, 'Electric'], [DamageType.Nether, 'Typeless'], [DamageType.Health, 'Typeless']];
    for (const [dt, el] of all) {
      for (const sev of [0.05, 0.2, 0.4, 0.8]) {
        expect((parser.parse(formatAttackerChat('Mosswart', dt, sev, 12, false)) as { element: string }).element).toBe(el);
        expect((parser.parse(formatDefenderChat('Mosswart', dt, sev, 12, DamageLocation.Foot, false)) as { element: string }).element).toBe(el);
      }
    }
    expect(parser.parse(evasionAttackerLine('Drudge Skulker').text)).toMatchObject({ source: ME, target: 'Drudge Skulker', failed: true });
    expect(parser.parse(evasionDefenderLine('Drudge Skulker').text)).toMatchObject({ source: 'Drudge Skulker', target: ME, failed: true });
  });

  it('reads the servers\' magic, resist and kill lines: ACE (end of retail, ClassicACE) and GDLE (GDL-Classic, AC1999)', () => {
    expect(parser.parse('Critical hit! Overpower! You chill Drudge Skulker for 30 points with Frost Bolt II.')).toMatchObject({ attackType: 'Magic', element: 'Cold', damage: 30, crit: true });
    expect(parser.parse('Sneak Attack! You chill Drudge Skulker for 30 points with Frost Bolt II.')).toMatchObject({ source: ME, attackType: 'Magic', element: 'Cold' });
    expect(parser.parse('Killer Phyntos Soldier sears you for 46 points with Incantation of Acid Stream.')).toMatchObject({ source: 'Killer Phyntos Soldier', element: 'Acid', attackType: 'Magic' });
    expect(parser.parse('You resist the spell cast by Drudge Skulker')).toMatchObject({ source: 'Drudge Skulker', attackType: 'Magic', failed: true });
    expect(parser.parse('Drudge Skulker resists your spell')).toMatchObject({ source: ME, failed: true });
    for (const t of MT_KILL_TEMPLATES_ACE) expect(parser.parse(t.replace('{0}', 'Mosswart Elder')), t).toMatchObject({ source: ME, target: 'Mosswart Elder', killingBlow: true });
    for (const t of MT_KILL_TEMPLATES_GDLE) expect(parser.parse(t.replace('{0}', 'Mosswart Elder')), t).toMatchObject({ target: 'Mosswart Elder', killingBlow: true });
    // The two GDLE-only wordings.
    expect(MT_KILL_TEMPLATES_ACE).not.toContain("{0}'s body is shattered by your assault!");
    expect(MT_KILL_TEMPLATES_GDLE).toContain('You reduced {0} to cinders!');
    // Nothing involving someone else, and no speech.
    expect(parser.parse('Bob slashes Mosswart for 20 points of slashing damage!')).toBeNull();
    expect(parser.parse('Bob says, "You split Mosswart apart!"')).toBeNull();
    expect(mtElementOf(' grazes bludgeoning')).toBe('Bludge');
  });

  it('builds the monster list and the detail grid with their percentages; DPS over a window', () => {
    let now = 0;
    const tr = new MtCombatTracker(() => ME, () => now);
    const lines = [
      formatAttackerChat('Drudge Skulker', DamageType.Slash, 0.3, 20, false),
      formatAttackerChat('Drudge Skulker', DamageType.Pierce, 0.6, 50, true, AttackConditions.SneakAttack),
      evasionAttackerLine('Drudge Skulker').text,
      'You split Drudge Skulker apart!',
      formatDefenderChat('Drudge Skulker', DamageType.Bludgeon, 0.05, 7, DamageLocation.Head, false, AttackConditions.Recklessness),
      evasionDefenderLine('Drudge Skulker').text,
      'Drudge Skulker withers you for 12 points with Nether Bolt I.',
      'You resist the spell cast by Drudge Skulker',
      'You chill Drudge Skulker for 30 points with Frost Bolt II.',
      "Mosswart's body is shattered by your assault!",
      'You cast Gossamer Flesh on Mosswart',
      'Aetheria surges on Hero with the power of Surge of Destruction!',
      'Aetheria surges on Mosswart with the power of Surge of Affliction!',
      'Your cloak reduced the damage from 50 down to 25!',
    ];
    const events: MtCombatEvent[] = [];
    for (const l of lines) { now += 1000; const e = parser.parse(l); if (e) { events.push(e); tr.record(e); } }
    expect(events.length).toBe(13);
    expect(tr.monsterRows()).toEqual([
      ['', '', "KB's", 'Dmg Rcvd', 'Dmg Givn'],
      ['*', 'All', '2', '19', '100'],
      ['', 'Drudge Skulker', '1', '19', '100'],
      ['', 'Mosswart', '1', '', ''],
    ]);
    expect(tr.detailRows()).toEqual([
      ['', 'Mel/Msl', 'Magic', 'Attacks', '7 (86%)'],
      ['Typeless', '', '12', 'Evades', '2 (50%)'],
      ['Slash', '', '', 'Resists', '2 (50%)'],
      ['Pierce', '', '', 'A.Surges', '1 (14.3%)'],
      ['Bludge', '7', '', 'C.Surges', '1 (50.0%)'],
      ['Fire', '', '', '', ''],
      ['Cold', '', '', 'Av/Mx', '16 / 30'],
      ['Acid', '', '', 'Crits', '1 (25.0%)'],
      ['Electric', '', '', 'Av/Mx', '50 / 50'],
      ['', '', '', '', ''],
      ['Total', '7', '12', 'Total', '100'],
    ]);
    expect(tr.detailRows('Mosswart')[0]).toEqual(['', 'Mel/Msl', 'Magic', 'Attacks', '2 (100%)']);
    expect(tr.monsterRows('Mosswart', true).map((r) => r[0] + r[1])).toEqual(['', 'All', 'Drudge Skulker', '*Mosswart']);
    // 100 out over the 14 s since the first hit: the window is capped there (spec §12 #6 fixed).
    expect(tr.dps('out', 60_000)).toBeCloseTo(100 / 13, 5);
    expect(tr.dps('in', 5_000)).toBe(0);
    const copy = new MtCombatTracker(() => ME);
    copy.restore(tr.snapshot());
    expect(copy.detailRows()).toEqual(tr.detailRows());
  });

  it('shortens big numbers to the column width as upstream', () => {
    expect(mtShortNumber(277_265_000, 99_999_999)).toBe('277,265k');
    expect(mtShortNumber(12_345, 99_999)).toBe('12,345');
    expect(mtShortNumber(123_456_789_012, 9_999_999)).toBe('123,457M');
  });
});
