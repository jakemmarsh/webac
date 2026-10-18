/**
 * Stream segment 1 of 2026-10-17 (11:06–12:08Z, local end-of-retail ACE, build 1efb7163): the items, combat, cast, sell
 * and vitals findings from Claude Arcanist's and Claude Bulwark's reports, each driven through the real AgentApi (or the
 * real shared module) on the agent harness. Evidence: the stream reports, the session transcripts and the profiles'
 * chat logs ($TMPDIR/acjs-agent/{mage,soldier}.chat.log); progress.md 2026-10-17 "stream reports 12:07 (combat)".
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { AttributeSystem, ItemType, VitalId, VitalSystem } from '@ac/shared';
import { AgentApi, fullBoostLine, spellCastsOnYou } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult, AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

/** Run the fake clock until `p` answers (at most `ms`). */
async function settle(p: Promise<AgentResult>, ms = 60_000): Promise<AgentResult> {
  let out: AgentResult | undefined;
  void p.then((r) => { out = r; });
  for (let t = 0; t < ms && out === undefined; t += 200) await vi.advanceTimersByTimeAsync(200);
  if (!out) throw new Error('never answered');
  return out;
}

describe('stream reports 2026-10-17 12:07 (combat, cast, sell, vitals)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); AgentApi.reachHeights.clear(); });

  // ── 1. Arcanist: "mana often shows full right after casting" ──
  describe('1. the mana bar: the server current, clamped to the max the client works out, as retail does', () => {
    it('setCurrent clamps a server value above the max and says by how much (CACQualities::SetAttribute2nd @ 00592530)', () => {
      const attrs = new AttributeSystem({ strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 100 });
      const v = new VitalSystem();
      const max = v.getMax(VitalId.Mana, attrs);
      expect(v.setCurrent(VitalId.Mana, max + 13, attrs)).toBe(13);
      expect(v.getCurrent(VitalId.Mana)).toBe(max);
      expect(v.setCurrent(VitalId.Mana, max - 4, attrs)).toBe(0);
      expect(v.getCurrent(VitalId.Mana)).toBe(max - 4);
    });

    it('a repeat\'s summary says what the bar showed when it began, so "290/290" after the casts reads as a net', async () => {
      const BEARER = 0x80008589;
      host.spells = () => [{ id: 84, name: 'Flame Bolt V', school: 'War', level: 5, projectile: true, range: 60 }];
      (host as unknown as { lineOfFire: () => unknown }).lineOfFire = () => ({ dist: 5, blockedAt: null });
      host.add({ guid: BEARER, name: 'Tumerok Standard Bearer', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
      host.me.mana = { current: 290, max: 290 };
      let n = 0;
      host.cast = (id, t) => {
        host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
        const k = ++n;
        setTimeout(() => {
          // Two points spent and two back by the next read: the bar shows full again.
          if (k < 2) { api.pushChat('You incinerate Tumerok Standard Bearer for 89 points with Flame Bolt V.', 0x16); return; }
          host.dying.add(BEARER);
          api.pushChat('Tumerok Standard Bearer is reduced to cinders!', 0x16);
        }, 600);
        return true;
      };
      const r = await settle(api.cast('Flame Bolt V', BEARER, { repeat: true }));
      expect(r.message).toContain('you: health 50/50, stamina 80/80, mana 290/290 (290 when this began: no net drop on the bar)');
      host.add({ guid: BEARER + 1, name: 'Tumerok Standard Bearer', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
      n = 0;
      host.cast = (id, t) => {
        host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
        setTimeout(() => { host.me.mana.current -= 6; host.dying.add(BEARER + 1); api.pushChat('Tumerok Standard Bearer is reduced to cinders!', 0x16); }, 600);
        return true;
      };
      const r2 = await settle(api.cast('Flame Bolt V', BEARER + 1, { repeat: true }));
      expect(r2.message).toContain('mana 284/290 (290 when this began: 6 down, net of regeneration)');
    });
  });

  // ── 2. Arcanist: Magic Resistance Other with target=self was refused although the hint offered that form ──
  describe('2. an Other spell the game won\'t cast on you is never offered or sent at you', () => {
    const MRO: AgentSpell = { id: 269, name: 'Magic Resistance Other II', school: 'Creature Enchantment', level: 2, buff: true, targetType: 0x10 };
    const BDO: AgentSpell = { id: 1612, name: 'Blood Drinker Other V', school: 'Item Enchantment', level: 5, buff: true, targetType: 0x101 };
    const IMPEN: AgentSpell = { id: 1483, name: 'Impenetrability V', school: 'Item Enchantment', level: 5, buff: true, targetType: 0x6 };

    it('spellCastsOnYou follows the client\'s 0x8107 rule (ObjectCompatibleWithSpellTargetType @ 00567230)', () => {
      expect(spellCastsOnYou(MRO)).toBe(false); // Creature 0x10 only
      expect(spellCastsOnYou({ ...MRO, self: true })).toBe(true); // Magic Resistance Self II
      expect(spellCastsOnYou(BDO)).toBe(true); // a weapon spell: lands on your weapon
      expect(spellCastsOnYou(IMPEN)).toBe(true);
      expect(spellCastsOnYou({})).toBe(true); // no target type: the client decides
    });

    it('"you don\'t know Magic Resistance Self" no longer suggests target=self for the Other spell', async () => {
      host.spells = () => [MRO];
      const r = await api.cast('Magic Resistance Self', null);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("you don't know Magic Resistance Self; you know Magic Resistance Other II (it goes on someone else only: the game won't let you cast Magic Resistance Other II on yourself; cast it on a fellow with target=<their name>)");
      expect(r.message).not.toContain('target=self casts it on you');
    });

    it('a weapon Other spell still says target=self casts it on you', async () => {
      host.spells = () => [BDO];
      const r = await api.cast('Blood Drinker Self V', null);
      expect(r.message).toContain('(target=self casts it on you)');
    });

    it('target=self on a creature-only Other spell is refused before it goes out, naming the Self spell you do know', async () => {
      host.spells = () => [MRO, { id: 1, name: 'Magic Resistance Self I', school: 'Creature Enchantment', level: 1, self: true, buff: true, targetType: 0x10 }];
      const r = await api.cast('Magic Resistance Other II', 'self');
      expect(r.ok).toBe(false);
      expect(r.message).toBe('Magic Resistance Other II can\'t be cast on yourself: it goes on someone else only (the game answers "You cannot cast this spell upon yourself"). Cast it on a fellow (target=<their name>); you know Magic Resistance Self I, which goes on you');
      expect(host.sent.filter((s) => s.startsWith('cast'))).toEqual([]);
      // Your own name or guid is "yourself" too.
      expect((await api.cast('Magic Resistance Other II', host.me.name)).message).toMatch(/can't be cast on yourself/);
      expect((await api.cast('Magic Resistance Other II', host.me.guid)).message).toMatch(/can't be cast on yourself/);
    });
  });

  // ── 3. Arcanist: a repeat said "no hit seen" and then "died" on a bolt that seemed to land ──
  describe('3. a repeat whose target a fellow killed says so, and a close miss says why on its own line', () => {
    it('no damage line for the bolt (the chat log had none), then a kill with no line of yours: credited to the fellow beside it', async () => {
      const BEARER = 0x80008589, BULWARK = 0x500000a4;
      host.spells = () => [{ id: 84, name: 'Flame Bolt V', school: 'War', level: 5, projectile: true, range: 60 }];
      (host as unknown as { lineOfFire: () => unknown }).lineOfFire = () => ({ dist: 2.3, blockedAt: null });
      host.add({ guid: BEARER, name: 'Tumerok Standard Bearer', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22.3 });
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80.8, y: 23, seeks: { guid: BEARER, kind: 'stick' }, combatStance: true });
      host.fellows = () => [{ guid: BULWARK, name: 'Claude Bulwark', health: { cur: 190, max: 190 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
      let n = 0;
      host.cast = (id, t) => {
        host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
        const k = ++n;
        // 11:20:30 and 11:20:38: "Casting Flame Bolt V" and the words, no damage line; Bulwark's crush kills it at 39.6.
        api.pushChat('Casting Flame Bolt V', 0x1a);
        if (k === 2) setTimeout(() => host.dying.add(BEARER), 1200);
        return true;
      };
      const r = await settle(api.cast('Flame Bolt V', BEARER, { repeat: true }));
      const lines = r.message.split('\n');
      expect(lines[0]).toBe('cast Flame Bolt V at Tumerok Standard Bearer 2 times (repeat); stopped: Tumerok Standard Bearer died (killed by Claude Bulwark, most likely: they were attacking it)');
      // The close miss carries its own explanation, not only after a second one.
      expect(lines[1]).toMatch(/^ {2}1: no hit seen: no damage line \(Tumerok Standard Bearer 2\.3 m away\): it is close enough to claw you/);
    });

    it('your own kill line keeps the death yours', async () => {
      const SKULKER = 0x80000080;
      host.spells = () => [{ id: 84, name: 'Flame Bolt V', school: 'War', level: 5, projectile: true, range: 60 }];
      (host as unknown as { lineOfFire: () => unknown }).lineOfFire = () => ({ dist: 8, blockedAt: null });
      host.add({ guid: SKULKER, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 28 });
      host.cast = (id, t) => {
        host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
        setTimeout(() => { host.dying.add(SKULKER); api.pushChat('Drudge Skulker is reduced to cinders!', 0x16); }, 600);
        return true;
      };
      const r = await settle(api.cast('Flame Bolt V', SKULKER, { repeat: true }));
      expect(r.message.split('\n')[0]).toBe('cast Flame Bolt V at Drudge Skulker 1 time (repeat); stopped: Drudge Skulker died');
    });
  });

  // ── 5. Bulwark: every sale to Boddry ended with "Gold Chainmail Girth, AL 179, Craft 5" ──
  describe('5. a plugin\'s prints are no action\'s reply', () => {
    it('Mag-Tools\' item info printed during a sale stays in chat but out of the sell answer', async () => {
      host.vendorOpen = { name: 'Boddry the Chancy', guid: 0x7a9b2013, currency: 'Pyreals', items: [] };
      host.inv.push({ guid: 0x8000479b, name: 'Ring', where: 'main pack' });
      host.vendorSell = (g) => {
        host.sent.push(`sell ${g.toString(16)}`);
        setTimeout(() => {
          // The sold ring's own examine line (the open examine window follows the selection), then the vendor's tell,
          // then the shop's re-sent list selects the girth sold earlier and Mag-Tools prints it too.
          api.pushChat('Silver Ring, Diff 184, Craft 5', 0x0e, 'MagTools');
          host.inv = host.inv.filter((i) => i.guid !== g);
          api.pushChat('Boddry the Chancy tells you, "Sure, we could stock up on those."', 0x03);
          api.pushChat('Gold Chainmail Girth, AL 179, Craft 5', 0x0e, 'MagTools');
        }, 300);
        return true;
      };
      const r = await settle(api.sell(0x8000479b));
      expect(r.message).toBe('sold Ring\nBoddry the Chancy tells you, "Sure, we could stock up on those."');
      // The lines are still the player's chat (observe shows them), tagged with their plugin.
      const said = api.eventsSince(0).filter((e) => e.type === 'chat');
      expect(said.filter((e) => e.plugin === 'MagTools').map((e) => e.text)).toEqual(['(other) Silver Ring, Diff 184, Craft 5', '(other) Gold Chainmail Girth, AL 179, Craft 5']);
      expect(api.replyLines(0)).toEqual(['Boddry the Chancy tells you, "Sure, we could stock up on those."']);
    });

    it('a plugin line feeds none of the readers of game events (a corpse line from Mag-Tools is not your corpse)', () => {
      api.pushChat('Your corpse is located at 42.1N, 33.6E.', 0x05, 'MagTools');
      api.pushChat('Your corpse is located at 42.1N, 33.6E.', 0x05);
      expect(api.replyLines(0)).toEqual(['Your corpse is located at 42.1N, 33.6E.']);
    });
  });

  // ── 6. Bulwark: a potion mid-swing broke the attack off and left it off ──
  describe('6. a potion used mid-attack: the attack starts again once the drink is done', () => {
    const COMMANDER = 0x80009734;
    let swinging: boolean;
    let busyUntil: number;
    beforeEach(() => {
      host.me.combatMode = 'melee';
      host.add({ guid: COMMANDER, name: 'Tumerok Commander', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21 });
      host.inv.push({ guid: 0x8000c8e4, name: 'Potion of Healing', where: 'main pack', stack: 3 });
      swinging = false;
      busyUntil = 0;
      host.attacking = () => swinging;
      host.cancelAttack = () => { host.sent.push('cancel'); swinging = false; };
      host.busy = () => host.now() < busyUntil;
      host.use = (g) => {
        host.sent.push(`use ${g.toString(16)}`);
        // ACE: the drink holds you busy ~2 s (and ends the repeat attack on its own); the heal line comes first.
        busyUntil = host.now() + 2200;
        setTimeout(() => { api.pushChat('You drink the Potion of Healing and restore 41 points of health.', 0x05); host.inv = host.inv.map((i) => (i.guid === g ? { ...i, stack: 2 } : i)); }, 400);
        return true;
      };
    });

    it('says why it broke off (retail refuses a use mid-swing) and sends a fresh attack request after the drink', async () => {
      api.attack(COMMANDER);
      run(api, host, 200);
      expect(host.sent).toContain('attack 80009734 0.6 medium');
      swinging = true;
      host.pending = false;
      const r = await settle(api.use('Potion of Healing'));
      expect(r.message).toContain('(broke off your attack on Tumerok Commander first: the client takes no use or item move while a swing is in progress, as retail\'s ("You cannot move or use an item while attacking"); your attack on Tumerok Commander starts again once the use is done');
      const before = host.sent.filter((s) => s.startsWith('attack 80009734')).length;
      await vi.advanceTimersByTimeAsync(3000);
      run(api, host, 300);
      expect(host.sent.filter((s) => s.startsWith('attack 80009734')).length).toBe(before + 1);
    });

    it('an order given after the use (a walk away) keeps the attack off', async () => {
      api.attack(COMMANDER);
      run(api, host, 200);
      swinging = true;
      host.pending = false;
      await settle(api.use('Potion of Healing'));
      const before = host.sent.filter((s) => s.startsWith('attack 80009734')).length;
      void api.walkTo('10m south');
      await vi.advanceTimersByTimeAsync(3000);
      expect(host.sent.filter((s) => s.startsWith('attack 80009734')).length).toBe(before);
    });
  });

  // ── 7. Bulwark: "swings … report nothing: attacking high instead", then "Action cancelled!" ──
  describe('7. no height switch before the server has swung at all', () => {
    it('an attack the server is still running you up to (no AttackDone yet) keeps its height past QUIET_SWING_MS', () => {
      host.me.combatMode = 'melee';
      host.add({ guid: 0x80008dda, name: 'Tumerok Commander', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23.5 });
      api.attack(0x80008dda);
      run(api, host, 100);
      // 11:54:01.8 → 07.3: no AttackDone at all, only its blows on you.
      for (let t = 0; t < AgentApi.QUIET_SWING_MS + 1500; t += 500) { run(api, host, 500); if (t % 2000 === 0) api.pushChat('You evaded Tumerok Commander!', 0x15); }
      expect(host.sent.filter((s) => s.startsWith('height') || s === 'cancel')).toEqual([]);
      expect(api.eventsSince(0).some((e) => /attacking (low|high) instead/.test(e.text))).toBe(false);
    });

    it('finished swings that name it in no line still switch height, and the line says what "Action cancelled!" is', () => {
      host.me.combatMode = 'melee';
      host.add({ guid: 0x80008dda, name: 'Tumerok Commander', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23.5 });
      api.attack(0x80008dda);
      run(api, host, 100);
      for (let t = 0; t < AgentApi.QUIET_SWING_MS + 1500; t += 500) { if (t % 1500 === 0) api.pushAttackDone(0); run(api, host, 500); }
      expect(host.sent).toContain('cancel');
      const line = api.eventsSince(0).find((e) => /attacking low instead/.test(e.text));
      expect(line?.text).toContain('(an "Action cancelled!" after this is the server answering the stop of the old swing)');
    });
  });

  // ── 9. "Heal Other V restores 0" on a target at full health ──
  describe('9. a heal on a full target says it was full, and that the mana went', () => {
    it('fullBoostLine reads ACE\'s caster messages (WorldObject_Magic: the boost clamped at the max)', () => {
      expect(fullBoostLine('With Heal Other V you restore 0 points of health to Claude Bulwark.')).toEqual({ spell: 'Heal Other V', vital: 'health', who: 'Claude Bulwark' });
      expect(fullBoostLine('You cast Heal Self V and restore 0 points of your health.')).toEqual({ spell: 'Heal Self V', vital: 'health', who: null });
      expect(fullBoostLine('With Heal Other V you restore 59 points of health to Claude Bulwark.')).toBeNull();
    });

    it('the cast answer says so, and answers at the line instead of waiting out 8 s', async () => {
      const BULWARK = 0x500000a4;
      host.spells = () => [{ id: 1165, name: 'Heal Other V', school: 'Life', level: 5, targetType: 0x10 }];
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 21 });
      host.cast = (id, t) => {
        host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
        setTimeout(() => { api.pushChat('Casting Heal Other V', 0x1a); api.pushChat('You say, "Malar Zhapaj"', 0x11); }, 100);
        setTimeout(() => api.pushChat('With Heal Other V you restore 0 points of health to Claude Bulwark.', 0x11), 1500);
        return true;
      };
      const began = host.now();
      const r = await settle(api.cast('Heal Other V', 'Claude Bulwark'));
      expect(host.now() - began).toBeLessThan(4000);
      expect(r.message).toContain('Claude Bulwark was already at full health when it landed: nothing to restore, and the cast still cost its mana (the server spends it before Heal Other V lands)');
    });
  });
});

/**
 * 4. "no line of fire" at a Tumerok 2 m off in the next room (Arcanist, Shreth camp 0x5779, 11:41:01Z: "a wall 0.5 m
 * from you, between you and where the bolt starts"). She stood at about (16866.8, 23106.3) global, the end of her walk to
 * Bulwark. In the camp's own cell geometry (cell.dat, the same EnvCell BSPs ACE collides with) there is no room at all
 * 2–3 m north-east of that spot at any height: it is rock, so a wall really is there; our line is ACE's
 * (tests/verify-bolt-line-of-fire-cave-corner.ts: 99.96% agreement with ACE's own physics, every refusal under 0.8 m one
 * ACE makes too). Nothing to fix: the refusal was right.
 */
describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(DAT_PATHS.cell))('4. Shreth camp 0x5779: the wall north-east of Arcanist is in the cell geometry', () => {
  let floorAt: (x: number, y: number, fromZ: number) => number | null;
  let som: ServerObjectManager;
  const ME = { x: 16866.8, y: 23106.3 };
  let meZ = 0;
  beforeAll(async () => {
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel.js');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const portal = openDat(DAT_PATHS.portal), cell = openDat(DAT_PATHS.cell);
    const mf = new MaterialFactory(portal, new TextureManager(portal));
    const mr = new ModelRenderer(portal, mf);
    const env = new EnvCellRenderer(portal, cell, mf, new SetupModelRenderer(portal, mr), mr);
    const dc = new DungeonCollision();
    for (let c = 0x100; c < 0x1000; c++) {
      const id = ((0x5779 << 16) | c) >>> 0;
      if (!cell.getFileData(id)) continue;
      const coll = env.getCellCollisionData(id);
      if (coll) dc.addCell(id, coll.cellStruct, coll.position);
    }
    floorAt = (x, y, fromZ) => dc.getFloorHeight(x, y, fromZ, 30);
    meZ = floorAt(ME.x, ME.y, 5) ?? 0;
    const human = new SetupModel(new DatReader(portal.getFileData(0x02000001)!));
    som = new ServerObjectManager({ loadSetupModel: () => human } as never, {} as never, new THREE.Scene());
    som.missileEnvironmentSweep = (from, to, r) => {
      const h = dc.sweepSphere({ x: from.x, y: from.z, z: from.y }, { x: to.x, y: to.z, z: to.y }, r);
      return h ? { t: h.t, normal: { x: h.normal.x, y: h.normal.z, z: h.normal.y } } : null;
    };
    som.missileObjectSweep = () => null;
    som.missileLocalPlayer = () => ({ x: ME.x, y: ME.y, z: meZ, radius: human.radius, height: human.height, physicsRadius: human.spheres[0].radius });
    (som as unknown as { objects: Map<number, ServerObject> }).objects.set(0x80008846, {
      guid: 0x80008846, name: 'Tumerok Commander', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(), setupId: 0x02000001,
      worldX: ME.x, worldZ: ME.y - 2, worldY: meZ, collisionRadius: human.radius, collisionHeight: human.height,
    } as unknown as ServerObject);
  }, 120_000);

  it('she stands on a floor of the hall', () => {
    expect(meZ).toBeGreaterThan(-1);
    expect(meZ).toBeLessThan(2);
  });

  it('2–3 m north to north-east of her there is no room at any height: rock', () => {
    for (const d of [2, 3]) for (const a of [0, 22.5, 45, 67.5]) {
      const x = ME.x + d * Math.sin((a * Math.PI) / 180), y = ME.y + d * Math.cos((a * Math.PI) / 180);
      for (const up of [1.5, 6, 12]) expect(floorAt(x, y, meZ + up)).toBeNull();
    }
  });

  it('the open side (2 m south, in the hall) has an open line', () => {
    expect(som.lineOfFire(0x80008846)?.blockedAt).toBeNull();
  });
});
