/**
 * What an agent player is told about a fight, so it can judge it the way a
 * player looking at the screen would (2026-10-11, the Opus/Haiku pair):
 *  - which monster is attacking you (CombatEnemy lines, by name), marked on
 *    it and named when it isn't your target, also in attack's reply;
 *  - whether a bolt has a line of fire to the target: the client's own
 *    missile sweep (ServerObjectManager.lineOfFire) from your body to it.
 *    The server says nothing when a bolt hits a wall, so cast refuses a
 *    projectile spell with no line of fire and says why.
 * And what a player sees on their inventory and purse: where each pack item
 * could be worn, its value, the foci in the side pack slots, and that half
 * your pyreals (not trade notes) drop when you die.
 * docs/agent-play.md.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { ItemType, PhysicsState } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatInventory, formatObservation } from '../packages/renderer/src/agent/format.ts';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { SpellTable, SpellType, isProjectileSpellType } from '../packages/dat-parser/src/file-types/SpellTable.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

describe('who is attacking you', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.add({ guid: 0x80000080, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22 });
    host.add({ guid: 0x80000081, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40 });
    host.add({ guid: 0x80000082, name: 'Mosswart', itemType: 0x10, objectDescFlags: 0x10, x: 90, y: 20 });
  });
  afterEach(() => vi.useRealTimers());

  it('marks the monster whose attacks the last 10 s of combat lines name, and says when it is not your target', () => {
    api.pushChat('The Drudge Skulker hits your chest for 6 points of bludgeoning damage!', 0x15);
    api.pushChat('You evaded the Drudge Skulker!', 0x15);
    api.pushChat('You hit the Mosswart for 5 points of slashing damage!', 0x16); // your own swing
    host.target = 0x80000082;
    const obs = api.observe();
    // The nearer of the two Skulkers (2 m, not 20 m) gets both lines; the Mosswart none.
    expect(obs.nearby.find((o) => o.guid === 0x80000080)?.attackingYou).toBe(2);
    expect(obs.nearby.find((o) => o.guid === 0x80000081)?.attackingYou).toBeUndefined();
    expect(obs.target?.attackingYou).toBeUndefined();
    const text = formatObservation(obs);
    expect(text).toContain('ATTACKING YOU (2× in 10 s)');
    expect(text).toMatch(/under attack by: Drudge Skulker #80000080 2\.0m \(2× in 10 s\) \(not your target\)/);
    // Ten seconds on, the lines have aged out.
    run(api, host, 10_500, { physics: false });
    expect(formatObservation(api.observe())).not.toContain('ATTACKING YOU');
  });

  it('no "under attack by" line when the attacker is your target', () => {
    // Beside you: a swing comes from melee reach (a line is pinned only on a creature of its name within it).
    host.objs.get(0x80000082)!.x = 83;
    api.pushChat('The Mosswart hits your leg for 3 points of slashing damage!', 0x15);
    host.target = 0x80000082;
    const obs = api.observe();
    expect(obs.target?.attackingYou).toBe(1);
    expect(formatObservation(obs)).not.toContain('under attack by');
  });

  it("attack's reply names another monster that is attacking you", () => {
    api.pushChat('The Drudge Skulker hits your chest for 6 points of bludgeoning damage!', 0x15);
    const r = api.attack('Mosswart');
    expect(r.message).toContain('note: Drudge Skulker #80000080 (1 attack on you in 10 s) is attacking you, and isn\'t this target');
    expect(api.attack(0x80000080).message).not.toContain('note:');
  });
});

describe('cast checks the line of fire for a projectile spell', () => {
  let host: FakeHost;
  let api: AgentApi;
  let blocked: number | null;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    blocked = 4.2;
    host.spells = () => [
      { id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true },
      { id: 1, name: 'Weakness Other I', school: 'Creature', level: 1 },
    ];
    (host as unknown as { lineOfFire: (g: number) => { dist: number; blockedAt: number | null } }).lineOfFire = () => ({ dist: 12, blockedAt: blocked });
    host.add({ guid: 0x80000080, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 32 });
  });
  afterEach(() => vi.useRealTimers());

  it('refuses a bolt that would hit a wall, and says where to go', async () => {
    const r = await api.cast('Flame Bolt I', 'Drudge Skulker');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not cast: no line of fire to Drudge Skulker \(12\.0 m away\).*4\.2 m along the line/);
    expect(host.sent.some((s) => s.startsWith('cast 27'))).toBe(false);
  });

  it('casts when the line is open, and casts a non-missile spell regardless', async () => {
    const weak = api.cast('Weakness Other I', 'Drudge Skulker');
    await vi.advanceTimersByTimeAsync(3500);
    await weak;
    expect(host.sent).toContain('cast 1 80000080');
    blocked = null;
    const bolt = api.cast('Flame Bolt I', 'Drudge Skulker');
    await vi.advanceTimersByTimeAsync(3500);
    await bolt;
    expect(host.sent).toContain('cast 27 80000080');
  });

  it('the observation flags the target with no line of fire', () => {
    host.target = 0x80000080;
    const text = formatObservation(api.observe());
    expect(text).toMatch(/target: .*Drudge Skulker.*no line of fire: blocked 4\.2 m along it/);
    blocked = null;
    expect(formatObservation(api.observe())).not.toContain('no line of fire');
  });
});

describe('ServerObjectManager.lineOfFire: the missile sweep from your body to the target', () => {
  const makeSOM = (): ServerObjectManager => {
    const som = new ServerObjectManager({ loadSetupModel: () => null } as never, {} as never, new THREE.Scene());
    som.missileLocalPlayer = () => ({ x: 100, y: 100, z: 10, radius: 0.5, height: 1.8 });
    return som;
  };
  const put = (som: ServerObjectManager, guid: number, x: number, y: number, z: number, over: Partial<ServerObject> = {}): void => {
    const o = {
      guid, name: 'Drudge', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(),
      // ServerObject is in THREE axes: worldX = AC x, worldZ = AC y, worldY = height.
      worldX: x, worldZ: y, worldY: z, collisionRadius: 0.5, collisionHeight: 1.6, ...over,
    } as unknown as ServerObject;
    (som as unknown as { objects: Map<number, ServerObject> }).objects.set(guid, o);
  };
  // A wall across the line at AC y = 105.
  const wallAt = (wallY: number) => (from: { y: number }, to: { y: number }) =>
    to.y < wallY ? null : { t: (wallY - from.y) / (to.y - from.y), normal: { x: 0, y: -1, z: 0 } };

  it('reaches the target in the open, and stops at a wall in between', () => {
    const som = makeSOM();
    put(som, 0x80000080, 100, 112, 10);
    som.missileEnvironmentSweep = () => null;
    expect(som.lineOfFire(0x80000080)).toEqual({ dist: 12, blockedAt: null });
    som.missileEnvironmentSweep = wallAt(105);
    const r = som.lineOfFire(0x80000080)!;
    expect(r.blockedAt).toBeGreaterThan(4.9);
    expect(r.blockedAt).toBeLessThan(5.2);
  });

  it('a wall behind the target is not in the way, and creatures never block', () => {
    const som = makeSOM();
    put(som, 0x80000080, 100, 112, 10);
    put(som, 0x80000081, 100, 106, 10); // a fellow or another monster between: they move
    som.missileEnvironmentSweep = wallAt(115);
    som.missileObjectSweep = () => { throw new Error('creatures are not swept'); };
    expect(som.lineOfFire(0x80000080)?.blockedAt).toBeNull();
  });

  it('a closed door blocks; an open (ethereal) one does not', () => {
    const som = makeSOM();
    put(som, 0x80000080, 100, 112, 10);
    put(som, 0x70000001, 100, 106, 10, { itemType: ItemType.Misc, physicsState: 0 });
    som.missileEnvironmentSweep = () => null;
    som.missileObjectSweep = (o, from, to) => (o.guid === 0x70000001 ? { t: (106 - from.y) / (to.y - from.y), normal: null } : null);
    expect(som.lineOfFire(0x80000080)?.blockedAt).toBeCloseTo(6, 0);
    (som.getObject(0x70000001) as ServerObject).physicsState = PhysicsState.Ethereal;
    expect(som.lineOfFire(0x80000080)?.blockedAt).toBeNull();
  });

  it('unknown target or body: null', () => {
    const som = makeSOM();
    som.missileEnvironmentSweep = () => null;
    expect(som.lineOfFire(0x80000099)).toBeNull();
  });

  // The automation's Summon Pets asks for 3 m of room ahead before a summon (VTank's room check).
  it('roomAhead: a wall within the distance along the compass heading takes the room; behind you or past it does not', () => {
    const som = makeSOM();
    som.missileEnvironmentSweep = wallAt(102); // a wall 2 m north of you
    expect(som.roomAhead(0, 3)).toBe(false);
    expect(som.roomAhead(180, 3)).toBe(true); // facing south: the wall is behind
    som.missileEnvironmentSweep = wallAt(110);
    expect(som.roomAhead(0, 3)).toBe(true);
    // A closed door ahead blocks; a creature never does.
    som.missileEnvironmentSweep = () => null;
    put(som, 0x70000001, 100, 101.5, 10, { itemType: ItemType.Misc, physicsState: 0 });
    put(som, 0x80000081, 100, 101.5, 10);
    som.missileObjectSweep = (o, from, to) => {
      if (o.guid !== 0x70000001) throw new Error('creatures are not swept');
      return { t: (101.5 - from.y) / (to.y - from.y), normal: null };
    };
    expect(som.roomAhead(0, 3)).toBe(false);
    som.missileLocalPlayer = () => null;
    expect(som.roomAhead(0, 3)).toBeNull();
  });
});

describe('isProjectileSpellType: which spells fly as missiles (the spell table MetaSpellType)', () => {
  it('Projectile, LifeProjectile and EnchantmentProjectile only', () => {
    expect([SpellType.Projectile, SpellType.LifeProjectile, SpellType.EnchantmentProjectile].every(isProjectileSpellType)).toBe(true);
    expect([SpellType.Enchantment, SpellType.Boost, SpellType.Transfer, SpellType.Dispel, SpellType.Undef].some(isProjectileSpellType)).toBe(false);
  });

  describe.skipIf(!existsSync(DAT_PATHS.portal))('in the end-of-retail spell table', () => {
    let byName: Map<string, number>;
    beforeAll(() => {
      const st = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!));
      byName = new Map([...st.spells.values()].map((s) => [s.name, s.metaSpellType]));
    });
    it('bolts are, buffs and heals are not', () => {
      expect(isProjectileSpellType(byName.get('Flame Bolt I')!)).toBe(true);
      expect(isProjectileSpellType(byName.get('Shock Wave I')!)).toBe(true);
      expect(isProjectileSpellType(byName.get('Heal Self I')!)).toBe(false);
      expect(isProjectileSpellType(byName.get('Strength Self I')!)).toBe(false);
      expect(isProjectileSpellType(byName.get('Weakness Other I')!)).toBe(false);
    });
  });
});

describe('inventory and purse facts', () => {
  it('lists what a pack item fits and is worth, and the foci in the pack slots', () => {
    const text = formatInventory([
      { guid: 0x80003328, name: 'Academy Coat', where: 'equipped', slot: 'ChestArmor+AbdomenArmor' },
      { guid: 0x80000d74, name: 'Leather Cuirass', where: 'main pack', type: 'Armor', fits: 'ChestArmor+AbdomenArmor', value: 120 },
      // A stack's Value is already the whole stack's (ACE: StackUnitValue × StackSize): shown as it is, never × the stack again.
      { guid: 0x80001c79, name: 'Lead Pea', where: 'main pack', stack: 3, value: 30 },
      { guid: 0x80003574, name: 'Foci of Strife', where: 'pack slots', wcid: 15271, type: 'Misc' },
      { guid: 0x80009999, name: 'Foci of Verdancy', where: 'Sack', wcid: 15270 },
    ]);
    expect(text).toContain('#80000d74 Leather Cuirass  (Armor, fits ChestArmor+AbdomenArmor, value 120)');
    expect(text).toContain('Lead Pea  (x3, value 30)');
    expect(text).toContain('#80003328 Academy Coat  (ChestArmor+AbdomenArmor)'); // worn: no "fits"
    expect(text).toMatch(/pack slots:\n  #80003574 Foci of Strife  \(Misc, War Magic focus: in use\)/);
    expect(text).toContain('Life Magic focus: NOT in use inside Sack');
  });

  it('warns that half your pyreals drop on death above level 5 (trade notes do not)', () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.me.level = 12; host.me.pyreals = 4_500;
    expect(formatObservation(api.observe())).toMatch(/money: 4,500 in coins, no trade notes \(half your coins are lost if you die; trade notes, bought from most vendors, are kept on death\)/);
    host.me.pyreals = 400;
    expect(formatObservation(api.observe())).not.toContain('half drop');
    host.me.level = 5; host.me.pyreals = 4_500;
    expect(formatObservation(api.observe())).not.toContain('half drop');
    vi.useRealTimers();
  });
});

describe('what a use did: every result a player would see', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => vi.useRealTimers());

  it('a healing kit used on yourself reports the reply, the health gained and the kit used up', async () => {
    host.inv = [{ guid: 0x80002de8, name: 'Adept Healing Kit', where: 'main pack', stack: 3 }];
    host.me.health = { current: 30, max: 50 };
    host.useWithTarget = () => {
      setTimeout(() => {
        api.pushChat('You heal yourself for 14 Hit Points with Adept Healing Kit.', 0x05);
        host.me.health = { current: 44, max: 50 };
        host.inv = [{ guid: 0x80002de8, name: 'Adept Healing Kit', where: 'main pack', stack: 2 }];
      }, 1500);
      return true;
    };
    const r = api.useOnReported('Adept Healing Kit', 'self');
    await vi.advanceTimersByTimeAsync(4000);
    const { ok, message } = await r;
    expect(ok).toBe(true);
    expect(message).toBe([
      'used Adept Healing Kit on yourself:',
      '  You heal yourself for 14 Hit Points with Adept Healing Kit.',
      '  health 30 → 44',
      '  Adept Healing Kit: 3 → 2',
    ].join('\n'));
  });

  it('a refusal the server sends with no text still comes back, by its name', async () => {
    host.inv = [{ guid: 0x80000101, name: 'Mana Stone', where: 'main pack' }];
    host.add({ guid: 0x80000102, name: 'Training Wand', itemType: 0x100, x: 80, y: 21 });
    host.useWithTarget = () => { setTimeout(() => api.pushUseDone(0x0045, 'ItemNotUsable', null), 400); return true; };
    const r = api.useOnReported('Mana Stone', 'Training Wand');
    await vi.advanceTimersByTimeAsync(3000);
    const res = await r;
    expect(res.ok).toBe(false);
    expect(res.message).toContain('the server refused it: ItemNotUsable (no message shown)');
  });

  it('a centre-screen notice counts as a reply; a learned spell and a new buff are reported', async () => {
    host.inv = [{ guid: 0x80000201, name: 'Scroll of Strength Self I', where: 'main pack' }];
    host.add({ guid: 0x80000201, name: 'Scroll of Strength Self I', cell: null, x: 0, y: 0 });
    host.use = () => {
      setTimeout(() => {
        api.pushChat('The scroll is destroyed.', 0x00);
        host.inv = [];
        host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1 }, { id: 6, name: 'Heal Self I', school: 'Life', level: 1 }, { id: 2, name: 'Strength Self I', school: 'Creature', level: 1 }];
      }, 2000);
      return true;
    };
    const r = api.use(0x80000201);
    await vi.advanceTimersByTimeAsync(5000);
    const msg = (await r).message;
    expect(msg).toContain('The scroll is destroyed.');
    expect(msg).toContain('gone from your pack: Scroll of Strength Self I');
    expect(msg).toContain('learned: Strength Self I');
  });

  it('a scroll you cannot learn yet says by how much (power − 50, ACE CanReadScroll)', async () => {
    host.inv = [{ guid: 0x80000301, name: 'Scroll of Drain Health Other IV', where: 'main pack' }];
    host.add({ guid: 0x80000301, name: 'Scroll of Drain Health Other IV', cell: null, x: 0, y: 0 });
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: new Map([[1244, { name: 'Drain Health Other IV', desc: '', category: 0, school: 2, bitfield: 0, power: 150 }]]) });
    (host as unknown as { skillList: () => unknown }).skillList = () => [{ id: 33, name: 'Life Magic', training: 'trained', base: 70, buffed: 82 }];
    host.use = () => { setTimeout(() => api.pushChat('You are not skilled enough in Life Magic to learn this spell.', 0x00), 2500); return true; };
    const r = api.use(0x80000301);
    await vi.advanceTimersByTimeAsync(6000);
    expect((await r).message).toContain('(Scroll of Drain Health Other IV: needs Life Magic 100 or more to learn; yours is 82)');
  });
});

describe('a door used opens or closes in the report (a player watches it slide)', () => {
  it('reports "is now open" for a door whose use sets it ethereal', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    const door = host.add({ guid: 0x7a9b4044, name: 'Pedestal Weak Spot', itemType: 0x80, objectDescFlags: 0x1000, physicsState: 0, x: 80, y: 21.5 });
    host.use = () => { setTimeout(() => { door.physicsState = 0x4; }, 1200); return true; };
    const r = api.use(0x7a9b4044);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await r).message).toBe('used Pedestal Weak Spot:\n  Pedestal Weak Spot is now open');
    vi.useRealTimers();
  });
});

describe('regeneration during a use is not its result', () => {
  it('a 1-point vital change is left out; a heal is reported', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.add({ guid: 0x8000daa0, name: 'Corpse of Gnawer Shreth', itemType: 0x200, x: 80, y: 21.5 });
    host.me.mana = { current: 53, max: 161 };
    host.use = () => { setTimeout(() => { host.me.mana = { current: 54, max: 161 }; api.pushChat('You search the corpse.', 0x00); }, 800); return true; };
    const r = api.use(0x8000daa0);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await r).message).not.toContain('mana 53 → 54');
    vi.useRealTimers();
  });
});
